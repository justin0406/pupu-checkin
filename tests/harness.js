// Surge/Loon 环境模拟器：在 vm 中运行 pupu_signin.js 并断言行为。
// pupu_signin.js 是回调风格（非 async/await），脚本通过 $done 收尾，
// 因此 harness 用 $done 充当完成信号，外加 3 秒超时防止挂死。
const vm = require('vm');
const fs = require('fs');

const SRC = fs.readFileSync(process.argv[2], 'utf8');

function today() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 造一个带 exp 的 ES256 形状 JWT（脚本只本地解 payload，不验签）
function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function makeToken(minLeft) {
  const exp = Math.floor(Date.now() / 1000) + minLeft * 60;
  return 'Bearer ' + b64url({ alg: 'ES256' }) + '.' + b64url({ exp }) + '.sig';
}

const GID = '11112222-3333-4444-5555-666677778888';

function T(id, status, lock, name, take) {
  return { task_id: id, task_status: status, check_in_lock: !!lock, task_name: name || ('任务' + id), take_in_way: take || 10 };
}

// 有状态假服务端：打卡成功后把任务翻成 check_in_lock=true（服务端真实行为的近似）
function makeServer(opts) {
  opts = opts || {};
  const tasks = opts.tasks || [];
  const clocks = [];
  const rewards = [];
  return {
    tasks, clocks, rewards,
    handler(method, url) {
      if (opts.getErr) return { err: opts.getErr };
      if (method === 'GET' && url.indexOf('/task_groups/') >= 0) {
        return { body: JSON.stringify({
          errcode: opts.groupErrcode || 0,
          errmsg: opts.groupErrmsg || '',
          data: {
            task_group_name: opts.groupName || '测试组',
            task_rule_type: 10,
            end_time: opts.endTime !== undefined ? opts.endTime : Date.now() + 3600000,
            tasks,
          },
        }) };
      }
      const m = /\/task\/[0-9a-f-]+\/([^/]+)\/(clock|cumulative_clock)$/.exec(url);
      if (method === 'POST' && m) {
        const id = m[1];
        clocks.push(id);
        if (opts.clockErrcode !== undefined) {
          return { body: JSON.stringify({ errcode: opts.clockErrcode, errmsg: opts.clockErrmsg || '', data: {} }) };
        }
        const t = tasks.find((x) => x.task_id === id);
        if (t) t.check_in_lock = true;
        return { body: JSON.stringify({ errcode: 0, data: { receive_reward_type: 10 } }) };
      }
      if (method === 'PUT' && url.indexOf('/reward') >= 0) {
        rewards.push(url);
        return { body: JSON.stringify({ errcode: 0 }) };
      }
      return { status: 404, body: '' };
    },
  };
}

function seededStore(extra) {
  return Object.assign({
    pp_pupu_token: makeToken(60),
    pp_pupu_gid: GID,
    pp_pupu_ctx: JSON.stringify({ storeid: 'S1', cityzip: 'C1', placeid: 'P1' }),
  }, extra);
}

function cloneStore(store) { return JSON.parse(JSON.stringify(store)); }

function makeEnv(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.store || {});
  const notifications = [];
  const requests = [];
  const logs = [];
  const server = opts.server || makeServer(opts.serverOpts || {});
  let doneResolve;
  const done = new Promise((r) => { doneResolve = r; });
  const ctx = {
    console: { log: (...a) => logs.push(a.join(' ')) },
    Date, JSON, Math, Object, String, Number, Array, Promise,
    $persistentStore: {
      read: (k) => (k in store ? store[k] : null),
      write: (v, k) => { store[k] = v; },
    },
    $notification: { post: (t, s, b) => notifications.push({ t, s, b }) },
    $httpClient: {
      get: (o, cb) => { requests.push({ method: 'GET', url: o.url, headers: o.headers }); const r = server.handler('GET', o.url); cb(r.err || null, r.err ? null : { status: r.status || 200, headers: {} }, r.body || ''); },
      post: (o, cb) => { requests.push({ method: 'POST', url: o.url, headers: o.headers, body: o.body }); const r = server.handler('POST', o.url); cb(r.err || null, r.err ? null : { status: r.status || 200, headers: {} }, r.body || ''); },
      put: (o, cb) => { requests.push({ method: 'PUT', url: o.url, headers: o.headers, body: o.body }); const r = server.handler('PUT', o.url); cb(r.err || null, r.err ? null : { status: r.status || 200, headers: {} }, r.body || ''); },
    },
    $done: () => doneResolve(),
  };
  if (opts.request) ctx.$request = opts.request;
  return {
    ctx, store, notifications, requests, logs, done,
    run() { new vm.Script(SRC).runInNewContext(ctx); return done; },
  };
}

async function run(env, label) {
  let to;
  const timeout = new Promise((_, rej) => { to = setTimeout(() => rej(new Error(label + ': $done 未在 3s 内被调用')), 3000); });
  try {
    await Promise.race([env.run(), timeout]);
  } finally {
    clearTimeout(to);
  }
}

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '\n         ' + JSON.stringify(extra)));
}

const day = today();

(async () => {
  // 1 拦截模式：只抓凭据，零请求，通知在 $done 前发
  console.log('\n[1] 拦截模式：只存凭据即刻放行');
  const e1 = makeEnv({
    request: {
      method: 'GET',
      url: 'https://j1.pupuapi.com/client/game/task_system/user_tasks/task_groups/' + GID,
      headers: { Authorization: 'Bearer AAA.BBB.TOK', 'pp_storeid': 'S9', 'pp-cityzip': 'C9', 'pp-suid': 'SUID123' },
    },
  });
  await run(e1, '拦截');
  check('拦截零网络请求', e1.requests.length === 0, e1.requests);
  check('token 已存', e1.store.pp_pupu_token === 'Bearer AAA.BBB.TOK', e1.store.pp_pupu_token);
  check('gid 已存', e1.store.pp_pupu_gid === GID, e1.store.pp_pupu_gid);
  const ctx1 = JSON.parse(e1.store.pp_pupu_ctx);
  check('位置组整体替换（不残留旧门店）', ctx1.storeid === 'S9' && ctx1.cityzip === 'C9' && ctx1.placeid === '', ctx1);
  check('凭据通知 1 条', e1.notifications.length === 1 && /凭据已获取/.test(e1.notifications[0].t), e1.notifications);
  check('日志不含 token 值', !e1.logs.join('\n').includes('BBB.TOK'), e1.logs);
  check('日志不含用户标识', !e1.logs.join('\n').includes('SUID123'), e1.logs);

  // 2 token 过期：静默跳过，不发请求不通知（v5.6 语义回归）
  console.log('\n[2] token 过期静默');
  const e2 = makeEnv({ store: seededStore({ pp_pupu_token: makeToken(-30) }) });
  await run(e2, '过期');
  check('过期无请求', e2.requests.length === 0, e2.requests);
  check('过期无通知', e2.notifications.length === 0, e2.notifications);
  check('过期不写 KD', !e2.store.pp_done, e2.store);

  // 3 单任务成功：POST + 通知，KD 不写；下一轮服务端确认后 KD 收口
  console.log('\n[3] 单任务成功 → KD 由服务端列表收口');
  const s3 = makeServer({ tasks: [T('t1', 0, false)] });
  const e3 = makeEnv({ store: seededStore(), server: s3 });
  await run(e3, '单任务r1');
  check('POST t1', s3.clocks.includes('t1'), s3.clocks);
  check('成功通知 1 条', e3.notifications.length === 1 && /打卡成功/.test(e3.notifications[0].t), e3.notifications);
  check('成功不写 KD', !e3.store.pp_done, e3.store);
  const e3b = makeEnv({ store: cloneStore(e3.store), server: s3 });
  await run(e3b, '单任务r2');
  check('r2 无重复 POST', s3.clocks.filter((x) => x === 't1').length === 1, s3.clocks);
  check('r2 服务端确认后写 KD', e3b.store.pp_done === day, e3b.store);
  check('r2 无重复通知', e3b.notifications.length === 0, e3b.notifications);

  // 4 后解锁任务不被挡：run1 只成功 t1（旧代码会写 KD → t2 漏打）
  console.log('\n[4] 新增/后解锁任务不被早退挡住');
  const s4 = makeServer({ tasks: [T('t1', 0, false)] });
  const e4 = makeEnv({ store: seededStore(), server: s4 });
  await run(e4, '后解锁r1');
  s4.tasks.push(T('t2', 0, false, '新增任务'));
  const e4b = makeEnv({ store: cloneStore(e4.store), server: s4 });
  await run(e4b, '后解锁r2');
  check('新增任务被打卡', s4.clocks.includes('t2'), s4.clocks);

  // 5 重复完成：通知一次（列表滞后再 POST 也不重复弹）
  console.log('\n[5] 重复完成 400000「任务已经完成」');
  const s5 = makeServer({ tasks: [T('t1', 0, false)], clockErrcode: 400000, clockErrmsg: '任务已经完成了,不能重复完成' });
  const e5 = makeEnv({ store: seededStore(), server: s5 });
  await run(e5, '重复r1');
  check('重复通知 1 条', e5.notifications.length === 1 && /今日已打卡/.test(e5.notifications[0].t) && /无需重复/.test(e5.notifications[0].b), e5.notifications);
  check('重复不写 KD', !e5.store.pp_done, e5.store);
  const e5b = makeEnv({ store: cloneStore(e5.store), server: s5 });
  await run(e5b, '重复r2');
  check('重复通知不重复', e5b.notifications.length === 0, e5b.notifications);

  // 6 尚未到日期：无通知无标记，下一轮继续重试
  console.log('\n[6] 尚未到日期 400000「一天只能打卡一次」');
  const s6 = makeServer({ tasks: [T('t1', 0, false)], clockErrcode: 400000, clockErrmsg: '一天只能打卡一次' });
  const e6 = makeEnv({ store: seededStore(), server: s6 });
  await run(e6, '未到期r1');
  check('未到期无通知', e6.notifications.length === 0, e6.notifications);
  check('未到期不写标记', !e6.store.pp_done && !e6.store.pp_done_tasks, e6.store);
  const e6b = makeEnv({ store: cloneStore(e6.store), server: s6 });
  await run(e6b, '未到期r2');
  check('未到期下轮重试', s6.clocks.filter((x) => x === 't1').length === 2, s6.clocks);

  // 7 end_time 秒/毫秒归一化
  console.log('\n[7] end_time 单位归一化');
  const s7a = makeServer({ tasks: [T('t1', 0, false)], endTime: 1000000000 }); // 2001 年，秒级 → 已结束
  const e7a = makeEnv({ store: seededStore(), server: s7a });
  await run(e7a, 'end秒级过去');
  check('秒级过去不打卡', s7a.clocks.length === 0 && e7a.notifications.length === 0, s7a.clocks);
  const s7b = makeServer({ tasks: [T('t1', 0, false)], endTime: Math.floor(Date.now() / 1000) + 3600 }); // 秒级未来
  const e7b = makeEnv({ store: seededStore(), server: s7b });
  await run(e7b, 'end秒级未来');
  check('秒级未来正常打卡', s7b.clocks.length === 1, s7b.clocks);
  const s7c = makeServer({ tasks: [T('t1', 0, false)], endTime: 'not-a-number' }); // 解析不了 → 不判结束
  const e7c = makeEnv({ store: seededStore(), server: s7c });
  await run(e7c, 'end非法值');
  check('end_time 非法不误判结束', s7c.clocks.length === 1, s7c.clocks);

  // 8 take_in_way=20：触发 PUT reward
  console.log('\n[8] take_in_way=20 → PUT reward');
  const s8 = makeServer({ tasks: [T('t1', 0, false, '领奖任务', 20)] });
  const e8 = makeEnv({ store: seededStore(), server: s8 });
  await run(e8, 'reward');
  check('PUT reward 调用', s8.rewards.length === 1, s8.rewards);
  check('打卡仍完成', s8.clocks.length === 1, s8.clocks);

  // 9 会话/授权 403：remind 每天 1 条
  console.log('\n[9] 403 → 每天一条登录过期提醒');
  const s9 = makeServer({ tasks: [T('t1', 0, false)], groupErrcode: 403, groupErrmsg: '未授权' });
  const e9 = makeEnv({ store: seededStore(), server: s9 });
  await run(e9, '403r1');
  const e9b = makeEnv({ store: cloneStore(e9.store), server: s9 });
  await run(e9b, '403r2');
  check('403 提醒合计 1 条', e9.notifications.length + e9b.notifications.length === 1 &&
    /登录已过期/.test((e9.notifications[0] || e9b.notifications[0]).b || ''), { a: e9.notifications, b: e9b.notifications });

  // 10 GET 网络错误：fail 每天 1 条
  console.log('\n[10] GET 网络错误');
  const s10 = makeServer({ tasks: [T('t1', 0, false)], getErr: 'timeout' });
  const e10 = makeEnv({ store: seededStore(), server: s10 });
  await run(e10, '网络错误r1');
  const e10b = makeEnv({ store: cloneStore(e10.store), server: s10 });
  await run(e10b, '网络错误r2');
  check('网络错误提醒合计 1 条', e10.notifications.length + e10b.notifications.length === 1 &&
    /打卡失败/.test((e10.notifications[0] || e10b.notifications[0]).t), { a: e10.notifications, b: e10b.notifications });

  // 11 空任务组：不写 KD（回归：旧代码对空组也写 KD，把整天锁死）
  console.log('\n[11] 空任务组不写 KD');
  const s11 = makeServer({ tasks: [] });
  const e11 = makeEnv({ store: seededStore(), server: s11 });
  await run(e11, '空组');
  check('空组不写 KD', !e11.store.pp_done, e11.store);
  check('空组无通知', e11.notifications.length === 0, e11.notifications);

  // 12 全部任务今日已打（锁定/完成）：写 KD 早退，无 POST
  console.log('\n[12] 全部锁定/完成 → KD 收口');
  const s12 = makeServer({ tasks: [T('t1', 0, true), T('t2', 0, true)] }); // 累计任务今日已打，状态未到 30
  const e12 = makeEnv({ store: seededStore(), server: s12 });
  await run(e12, '全锁定');
  check('全锁定无 POST', s12.clocks.length === 0, s12.clocks);
  check('全锁定写 KD', e12.store.pp_done === day, e12.store);
  const s12b = makeServer({ tasks: [T('t1', 30, true)] }); // 状态 30 = 已完成
  const e12b = makeEnv({ store: seededStore(), server: s12b });
  await run(e12b, '全完成');
  check('全完成写 KD + 通知', e12b.store.pp_done === day &&
    e12b.notifications.length === 1 && /今日已打卡/.test(e12b.notifications[0].t), e12b.notifications);

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length ? '❌ ' + failed.length + '/' + results.length + ' FAILED' : '✅ ' + results.length + '/' + results.length + ' passed'));
  process.exit(failed.length ? 1 : 0);
})();
