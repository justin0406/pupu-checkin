/**
 * 朴朴超市微信小程序 - 社群打卡自动签到 (Surge Script) v4
 *
 * 适配 2026-11-08 新版（活动「社群打卡领福利-1102-1108」，task_rule_type=20 累计打卡）
 *
 * ⚠ 新版重要变化（实测 2026-11-08）：
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
 * ⏱ 登录态（token）机制（实测 2026-11-08）：
 *   - Authorization 是服务端签发的 ES256 JWT，exp 显示寿命约 2 小时（非 cookie、非一天）
 *   - 客户端无法续期，只有小程序运行时会重新登录换新 token
 *   - 所以：只要打开朴朴小程序（任意页面即可，不必进签到页），脚本抓到新 token 立刻打卡
 *   - cron 兜底仅在 token 仍有效时起作用，过期时只发一条提示
 *
 * 配置：
 *   [Script]
 *   pupu_signin = type=http-request, pattern=^https://j1\.pupuapi\.com/client/game/task_system/, requires-body=0, script-path=pupu_signin.js
 *   pupu_signin_cron = type=cron, cron="0,10,20,30,40,50 * * * *", script-path=pupu_signin.js
 *   [MITM]
 *   hostname = %APPEND% j1.pupuapi.com
 *
 * ⚠ 为什么拦截时不再直接打卡：
 *   拦截阶段同步做 GET+POST 会拖延页面请求，前端超时后走 catch 分支，
 *   弹出「活动太火爆啦～请稍后再试」。改为拦截只抓凭据即刻放行，
 *   打卡由 cron 每 10 分钟补上（0,10,20,30,40,50 分钟）（token 有效期内，最迟 10 分钟完成）。
 */

var VER = "5.2";
var API = "https://j1.pupuapi.com";
var TK = "pp_pupu_token";     // Authorization: Bearer ...
var GK = "pp_pupu_gid";       // 活动 task_group_id
var HK = "pp_pupu_ctx";       // JSON: {storeid, cityzip, placeid, suid, userid, version}
var LK = "pp_pupu_lastrun";
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.79(0x18004f26) NetType/WIFI Language/zh_CN miniProgram/wx122ef876a7132eb4";

function log(m) { try { console.log("[pupu_signin v" + VER + "] " + m); } catch (e) {} }
function rd(k) { try { return $persistentStore.read(k); } catch (e) { return null; } }
function wr(k, v) { try { $persistentStore.write(String(v), k); } catch (e) {} }
function today() { var d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
function doneKey() { return "pp_done_" + today(); }
function warnKey() { return "pp_warn_" + today(); }
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

function tokenExpired(token) { return !tokenInfo(token).valid; }

function saveCtx() {
  var c = {
    storeid: hdr("pp_storeid") || hdr("pp-storeid"),
    cityzip: hdr("pp-cityzip") || hdr("pp_cityzip"),
    placeid: hdr("pp-placeid") || hdr("pp_placeid"),
    placezip: hdr("pp-placezip") || hdr("pp_placezip"),
    suid: hdr("pp-suid"),
    userid: hdr("pp-userid"),
    version: hdr("pp-version")
  };
  var old = parse(rd(HK) || "{}");
  var merged = {};
  for (var k in c) { merged[k] = c[k] || old[k] || ""; }
  if (merged.storeid || merged.cityzip || merged.placeid) wr(HK, JSON.stringify(merged));
  return merged;
}

function buildHeaders(ctx, token) {
  var H = { "authorization": token, "user-agent": UA, "x-pupu-auto": "1" };
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

function remind(msg) {
  if (rd(warnKey())) { log("remind suppressed: " + msg); return; }
  wr(warnKey(), 1);
  notify("朴朴登录态不可用", msg);
}

function signin(trigger, finish) {
  var token = rd(TK);
  var gid = rd(GK);
  var ctx = parse(rd(HK) || "{}");

  log("signin(" + trigger + ") token=" + (token ? "ok" : "MISSING") + " gid=" + (gid || "MISSING") +
      " ctx=" + JSON.stringify(ctx).substring(0, 120));

  if (!token || !gid) {
    if (trigger === "cron") remind("请打开一次朴朴小程序签到页以获取登录态");
    finish(); return;
  }
  if (!ctx.storeid && !ctx.cityzip && !ctx.placeid) {
    // 缺位置头：GET 必然 400000，等用户打开小程序补抓
    log("missing location headers, wait for next interception");
    if (trigger === "cron") remind("缺少门店信息，打开一次朴朴小程序签到页即可");
    finish(); return;
  }

  var ti = tokenInfo(token);
  var label = ti.left === -1 ? "no-exp-claim" : (ti.valid ? ("ok, " + ti.left + " min left") : ("EXPIRED " + (-ti.left) + " min ago"));
  log("token " + label);
  if (!ti.valid) {
    log("skip: token expired (lifetime ~2h, refreshed only when mini program runs)");
    if (trigger === "cron") {
      remind("登录态已过期（有效期约 2 小时）；打开朴朴小程序任意页面即自动刷新并打卡");
    }
    finish(); return;
  }

  var quiet = trigger === "cron";
  var H = buildHeaders(ctx, token);

  call("get", API + "/client/game/task_system/user_tasks/task_groups/" + gid, H, null, function (err, resp, data) {
    if (err) { log("GET failed: " + err); if (!quiet) notify("打卡失败", "网络错误: " + err); finish(); return; }
    log("GET -> " + String(data).substring(0, 220));

    var j = parse(data);
    if (j.errcode === 403) { remind("登录已过期，打开一次朴朴小程序即可恢复"); finish(); return; }
    if (j.errcode !== 0) {
      // 400000 多为活动未生效/已结束或缺头，静默等下次
      log("GET errcode=" + j.errcode + " errmsg=" + j.errmsg + " (silent)");
      finish(); return;
    }

    var d = j.data || {};
    log("group=" + d.task_group_name + " rule=" + d.task_rule_type + " end=" + d.end_time);
    if (d.end_time && Date.now() > d.end_time) { log("activity ended"); finish(); return; }

    var all = d.tasks || [];
    var todo = all.filter(function (t) { return t.task_status === 0 && !t.check_in_lock; });
    var doneCnt = all.filter(function (t) { return t.task_status === 30; }).length;
    log("tasks=" + all.length + " done=" + doneCnt + " todo=" + todo.length + " :: " + all.map(function (t) {
      return (t.task_name || "").replace("累计打卡", "D") + "[s=" + t.task_status + ",l=" + t.check_in_lock + "]";
    }).join(" "));

    if (!todo.length) {
      wr(doneKey(), 1);
      if (doneCnt > 0) {
        log("all done today");
        if (!quiet) notify("今日已打卡", (d.task_group_name || "朴朴") + " 第 " + doneCnt + " 天已完成");
      } else {
        log("no clockable task (not started yet?)");
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
        if (e2) { log("clock fail: " + e2); if (!quiet) notify("打卡失败", "网络错误: " + e2); next(); return; }
        log("clock -> " + String(d2).substring(0, 200));
        var cj = parse(d2);

        if (cj.errcode === 0) {
          var rt = (cj.data && cj.data.receive_reward_type) || 0;
          if (t.take_in_way && t.take_in_way !== 10) {
            call("put", API + "/client/game/task_system/user_tasks/task/" + t.task_id + "/reward", H, "{}", function () {});
          }
          wr(doneKey(), 1);
          notify("打卡成功", (t.task_name || "任务") + (rt === 10 ? " · 奖励已到账~" : " · 奖励即将到账~"));
        } else if (cj.errcode === 400000 && /任务已经完成/.test(cj.errmsg || "")) {
          wr(doneKey(), 1);
          if (!quiet) notify("今日已打卡", (t.task_name || "任务") + " 已完成，无需重复");
        } else if (cj.errcode === 403) {
          remind("登录已过期，打开一次朴朴小程序即可恢复");
        } else {
          notify("打卡失败", cj.errmsg || ("errcode " + cj.errcode));
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
      if (auth) wr(TK, auth);
      saveCtx();

      var m = url.match(/task_groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      if (m && !/\/(preview|more_task)/.test(url)) { wr(GK, m[1]); log("gid=" + m[1]); }

      $done({});   // ← 立即放行，页面不受任何影响

      // 可选：这里不再发任何请求。打卡由 cron 完成（见下方配置每 10 分钟）
      return;
    }

    // ============ cron 模式：完整打卡逻辑 ============
    log("cron fire");
    if (rd(doneKey())) { log("done today"); $done({}); return; }
    signin("cron", once(function () { $done({}); }));

  } catch (e) {
    log("FATAL: " + (e && e.stack ? e.stack : e));
    try { $done({}); } catch (e2) {}
  }
})();
