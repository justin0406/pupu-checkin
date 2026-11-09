/**
 * pupu_probe.js —— 极简探针（不做任何业务逻辑，只放行）
 *
 * 用途：验证 Loon/Surge 的 http-request 脚本机制本身是否会影响页面请求。
 *
 * ── Loon 配置（注意 Loon 与 Surge 语法不同）──
 *   [Script]
 *   http-request ^https?:\/\/j1\.pupuapi\.com\/client\/game\/task_system\/ script-path=https://raw.githubusercontent.com/justin0406/pupu-checkin/main/scripts/pupu_probe.js, requires-body=false, tag=探针
 *
 * ── Surge 配置 ──
 *   [Script]
 *   pupu_probe = type=http-request, pattern=^https?://j1\.pupuapi\.com/client/game/task_system/, requires-body=0, script-path=pupu_probe.js
 *
 * 预期：
 *   - 页面能正常打开 → 脚本机制没问题，问题在主脚本逻辑
 *   - 页面仍报「抱歉！当前网络异常哦～」→ 问题在 Loon 的 MITM/脚本机制本身，与业务逻辑无关
 */

(function () {
  try {
    var m = (typeof $request !== "undefined" && $request.method) || "?";
    var u = (typeof $request !== "undefined" && $request.url) || "";
    console.log("[probe] " + m + " " + String(u).substring(0, 110));
  } catch (e) {}
  $done();
})();
