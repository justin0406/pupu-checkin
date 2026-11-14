# 朴朴社群自动签到

朴朴超市微信小程序「社群打卡领福利」自动签到脚本，支持 **Surge** 与 **Loon**。

打开小程序时脚本自动抓取登录态，随后由定时任务在 **10 分钟内**完成打卡，无需手动点「打卡」按钮。

## 能做什么 / 不能做什么

| | |
|---|---|
| ✅ 自动抓取 | `Authorization`（JWT）、活动 `task_group_id`、门店位置头、小程序 UA |
| ✅ 自动打卡 | 每 10 分钟检查一次，token 有效时自动完成并通知 |
| ✅ 自动适配 | 活动每周轮换，`task_group_id` 从请求中抓取，换周无需改配置 |
| ❌ 无法续期 | token 约 2 小时寿命，只能由小程序原生桥刷新，脚本不能自行延长 |
| ❌ 无法离线 | cron 由客户端触发，Surge / Loon 未运行或设备离线时不执行 |
| ❌ 无法免开小程序 | 一整天不打开小程序，当天无法打卡（微信登录态机制决定，非脚本限制）|

## 版本

插件 / 模块名称自带版本号，例如 **朴朴社群自动签到 v5.6**。
装的哪一版，在 Loon「插件」列表或 Surge「模块」列表里一眼可见，不必翻日志。

> 发布约定：改脚本时同步更新三处 —— `scripts/pupu_signin.js` 的 `VER`、
> `loon/pupu_signin.plugin` 与 `surge/pupu_signin.sgmodule` 的 `#!name`。

当前版本：**v5.6**

## 安装

### Surge

安装模块（Surge → 模块 → 安装新模块，粘贴地址）：

```
https://raw.githubusercontent.com/justin0406/pupu-checkin/main/surge/pupu_signin.sgmodule
```

或手动配置：

```ini
[Script]
pupu_signin = type=http-request, pattern=^https?://j1\.pupuapi\.com/client/game/task_system/, requires-body=0, script-path=https://raw.githubusercontent.com/justin0406/pupu-checkin/main/scripts/pupu_signin.js
pupu_signin_cron = type=cron, cron="0,10,20,30,40,50 * * * *", script-path=https://raw.githubusercontent.com/justin0406/pupu-checkin/main/scripts/pupu_signin.js

[MITM]
hostname = %APPEND% j1.pupuapi.com
```

### Loon

安装插件（Loon → 配置 → 插件 → 添加，粘贴地址）：

```
https://raw.githubusercontent.com/justin0406/pupu-checkin/main/loon/pupu_signin.plugin
```

或手动配置：

```ini
[Script]
http-request ^https?:\/\/j1\.pupuapi\.com\/client\/game\/task_system\/ script-path=https://raw.githubusercontent.com/justin0406/pupu-checkin/main/scripts/pupu_signin.js, requires-body=false, max-size=-1, binary-body-mode=false, tag=朴朴签到
cron "0,10,20,30,40,50 * * * *" script-path=https://raw.githubusercontent.com/justin0406/pupu-checkin/main/scripts/pupu_signin.js, tag=朴朴签到定时

[MITM]
hostname = %APPEND% j1.pupuapi.com
```

### 更新

- **Surge**：模块列表里对本模块执行更新
- **Loon**：配置 → 插件 → 找到本插件 → 更新

若更新后插件名已是新版本、但日志仍打印旧版本号，说明本地脚本缓存未刷新：
到 Loon → 脚本 里删除 `pupu_signin.js` 后重新加载配置。

### 卸载

删除模块 / 插件后，以下存储键会残留（客户端无批量删键接口）：
`pp_pupu_token`、`pp_pupu_gid`、`pp_pupu_ctx`、`pp_done`、`pp_warn`、`pp_cred`、`pp_fail`。
残留不影响功能。其中 `pp_pupu_token`（登录态）与 `pp_pupu_ctx`（门店、`pp-suid`、`pp-userid`）
含身份信息，重装或转手设备前建议清除。

## 首次使用

1. 确认 MITM 已开启（Surge / Loon 的 CA 证书已安装并信任）
2. 打开朴朴小程序，进入社群签到页
3. 脚本抓取凭据后发出「凭据已获取」通知，最迟 10 分钟后收到打卡结果

脚本会自行抓取并保存登录态、活动 ID、门店信息，之后无需再手动配置。

> 拦截规则只匹配 `j1.pupuapi.com/client/game/task_system/` 路径。实测打开小程序任意页面
> （不必进签到页）即可抓到新 token；若长时间抓不到，进一次签到页。

## 工作原理

```
打开小程序
  ↓ 命中 http-request 规则（仅 /client/game/task_system/ 路径）
抓取 Authorization(JWT) + task_group_id + 位置头 + UA → 写入存储
  ↓ 立即 $done({}) 放行，不发任何请求（零阻塞）
─── 最多 10 分钟后 ───
cron 触发
  ↓ 本地解 JWT exp；已过期则静默退出
GET  /client/game/task_system/user_tasks/task_groups/{gid}
  ↓ 筛 task_status===0 && !check_in_lock
POST .../task/{gid}/{tid}/cumulative_clock   （task_rule_type=20）
POST .../task/{gid}/{tid}/clock              （其他）
  ↓
通知结果 + 写当日完成标记
```

## 通知一览

通知标题固定，副标题统一为「朴朴签到」。

| 标题 | 正文 | 频率 |
|---|---|---|
| 凭据已获取 | 已抓到登录态，将在 10 分钟内自动打卡 / 今日已完成打卡 | 每天最多 1 条 |
| 打卡成功 | `<任务名> · 奖励已到账~`（`receive_reward_type=10`）| 每次成功 |
| 打卡成功 | `<任务名> · 奖励即将到账~`（其他类型）| 每次成功 |
| 今日已打卡 | `<活动名> 第 N 天已完成` / `<任务名> 已完成，无需重复` | 每天最多 1 次 |
| 朴朴登录态不可用 | 请打开一次朴朴小程序签到页以获取登录态 | 每天最多 1 条 |
| 朴朴登录态不可用 | 缺少门店信息，打开一次朴朴小程序签到页即可 | 每天最多 1 条 |
| 朴朴登录态不可用 | 登录已过期，打开一次朴朴小程序即可恢复 | 每天最多 1 条 |
| 打卡失败 | 网络错误 / 服务端 `errmsg` | 每天最多 1 条 |

**token 过期不发通知**（v5.6 起）：过期属正常状态，每天推送「请打开小程序」只是噪音。
需要确认脚本状态时看日志，不要等通知。

## 接口说明

| 接口 | 说明 |
|---|---|
| `GET /client/game/task_system/user_tasks/task_groups/{task_group_id}` | 任务组详情（活动信息 + 每日任务列表）|
| `POST /client/game/task_system/user_tasks/task/{gid}/{task_id}/cumulative_clock` | 累计打卡（`task_rule_type=20`）|
| `POST /client/game/task_system/user_tasks/task/{gid}/{task_id}/clock` | 普通打卡 |
| `PUT /client/game/task_system/user_tasks/task/{task_id}/reward` | 领取奖励（`take_in_way` 为 20/30 时）。**该路径未实测**，当前活动均为 `take_in_way=10` 即打即领 |

### 状态判断

| 字段 | 含义 |
|---|---|
| `task_status === 0 && !check_in_lock` | 今日可打卡 |
| `task_status === 30` | 已完成 |
| `is_received` | 恒为 `true`，**不可用于判断** |

### 返回码

| errcode | 含义 | 脚本处理 |
|---|---|---|
| `0` + `data.receive_reward_type=10` | 打卡成功，奖励即到账 | 通知成功 |
| `400000 任务已经完成了,不能重复完成` | 今日已打卡（幂等）| 记完成，通知 |
| `400000 一天只能打卡一次` | 该任务尚未到日期（良性）| 静默，等下一轮 |
| `400000 非法请求` | 缺少位置头 | 静默（GET 阶段）|
| `400000 任务组未生效` | 活动已结束 | 静默 |
| `403 签名不存在` / `403 签名非法` | 未登录 / 登录态失效 | 提醒（每天 1 条）|

### 登录态（token）时效

`Authorization` 是服务端签发的 ES256 JWT，**有效期约 2 小时**（不是 cookie，也不是一天）。实测数据：

| 抓包 | 抓包时刻 | JWT exp | 剩余 |
|---|---|---|---|
| 2026-10-05 | 10:28 | 12:32 | 124.7 分钟 |
| 2026-11-08 | 10:40 | 12:37 | 116.3 分钟 |

客户端无法续期，只有**小程序运行时**会重新登录换新 token。因此：

- ✅ **打开朴朴小程序任意页面**（不必进签到页），脚本抓到新 token 后由 cron 在 10 分钟内打卡
- ✅ 活动换周时进一次签到页即可让脚本抓到新的 `task_group_id`
- ⚠️ `cron` 兜底只在 token 仍有效时生效；过期后静默跳过，不发通知
- ⚠️ 如果一整天都不打开小程序，当天无法自动打卡（微信小程序登录态机制决定，非脚本限制）

### 鉴权要点

服务端**只校验 `Authorization: Bearer <JWT>`**：

- 无 token → `403 签名不存在`
- 无效 token → `403 签名非法`
- `sign-v2` / `seal-v2` / `sw8` / `timestamp` / `pp-seqid` 等头**均不校验**，无需生成

但 **GET 接口额外要求至少一个位置头**（`pp_storeid` / `pp-cityzip` / `pp-placeid`），否则返回 `400000 非法请求`。这是脚本会自动抓取并保存 `pp_pupu_ctx` 的原因。

## 设计细节

- **拦截零阻塞**：`http-request` 阶段只抓取凭据后立即 `$done({})` 放行，不做任何网络请求。
  早期版本在这里同步执行 GET+POST，会拖慢页面请求，前端超时后走 catch 分支弹出
  「活动太火爆啦～请稍后再试」（该文案是前端 `errmsg` 为空时的兜底，并非风控提示）。
  注意必须用 `$done({})` 而非 `$done()`，后者在 Loon 上同样会触发该错误。
- **打卡交给 cron**：每 10 分钟检查一次，token 有效时自动完成打卡，最迟 10 分钟内到账。
  cron 必须**全天**运行（含凌晨）：`$done({})` 之后脚本随时可能被回收，拦截路径不能承担
  任何异步后续，打卡时效完全由 cron 粒度决定，而用户打开小程序的时刻不受限。
- **纯回调式**：不使用 async/await，规避 Surge / Loon 的 JSC 兼容问题
- **本地校验 JWT 过期**：解析 `exp` 判断，比依赖 `400000` 可靠（该码有多种含义）
- **每日防重**：成功后写当日标记，同一天不再请求接口
- **自动适配新活动**：每周活动 `task_group_id` 会变，脚本从请求中自动抓取，无需改配置
- **自动判断打卡类型**：`task_rule_type=20` 走 `cumulative_clock`，否则走 `clock`
- **UA 跟随真实值**：抓取小程序请求的 `User-Agent` 保存复用，硬编码仅作兜底
  （服务端已有按头校验的先例，见上文位置头）
- **通知节流**：登录态类提示与失败提示均每天最多一条，避免 cron 每 10 分钟轰炸
- **固定键存日期**：所有每日状态复用固定 key，值存日期串。`$persistentStore` 无删除 API，
  用日期后缀作 key 会无限残留

## 存储键

| Key | 内容 |
|---|---|
| `pp_pupu_token` | `Authorization`（含 `Bearer ` 前缀）|
| `pp_pupu_gid` | 当前活动 `task_group_id` |
| `pp_pupu_ctx` | JSON：`storeid` / `cityzip` / `placeid` / `placezip` / `suid` / `userid` / `version` / `ua` |
| `pp_done` | 最近一次完成打卡的日期 |
| `pp_warn` | 最近一次登录态提醒的日期 |
| `pp_cred` | 最近一次「凭据已获取」通知的日期 |
| `pp_fail` | 最近一次失败通知的日期 |

所有日期型 key 用**固定键名 + 值存日期串**（`YYYY-M-D`，本地时间，不补零）。
不要用 `pp_done_2026-11-10` 这类按日期命名的键：`$persistentStore` 只有读写、没有删除，
每天新建 key 会永久堆积。

## 排错

**Surge**：首页右上角 `…` → 日志 → 搜索 `pupu_signin`
**Loon**：日志 → 搜索 `pupu_signin`

| 日志 | 含义 |
|---|---|
| 完全无日志 | 脚本未触发：检查 MITM 开关、`hostname`、`script-path` 是否加载 |
| `signin token=MISSING` | 未抓到凭据，打开一次小程序 |
| `signin ... gid=MISSING` | 未抓到活动 ID，进一次签到页 |
| `missing location headers` | 缺门店位置头，进一次签到页 |
| `token ok, N min left` | 正常，剩余 N 分钟 |
| `skip: token expired (silent)` | token 过期，静默跳过（正常行为，打开小程序即恢复）|
| `done today` | 当日已完成，跳过（正常）|
| `GET errcode=400000` | 活动未开始 / 已结束 / 缺位置头，静默 |
| `GET errcode=403` | 登录失效，打开小程序刷新 |
| `not available yet` | 任务未到日期（正常）|
| `remind suppressed` / `fail suppressed` | 当日已通知过，节流生效（正常）|
| `FATAL:` | 脚本异常，附堆栈 |

## 免责声明

本项目仅供学习与个人自动化使用。接口为逆向分析所得，未经官方授权，可能随时变更。使用产生的任何后果由使用者自行承担。请勿用于商业用途或大规模请求。
