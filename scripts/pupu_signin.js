/**
 * 朴朴超市微信小程序 - 社群打卡自动签到 (Surge / Loon Script)
 *
 * 接口基于 2026-11 版本实测。活动每周轮换，task_group_id 由脚本从请求中自动抓取，
 * 不绑定任何具体活动，换周无需改脚本。
 *
 * ⚠ 接口要点（2026-11 实测）：
 *   1. GET 任务接口除 Authorization 外，**必须带至少一个位置头**：
 *      pp_storeid / pp-cityzip / pp-placeid 任选其一；否则返回 400000「非法请求」
 *      （旧版只要 Authorization，这是这周脚本失效的直接原因之一）
 *   2. POST 打卡接口仍只认 Authorization（实测通过）
 *   3. sign-v2 / seal-v2 / sw8 / timestamp 依旧不校验
 *
 * 接口：
 *   GET  /client/game/task_system/user_tasks/task_groups/{task_group_id}
 *   POST /client/game/task_system/user_tasks/task/{task_group_id}/{task_id}/cumulative_clock
 *        （rule_type=20；普通打卡为 /clock）
 *   成功 = {"errcode":0,"data":{"receive_reward_type":10}}（take_in_way=10 即打即领）
 *   重复 = {"errcode":400000,"errmsg":"任务已经完成了,不能重复完成"}
 *
 * 状态判断（实测）：
 *   可打卡：task_status === 0 && !check_in_lock
 *   已完成：task_status === 30
 *   is_received 恒为 true，不可用于判断
 *
 * ⏱ 登录态（token）机制：
 *   - Authorization 是服务端签发的 ES256 JWT，exp 显示寿命约 2 小时（非 cookie、非一天）
 *   - 客户端无法续期，只有小程序运行时会重新登录换新 token
 *   - 所以：只要打开朴朴小程序（任意页面即可，不必进签到页），脚本抓到新 token 立刻打卡
 *   - cron 兜底仅在 token 仍有效时起作用，过期时只发一条提示
 *
 * 配置（两种客户端语法不同，别混用）：
 *
 *   ── Loon ──
 *   [Script]
 *   http-request ^https?:\/\/j1\.pupuapi\.com\/client\/game\/task_system\/ script-path=pupu_signin.js, requires-body=false, max-size=-1, binary-body-mode=false, tag=朴朴签到
 *   cron "0,10,20,30,40,50 * * * *" script-path=pupu_signin.js, tag=朴朴签到定时
 *   [MITM]
 *   hostname = %APPEND% j1.pupuapi.com
 *
 *   ── Surge ──
 *   [Script]
 *   pupu_signin = type=http-request, pattern=^https://j1\.pupuapi\.com/client/game/task_system/, requires-body=false, script-path=pupu_signin.js
 *   pupu_signin_cron = type=cron, cronexp="0,10,20,30,40,50 * * * *", script-path=pupu_signin.js
 *   [MITM]
 *   hostname = %APPEND% j1.pupuapi.com
 *
 * ⚠ 为什么拦截时不再直接打卡：
 *   拦截阶段同步做 GET+POST 会拖延页面请求，前端超时后走 catch 分支，
 *   弹出「活动太火爆啦～请稍后再试」。改为拦截只抓凭据即刻放行，
 *   打卡由 cron 每 10 分钟补上（token 有效期内，最迟 10 分钟完成）。
 *
 * ⚠ cron 必须全天运行（0,10,20,30,40,50 覆盖 24 小时）：
 *   拦截阶段 $done({}) 之后脚本随时可能被回收，不能依赖拦截路径做任何异步后续。
 *   打卡时效完全由 cron 粒度决定，而用户打开小程序的时刻不受限（含凌晨）。
 *   不要"优化"成只在白天运行，否则夜间打开小程序的场景会静默漏打卡。
 */

var VER = "5.6";
var API = "https://j1.pupuapi.com";
var TK = "pp_pupu_token";     // Authorization: Bearer ...
var GK = "pp_pupu_gid";       // 活动 task_group_id
var HK = "pp_pupu_ctx";       // JSON: {storeid, cityzip, placeid, suid, userid, version, ua}
var KD = "pp_done";           // 值 = 完成日期（本地日期串）——仅当服务端确认全部任务今日已完成时才写入
var KT = "pp_done_tasks";     // 值 = "日期|taskId1,taskId2"（今日已通知完成的任务，通知去重用）
var KW = "pp_warn";           // 值 = 已提醒日期（登录态类，每天一条）
var KC = "pp_cred";           // 值 = 已通知日期（抓到新凭据，每天一条）
var KF = "pp_fail";           // 值 = 已通知日期（打卡失败，每天一条）
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.79(0x18004f26) NetType/WIFI Language/zh_CN miniProgram/wx122ef876a7132eb4";

function log(m) { try { console.log("[pupu_signin v" + VER + "] " + m); } catch (e) {} }
function rd(k) { try { return $persistentStore.read(k); } catch (e) { return null; } }
function wr(k, v) { try { $persistentStore.write(String(v), k); } catch (e) {} }
function today() { var d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
function seenToday(k) { return rd(k) === today(); }
function markToday(k) { wr(k, today()); }

// 今日已完成通知去重：按任务记录。服务端任务列表可能滞后于打卡结果，
// 同一任务在「刚打完但列表还没翻状态」的窗口里会被再 POST 一次（返回"已完成"），
// 没有按任务去重就会重复弹通知
function seenTaskDone(id) {
  var v = (rd(KT) || "").split("|");
  if (v[0] !== today()) return false;
  return ("|" + (v[1] || "") + "|").indexOf("|" + id + "|") >= 0;
}
function markTaskDone(id) {
  var t = today();
  var v = (rd(KT) || "").split("|");
  var ids = (v[0] === t && v[1]) ? v[1].split(",").filter(Boolean) : [];
  if (ids.indexOf(String(id)) < 0) ids.push(String(id));
  wr(KT, t + "|" + ids.join(","));
}

// 日志只记字段存在性，不输出 token / 用户标识 / 完整上下文
function ctxBrief(ctx) {
  var ks = ["storeid", "cityzip", "placeid", "placezip", "suid", "userid", "version", "ua"];
  var out = [];
  for (var i = 0; i < ks.length; i++) out.push(ks[i] + (ctx[ks[i]] ? "=ok" : "=-"));
  return out.join(" ");
}
function notify(t, b) { try { $notification.post(t, "朴朴签到", b); } catch (e) {} }
function parse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
function once(fn) { var c = false; return function () { if (c) return; c = true; fn(); }; }

function hdr(name) {
  var h = (typeof $request !== "undefined" && $request.headers) || {};
  var low = name.toLowerCase();
  for (var k in h) { if (k.toLowerCase() === low) return h[k]; }
  return null;
}

function call(method, url, headers, body, cb) {
  var opts = { url: url, headers: headers || {} };
  if (body !== undefined && body !== null) opts.body = body;
  try { $httpClient[method.toLowerCase()](opts, function (e, r, d) { cb(e, r, d); }); }
  catch (e) { cb(e, null, null); }
}

// base64 解码（Loon 部分版本没有 atob，自带一份保证双端可用）
var B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
function b64decode(s) {
  try { if (typeof atob === "function") return atob(s); } catch (e) {}
  var out = "", i = 0, b1, b2, b3, b4;
  s = String(s).replace(/[^A-Za-z0-9+/=]/g, "");
  while (i < s.length) {
    b1 = B64C.indexOf(s.charAt(i++));
    b2 = B64C.indexOf(s.charAt(i++));
    b3 = B64C.indexOf(s.charAt(i++));
    b4 = B64C.indexOf(s.charAt(i++));
    out += String.fromCharCode((b1 << 2) | (b2 >> 4));
    if (b3 !== 64 && b3 !== -1) out += String.fromCharCode(((b2 & 15) << 4) | (b3 >> 2));
    if (b4 !== 64 && b4 !== -1) out += String.fromCharCode(((b3 & 3) << 6) | b4);
  }
  return out;
}

// 本地解析 JWT exp，比服务端错误码更可靠（400000 既可能是过期也可能是缺头）
// 返回 { valid, left }，left = 剩余分钟（-1 表示无法解析）
function tokenInfo(token) {
  if (!token) return { valid: false, left: 0 };
  try {
    var p = String(token).replace(/^Bearer\s+/i, "").split(".")[1];
    if (!p) return { valid: true, left: -1 };
    p = p.replace(/-/g, "+").replace(/_/g, "/");
    var pad = p.length % 4; if (pad) p += new Array(5 - pad).join("=");
    var obj = JSON.parse(b64decode(p));
    if (!obj.exp) return { valid: true, left: -1 };
    var left = Math.round((obj.exp * 1000 - Date.now()) / 60000);
    return { valid: left > 0, left: left };
  } catch (e) { log("jwt decode fail: " + e); return { valid: true, left: -1 }; }
}

function saveCtx() {
  var c = {
    storeid: hdr("pp_storeid") || hdr("pp-storeid"),
    cityzip: hdr("pp-cityzip") || hdr("pp_cityzip"),
    placeid: hdr("pp-placeid") || hdr("pp_placeid"),
    placezip: hdr("pp-placezip") || hdr("pp_placezip"),
    suid: hdr("pp-suid"),
    userid: hdr("pp-userid"),
    version: hdr("pp-version"),
    // 小程序真实 UA：服务端已开始按头校验（位置头即先例），跟随真实值而非硬编码
    ua: hdr("user-agent")
  };
  var old = parse(rd(HK) || "{}");
  var merged = {};
  for (var k in c) { merged[k] = c[k] || old[k] || ""; }
  // 本次请求带位置头：位置组（storeid/cityzip/placeid/placezip）整体采用本次快照，
  // 避免换城/换店后新请求只带部分头时残留旧门店字段、打到旧门店
  if (c.storeid || c.cityzip || c.placeid) {
    merged.storeid  = c.storeid  || "";
    merged.cityzip  = c.cityzip  || "";
    merged.placeid  = c.placeid  || "";
    merged.placezip = c.placezip || "";
  }
  if (merged.storeid || merged.cityzip || merged.placeid) wr(HK, JSON.stringify(merged));
  return merged;
}

function buildHeaders(ctx, token) {
  var H = { "authorization": token, "user-agent": ctx.ua || UA, "x-pupu-auto": "1" };
  // 关键：新版 GET 必须有位置头之一
  if (ctx.storeid) H["pp_storeid"] = ctx.storeid;
  if (ctx.cityzip) H["pp-cityzip"] = ctx.cityzip;
  if (ctx.placeid) H["pp-placeid"] = ctx.placeid;
  if (ctx.placezip) H["pp-placezip"] = ctx.placezip;
  if (ctx.suid) H["pp-suid"] = ctx.suid;
  if (ctx.userid) H["pp-userid"] = ctx.userid;
  if (ctx.version) H["pp-version"] = ctx.version;
  H["pp-os"] = "001";
  return H;
}

// 每日一条：登录态类提示（缺凭据 / 缺位置头 / token 过期）
function remind(msg) {
  if (seenToday(KW)) { log("remind suppressed: " + msg); return; }
  markToday(KW);
  notify("朴朴登录态不可用", msg);
}

// 每日一条：失败提示。cron 每 10 分钟一次，不加节流会变成通知轰炸
function fail(msg) {
  if (seenToday(KF)) { log("fail suppressed: " + msg); return; }
  markToday(KF);
  notify("打卡失败", msg);
}

function signin(finish) {
  var token = rd(TK);
  var gid = rd(GK);
  var ctx = parse(rd(HK) || "{}");

  log("signin token=" + (token ? "ok(len=" + String(token).length + ")" : "MISSING") +
      " gid=" + (gid ? "ok" : "MISSING") + " ctx[" + ctxBrief(ctx) + "]");

  if (!token || !gid) {
    remind("请打开一次朴朴小程序签到页以获取登录态");
    finish(); return;
  }
  if (!ctx.storeid && !ctx.cityzip && !ctx.placeid) {
    // 缺位置头：GET 必然 400000，等用户打开小程序补抓
    log("missing location headers, wait for next interception");
    remind("缺少门店信息，打开一次朴朴小程序签到页即可");
    finish(); return;
  }

  var ti = tokenInfo(token);
  var label = ti.left === -1 ? "no-exp-claim" : (ti.valid ? ("ok, " + ti.left + " min left") : ("EXPIRED " + (-ti.left) + " min ago"));
  log("token " + label);
  if (!ti.valid) {
    // 静默：token 约 2h 寿命且只能由小程序桥刷新，每天推「请打开小程序」只是噪音。
    // 用户下次打开小程序会自动抓新 token 并打卡。
    log("skip: token expired (silent)");
    finish(); return;
  }

  var H = buildHeaders(ctx, token);

  call("get", API + "/client/game/task_system/user_tasks/task_groups/" + gid, H, null, function (err, resp, data) {
    if (err) { log("GET failed: " + err); fail("网络错误: " + err); finish(); return; }

    var j = parse(data);
    log("GET errcode=" + j.errcode + (j.errcode ? " errmsg=" + j.errmsg : ""));
    if (j.errcode === 403) { remind("登录已过期，打开一次朴朴小程序即可恢复"); finish(); return; }
    if (j.errcode !== 0) {
      // 400000 多为活动未生效/已结束或缺头，静默等下次
      log("GET errcode=" + j.errcode + " errmsg=" + j.errmsg + " (silent)");
      finish(); return;
    }

    var d = j.data || {};
    log("group=" + d.task_group_name + " rule=" + d.task_rule_type + " end=" + d.end_time);
    // end_time 可能是秒级或毫秒级时间戳：归一化后再比较；解析不了就当未结束，
    // 交给下面的任务列表判断兜底（秒级误判会导致当天所有打卡静默跳过）
    var end = Number(d.end_time);
    if (Number.isFinite(end) && end > 0) {
      if (Date.now() > (end < 1e12 ? end * 1000 : end)) { log("activity ended"); finish(); return; }
    }

    var all = d.tasks || [];
    var todo = all.filter(function (t) { return t.task_status === 0 && !t.check_in_lock; });
    var doneCnt = all.filter(function (t) { return t.task_status === 30; }).length;
    log("tasks=" + all.length + " done=" + doneCnt + " todo=" + todo.length + " :: " + all.map(function (t) {
      return (t.task_name || "").replace("累计打卡", "D") + "[s=" + t.task_status + ",l=" + t.check_in_lock + "]";
    }).join(" "));

    if (!todo.length) {
      // KD 只在服务端确认「全部任务今日已完成」时写入：
      //   task_status === 30  → 已完成
      //   check_in_lock 为真  → 今日已打过被锁定（对应「一天只能打卡一次」）
      // 之前「无待打就写 KD」会漏打稍后解锁/稍后才到日期的任务
      var allDoneToday = all.length > 0 && all.every(function (t) {
        return t.task_status === 30 || t.check_in_lock;
      });
      if (allDoneToday) {
        markToday(KD);
        if (doneCnt > 0) {
          log("all done today");
          notify("今日已打卡", (d.task_group_name || "朴朴") + " 第 " + doneCnt + " 天已完成");
        } else {
          log("all locked/done today (cumulative)");
        }
      } else {
        log("no clockable task (pending/locked/partial) — keep waiting");
      }
      finish(); return;
    }

    var path = d.task_rule_type === 20 ? "cumulative_clock" : "clock";
    var i = 0;
    (function next() {
      if (i >= todo.length) { finish(); return; }
      var t = todo[i++];
      var url = API + "/client/game/task_system/user_tasks/task/" + gid + "/" + t.task_id + "/" + path;
      log("POST " + url);
      call("post", url, H, null, function (e2, r2, d2) {
        if (e2) { log("clock fail: " + e2); fail("网络错误: " + e2); next(); return; }
        var cj = parse(d2);
        log("clock errcode=" + cj.errcode + (cj.errcode ? " errmsg=" + cj.errmsg : ""));

        if (cj.errcode === 0) {
          var rt = (cj.data && cj.data.receive_reward_type) || 0;
          if (t.take_in_way && t.take_in_way !== 10) {
            // 该分支（take_in_way=20/30 需手动领奖）未实测；失败只记日志，不影响打卡结果
            call("put", API + "/client/game/task_system/user_tasks/task/" + t.task_id + "/reward", H, "{}", function (e3, r3, d3) {
              var rj = parse(d3);
              log("reward " + (e3 ? "fail: " + e3 : "errcode=" + (rj && rj.errcode !== undefined ? rj.errcode : "?")));
            });
          }
          // 单个任务成功/重复都不再写全日 KD：由下一轮服务端任务列表确认后统一收口。
          // 通知按任务去重，覆盖「刚打完但列表状态滞后导致重复 POST」的窗口
          if (!seenTaskDone(t.task_id)) {
            markTaskDone(t.task_id);
            notify("打卡成功", (t.task_name || "任务") + (rt === 10 ? " · 奖励已到账~" : " · 奖励即将到账~"));
          } else {
            log("task " + t.task_id + " already notified today");
          }
        } else if (cj.errcode === 400000 && /任务已经完成/.test(cj.errmsg || "")) {
          if (!seenTaskDone(t.task_id)) {
            markTaskDone(t.task_id);
            notify("今日已打卡", (t.task_name || "任务") + " 已完成，无需重复");
          }
        } else if (cj.errcode === 400000 && /一天只能打卡一次/.test(cj.errmsg || "")) {
          // 任务尚未到日期，属良性状态：不写完成标记，不弹通知，等下一轮
          log("not available yet: " + cj.errmsg);
        } else if (cj.errcode === 403) {
          remind("登录已过期，打开一次朴朴小程序即可恢复");
        } else {
          fail(cj.errmsg || ("errcode " + cj.errcode));
        }
        next();
      });
    })();
  });
}

(function main() {
  try {
    if (typeof $request !== "undefined") {
      // ============ 拦截模式：只抓凭据，立即放行，绝不阻塞页面 ============
      // 重要：早期版本在这里同步完成 GET+POST，会拖慢页面请求导致前端报
      //      "活动太火爆啦～请稍后再试"（前端 catch 分支的兜底文案）。
      //      现在改为零阻塞：抓完凭据马上 $done({})，打卡交给 cron。
      var method = String($request.method || "GET").toUpperCase();
      if (method === "OPTIONS" || method === "HEAD") { $done({}); return; }

      if (hdr("x-pupu-auto")) { $done({}); return; }

      var url = $request.url || "";
      log(method + " " + url.substring(0, 90));

      var auth = hdr("authorization");
      var tokChanged = false;
      if (auth) {
        var oldTok = rd(TK);
        if (oldTok !== auth) { wr(TK, auth); tokChanged = true; }
      }
      saveCtx();

      var m = url.match(/task_groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m && !/\/(preview|more_task)/.test(url)) { wr(GK, m[1]); log("gid=" + m[1]); }

      // 首次抓到新凭据时通知一次（每天一条）：$done 之后脚本随时可能被回收，
      // 依赖 $done 之后才执行的逻辑不可靠，通知必须在放行前发
      if (tokChanged && !seenToday(KC)) {
        markToday(KC);
        notify("凭据已获取", "已抓到登录态，" + (seenToday(KD) ? "今日已完成打卡" : "将在 10 分钟内自动打卡"));
      }

      $done({});   // ← 立即放行，页面不受任何影响

      // 可选：这里不再发任何请求。打卡由 cron 完成（见下方配置每 10 分钟）
      return;
    }

    // ============ cron 模式：完整打卡逻辑 ============
    log("cron fire");
    if (seenToday(KD)) { log("done today"); $done({}); return; }
    signin(once(function () { $done({}); }));

  } catch (e) {
    log("FATAL: " + (e && e.stack ? e.stack : e));
    try { $done({}); } catch (e2) {}
  }
})();
