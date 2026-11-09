/**
 * pupu_probe2.js —— 探针 B：只验证 $done({}) 写法是否解决问题
 *
 * 与 probe 唯一区别：用 $done({}) 代替 $done()
 *   Loon 规范：http-request 脚本不修改请求时应调用 $done({})
 *
 * Loon 配置：
 *   [Script]
 *   pupu_probe2 = type=http-request, pattern=^https?:\/\/j1\.pupuapi\.com\/client\/game\/task_system\/, requires-body=false, tag=探针B
 *
 * 对比结果：
 *   - 页面正常 → 根因就是 $done() 无参，主脚本已改 $done({})
 *   - 仍报错  → Loon 的 http-request 脚本机制问题，改用页面拦截方案
 */

(function () {
  try {
    var m = (typeof $request !== "undefined" && $request.method) || "?";
    var u = (typeof $request !== "undefined" && $request.url) || "";
    console.log("[probe2] " + m + " " + String(u).substring(0, 110));
  } catch (e) {}
  $done({});
})();
