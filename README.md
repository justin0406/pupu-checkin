# 朴朴社群自动签到

朴朴超市微信小程序「社群打卡领福利」自动签到脚本，支持 **Surge** 与 **Loon**。

打开小程序即自动打卡，另有每日定时兜底。无需手动点「打卡」按钮。

## 安装

### Surge

安装模块：

```
https://raw.githubusercontent.com/justin0406/pupu-checkin/main/surge/pupu_signin.sgmodule
```

或手动配置：

```ini
[Script]
pupu_signin = type=http-request, pattern=^https?://j1\.pupuapi\.com/, requires-body=0, script-path=https://raw.githubusercontent.com/justin0406/pupu-checkin/main/scripts/pupu_signin.js
pupu_signin_cron = type=cron, cron="32 7,12,19 * * *", script-path=https://raw.githubusercontent.com/justin0406/pupu-checkin/main/scripts/pupu_signin.js

[MITM]
hostname = %APPEND% j1.pupuapi.com
```

### Loon

安装插件：

```
https://raw.githubusercontent.com/justin0406/pupu-checkin/main/loon/pupu_signin.plugin
```

或手动配置：

```ini
[Script]
http-request ^https?:\/\/j1\.pupuapi\.com\/ script-path=https://raw.githubusercontent.com/justin0406/pupu-checkin/main/scripts/pupu_signin.js, requires-body=false, max-size=-1, binary-body-mode=false, tag=朴朴签到
cron "32 7,12,19 * * *" script-path=https://raw.githubusercontent.com/justin0406/pupu-checkin/main/scripts/pupu_signin.js, tag=朴朴签到定时

[MITM]
hostname = %APPEND% j1.pupuapi.com
```

## 使用

1. 确认 MITM 已开启（Surge / Loon 的 CA 证书已安装并信任）
2. 打开朴朴小程序，进入社群签到页
3. 收到通知即成功：
   - `打卡成功 · 累计打卡第N天 · 奖励已到账`
   - `今日已打卡 · 已无需再打`
   - `朴朴登录态不可用 · 登录已过期，打开一次朴朴小程序即可恢复`

**首次使用**需要打开一次签到页，脚本会自行抓取登录态、活动 ID、门店信息并保存。之后每天打开小程序（或 cron 触发）即自动打卡。

## 工作原理

```
打开小程序
  ↓ 拦截 j1.pupuapi.com 请求
抓取 Authorization(JWT) + task_group_id + pp_storeid/pp_cityzip/pp_placeid
  ↓
GET  /client/game/task_system/user_tasks/task_groups/{gid}
  ↓ 找 task_status===0 && !check_in_lock 的任务
POST /client/game/task_system/user_tasks/task/{gid}/{tid}/cumulative_clock
  ↓
通知结果
```

### 接口说明

| 接口 | 说明 |
|---|---|
| `GET /client/game/task_system/user_tasks/task_groups/{task_group_id}` | 任务组详情（活动信息 + 每日任务列表）|
| `POST /client/game/task_system/user_tasks/task/{gid}/{task_id}/cumulative_clock` | 累计打卡（`task_rule_type=20`）|
| `POST /client/game/task_system/user_tasks/task/{gid}/{task_id}/clock` | 普通打卡 |
| `PUT /client/game/task_system/user_tasks/task/{task_id}/reward` | 领取奖励（`take_in_way` 为 20/30 时需要）|

### 状态判断

| 字段 | 含义 |
|---|---|
| `task_status === 0 && !check_in_lock` | 今日可打卡 |
| `task_status === 30` | 已完成 |
| `is_received` | 恒为 `true`，**不可用于判断** |

### 返回码

| errcode | 含义 |
|---|---|
| `0` + `data.receive_reward_type=10` | 打卡成功，奖励即到账 |
| `400000 任务已经完成了,不能重复完成` | 今日已打卡（幂等）|
| `400000 一天只能打卡一次` | 该任务尚未到日期 |
| `400000 非法请求` | 缺少位置头（`pp_storeid`/`pp_cityzip`/`pp_placeid`）|
| `400000 任务组未生效` | 活动已结束 |
| `403 签名不存在` / `403 签名非法` | 未登录 / 登录态失效 |

### 鉴权要点

服务端**只校验 `Authorization: Bearer <JWT>`**：

- 无 token → `403 签名不存在`
- 无效 token → `403 签名非法`
- `sign-v2` / `seal-v2` / `sw8` / `timestamp` / `pp-seqid` 等头**均不校验**，无需生成

但 **GET 接口额外要求至少一个位置头**（`pp_storeid` / `pp-cityzip` / `pp-placeid`），否则返回 `400000 非法请求`。这是脚本会自动抓取并保存 `pp_pupu_ctx` 的原因。

## 设计细节

- **纯回调式**：不使用 async/await，规避 Surge / Loon 的 JSC 兼容问题
- **本地校验 JWT 过期**：解析 `exp` 判断，比依赖 `400000` 可靠（该码有多种含义）
- **8 秒防抖**：页面会并发多个请求，避免重复触发
- **每日防重**：成功后写当日标记，同一天不再重复打卡
- **自动适配新活动**：每周活动 `task_group_id` 会变，脚本从请求中自动抓取，无需改配置
- **自动判断打卡类型**：`task_rule_type=20` 走 `cumulative_clock`，否则走 `clock`
- **通知节流**：登录失效提示每天最多一条

## 存储键

| Key | 内容 |
|---|---|
| `pp_pupu_token` | Authorization |
| `pp_pupu_gid` | 当前活动 task_group_id |
| `pp_pupu_ctx` | 门店/位置信息 JSON |
| `pp_pupu_lastrun` | 防抖时间戳 |
| `pp_done_YYYY-M-D` | 当日完成标记 |
| `pp_warn_YYYY-M-D` | 当日提醒标记 |

## 排错

打开小程序无反应时：

1. **Surge**：首页右上角 `…` → 日志 → 搜索 `pupu_signin`
2. **Loon**：日志 → 搜索 `pupu_signin`

| 现象 | 原因 |
|---|---|
| 日志为空 | 脚本未触发：检查 MITM 开关、`hostname`、`script-path` 是否加载 |
| `missing location headers` | 未抓到门店信息，再打开一次签到页 |
| `token expired locally` | 登录态过期，打开小程序刷新 |
| `GET errcode=400000` | 活动未开始/已结束，或缺少位置头 |

## 免责声明

本项目仅供学习与个人自动化使用。接口为逆向分析所得，未经官方授权，可能随时变更。使用产生的任何后果由使用者自行承担。请勿用于商业用途或大规模请求。
