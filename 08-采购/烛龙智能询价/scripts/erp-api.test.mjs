// ERP 接口脚本 erpApi 的离线测试：用模拟的 ERP 和 page.evaluate（返回超过 4000 字节时像 BrowserOS 一样只给文件引用）。
// 不连 ERP、不需要浏览器。改了 helpers/_erp/erpApi.md 之后运行：node scripts/erp-api.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
const md = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'helpers', '_erp', 'erpApi.md'), 'utf8');
// 仓库在 Windows 上检出时是 CRLF 换行
const src = md.match(/```js\r?\n([\s\S]*?)\r?\n```/)[1];
const erpApi = (0, eval)('(' + src + ')');
// 缩短真实计时常量，实际执行相同的 Promise/AbortController/finally 路径。
const fastErpApi = (0, eval)('(' + src.replace('const OP_BUDGET_MS = 24_000;', 'const OP_BUDGET_MS = 250;')
  .replace('const EVALUATE_MS = 9_000;', 'const EVALUATE_MS = 90;')
  .replace('const REQUEST_MS = 8_000;', 'const REQUEST_MS = 50;')
  .replace('const CLEANUP_MS = 500;', 'const CLEANUP_MS = 20;') + ')');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DICTS = {
  inquiry_item_condition: ['全新原装', '99新', '翻新', '二手', '拆机件', '国产替代', '待确认'],
  inquiry_lead_time: ['现货', '1-2天', '2-3天', '3-5天', '5-7天', '1-2周', '2-4周', '4-8周', '8周以上'],
};
const dictItems = (type) => type === 'inquiry_tax_rate'
  ? [{ itemName: '13%', itemValue: '13', status: 1 }, { itemName: '3%', itemValue: '3', status: 1 }, { itemName: '1%', itemValue: '1', status: 1 }]
  : DICTS[type].map((n, i) => ({ itemName: n, itemValue: String(i + 1), status: 1 }));

function makeEnv(state) {
  const store = structuredClone(state.store || { local: { zhul_token: 'T1' }, session: {} });
  const calls = [];
  const fetchMock = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, body: opts.body ? JSON.parse(opts.body) : null });
    const overridden = await state.fetchHook?.(url, opts);
    if (overridden) return overridden;
    const reply = (http, json) => ({ status: http, text: async () => JSON.stringify(json), json: async () => json });
    if (url === '/api/v1/auth/refresh') {
      if (state.refreshError) throw new Error('mock refresh unavailable');
      if (state.refreshReply) return { status: state.refreshReply.http, text: async () => state.refreshReply.text, json: async () => JSON.parse(state.refreshReply.text) };
      return state.refreshOk ? reply(200, { code: 0, data: { accessToken: 'T2' } }) : reply(401, { code: 401 });
    }
    const auth = (opts.headers || {}).Authorization;
    if ((state.expireT1 && auth === 'Bearer T1') || state.expireAll || (method === 'PUT' && state.put401)) return reply(state.authHttp ?? 401, { code: 401, message: 'expired' });
    if (state.networkAfterRefresh && auth === 'Bearer T2') throw new Error('mock network failed after successful refresh');
    if (method === 'PUT' && state.putNetworkError) throw new Error('mock PUT network unavailable');
    if (state.networkError) throw new Error('mock network unavailable');
    if (state.httpReply) return { status: state.httpReply.http, text: async () => state.httpReply.text };
    if (state.http404 && url.startsWith('/api/v1/inquiry/my-tasks/')) return reply(404, {});
    if (url.startsWith('/api/v1/system/dict-items')) {
      const t = decodeURIComponent(url.split('dictType=')[1]);
      let data = dictItems(t);
      if (state.dropLabel && t === 'inquiry_lead_time') data = data.filter((d) => d.itemName !== state.dropLabel);
      return reply(200, { code: 0, message: 'ok', data });
    }
    if (url.startsWith('/api/v1/inquiry/my-tasks?')) {
      const done = url.includes('done=true');
      return reply(200, { code: 0, message: 'ok', data: done === !!state.done ? [{ id: 1, taskCode: 'IQT', itemCount: 2, filledCount: state.filled ?? 0, status: 2, newField: 1 }] : [] });
    }
    if (method === 'PUT') {
      state.lastPut = JSON.parse(opts.body);
      if (state.putApplyThenError) {
        for (const item of state.lastPut.items) {
          const target = state.detail.items.find((i) => i.id === item.itemId);
          const status = state.lastPut.submit ? (state.detail.reviewRequired ? 3 : 2) : 1;
          target.quotes = item.noStock ? [q({ id: 9000 + item.itemId, status, noStock: true, unitPrice: undefined, note: item.noStockNote })]
            : item.quotes.map((value, i) => ({ ...value, id: 9000 + i, status, attachments: value.attachmentIds.map((id) => ({ id })) }));
        }
        throw new Error('mock response lost after server applied PUT');
      }
      return reply(200, state.putReply || { code: 0, message: 'ok' });
    }
    if (state.detailReply) return reply(state.detailReply.http, state.detailReply.json);
    const detail = JSON.parse(JSON.stringify(state.detail));
    return reply(200, { code: 0, message: 'ok', data: detail });
  };
  const timers = new Set();
  const context = {
    window: {}, Date, AbortController,
    setTimeout: (callback, ms) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => { timers.delete(timer); clearTimeout(timer); },
    sessionStorage: { getItem: (k) => store.session[k] ?? null, setItem: (k, v) => { store.session[k] = v; } },
    localStorage: { getItem: (k) => store.local[k] ?? null, setItem: (k, v) => { store.local[k] = v; } },
    fetch: fetchMock,
  };
  const evaluations = [];
  const sandboxPage = {
    evaluate: async (fn, arg) => {
      const stage = typeof arg === 'string' ? 'cleanup' : arg?.method ? 'request'
        : arg?.deadlineAt !== undefined ? 'init' : arg?.part !== undefined ? 'upload' : arg?.n !== undefined ? 'download' : 'init';
      evaluations.push({ stage, arg });
      const override = await state.evaluateHook?.(stage, arg);
      if (override) return override;
      // 与当前 SDK 一致：函数不能捕获 helper 变量，第二参经过 JSON 序列化。
      const pageArg = arg === undefined ? undefined : JSON.parse(JSON.stringify(arg));
      const value = await runInNewContext(`(${fn})`, context)(pageArg);
      const size = Buffer.byteLength(JSON.stringify({ page: 1, value }) ?? '');
      if (size > 4000) return { page: 1, path: 'x.txt', writtenToFile: true, contentLength: size };
      return { page: 1, value };
    },
  };
  return { browser: { page: () => sandboxPage }, store, calls, evaluations, context, timers };
}

const q = (o) => ({ id: Math.floor(Math.random() * 1e6), channel: 1, shopName: '店A', unitPrice: 100, taxIncluded: false, itemCondition: 1, leadTime: 1, note: 'n', noStock: false, freeShipping: true, status: 1, attachments: [], ...o });
const baseDetail = (quotes1 = [], quotes2 = [], review = true, extra = {}) => ({
  task: { id: 1, taskCode: 'IQT', itemCount: 2, filledCount: 0, status: 2, remainingMinutes: 60, quoteDeadline: '2026-10-23' },
  items: [
    { id: 1, model: 'ES-M1', quantity: 10, unit: '只', description: 'd'.repeat(1500), inquiryScript: 's', searchKeywords: ['ES-M1', 'Keyence ES-M1'], locked: false, quotes: quotes1, ...extra },
    { id: 2, model: 'GL-VM31FN', quantity: 1, unit: '套', inquiryScript: 's2', searchKeywords: ['GL-VM31FN'], locked: false, quotes: quotes2 },
  ],
  reviewRequired: review,
});
const fresh = [{ itemId: 1, quotes: [{ channel: '淘宝', shopName: '店B', unitPrice: 120.456, taxIncluded: true, taxRate: 13, condition: '', leadTime: '3-5天', note: '新' }] }];
const results = [];
// 写入/核对模式必须在取得页面句柄前校验，不能把字符串 "false" 当作正式提交。
for (const op of ['save', 'verify']) {
  const field = op === 'save' ? 'submit' : 'submitted';
  for (const [label, value] of [['字符串false', 'false'], ['字符串true', 'true'], ['数字0', 0], ['数字1', 1],
    ['null', null], ['对象', {}], ['数组', []], ['省略', undefined]]) {
    const env = makeEnv({ detail: baseDetail() });
    let pages = 0;
    const browser = { page: (...args) => { pages++; return env.browser.page(...args); } };
    const request = { op, taskId: 1, items: fresh, ...(label === '省略' ? {} : { [field]: value }) };
    let output;
    try { output = await erpApi(browser, 1, request); }
    catch (error) { output = { thrown: String(error) }; }
    results.push({ name: `${op}.${field}拒绝${label}且零页面通信/HTTP/PUT`,
      pass: output.error === 'SKILL_INPUT' && output.problems?.some((p) => p.path === field && p.expected === 'boolean')
        && (op !== 'save' || output.writeAttempted === false)
        && pages === 0 && env.evaluations.length === 0 && env.calls.length === 0,
      out: JSON.stringify(output) });
  }
}
const readSnapshot = async (detail) => erpApi(makeEnv({ detail }).browser, 1, { op: 'snapshot', taskId: 1 });
const t = async (name, state, req, check) => {
  const env = makeEnv(state);
  let out;
  try {
    if (['save', 'verify'].includes(req.op) && !Object.hasOwn(req, 'expectedSnapshot')) {
      // 旧用例共用首次读取的基线；结构错误用例模拟读取后 ERP 契约发生变化。
      let initial = await readSnapshot(state.detail || baseDetail());
      if (!initial.ok) initial = await readSnapshot(baseDetail());
      req = { ...req, expectedSnapshot: initial.snapshot };
    }
    out = await erpApi(env.browser, 1, req);
  } catch (e) { out = { thrown: String(e) }; }
  let pass = false;
  try { pass = check(out, state, env) && (req.op !== 'save' || typeof out.writeAttempted === 'boolean'); } catch (e) { pass = false; out.checkError = String(e); }
  results.push({ name, pass, ...(pass ? {} : { out: JSON.stringify(out).slice(0, 600), put: JSON.stringify(state.lastPut || null).slice(0, 600) }) });
};

// 1. 读任务：超过 4KB 的详情能分段取回；新增字段进 extraFields
await t('task 大响应分段 + 新字段', { detail: baseDetail([], [], true, { brandNew: 'x' }) }, { op: 'task', taskId: 1 },
  (o) => o.ok && o.run.items.length === 2 && o.run.items[0].links['淘宝'][1].endsWith('Keyence%20ES-M1') && o.extraFields.includes('detail.data.items[].brandNew'));
// 2. 存草稿：只带原有草稿，不带待审核和已通过的（否则会多出一份草稿）
await t('存草稿不复制待审核/已提交', { detail: baseDetail([q({ status: 3, shopName: '店P' }), q({ status: 2, shopName: '店S' }), q({ status: 1, shopName: '店D' })]) },
  { op: 'save', taskId: 1, submit: false, items: fresh },
  (o, s) => o.ok && s.lastPut.submit === false && JSON.stringify(s.lastPut.items[0].quotes.map((x) => x.shopName)) === JSON.stringify(['店D', '店B']));
// 3. 提交（需要审核）：带草稿和待审核，同店铺草稿优先，不带已通过
await t('提交（审核）保留规则', { detail: baseDetail([q({ status: 3, shopName: '店P', unitPrice: 1 }), q({ status: 1, shopName: '店P', unitPrice: 2 }), q({ status: 2, shopName: '店S' })]) },
  { op: 'save', taskId: 1, submit: true, items: fresh },
  (o, s) => { const qs = s.lastPut.items[0].quotes; return qs.length === 2 && qs[0].shopName === '店P' && qs[0].unitPrice === 2 && qs[1].shopName === '店B'; });
// 4. 提交（不需要审核）：带草稿和已提交，不带待审核；同店铺以本次为准
await t('提交（不审核）保留规则 + 同店替换', { detail: baseDetail([q({ status: 2, shopName: '店S' }), q({ status: 2, shopName: '店B', unitPrice: 9 })], [], false) },
  { op: 'save', taskId: 1, submit: true, items: fresh },
  (o, s) => { const qs = s.lastPut.items[0].quotes; return qs.length === 2 && qs[0].shopName === '店S' && qs[1].shopName === '店B' && qs[1].unitPrice === 120.46 && qs[1].taxRate === 13 && qs[1].itemCondition === 7 && qs[1].leadTime === 4; });
// 5. 提交时其他型号的草稿一并提交
await t('提交带上其他型号草稿', { detail: baseDetail([], [q({ status: 1, shopName: '店X' })]) }, { op: 'save', taskId: 1, submit: true, items: fresh },
  (o, s) => s.lastPut.items.length === 2 && s.lastPut.items[1].itemId === 2 && s.lastPut.items[1].quotes[0].shopName === '店X');
// 6. 存草稿时不带其他型号
await t('存草稿不带其他型号', { detail: baseDetail([], [q({ status: 1, shopName: '店X' })]) }, { op: 'save', taskId: 1, submit: false, items: fresh },
  (o, s) => s.lastPut.items.length === 1);
// 7. 无货
await t('无货', { detail: baseDetail() }, { op: 'save', taskId: 1, submit: false, items: [{ itemId: 2, noStock: true, noStockNote: '问了 3 家无货', quotes: [] }] },
  (o, s) => s.lastPut.items[0].noStock === true && s.lastPut.items[0].quotes.length === 0);
// 8. 不认识的取值、不在任务里的型号 → SKILL_INPUT，不发 PUT
await t('取值不认识被拦下', { detail: baseDetail() }, { op: 'save', taskId: 1, submit: false, items: [{ itemId: 1, quotes: [{ channel: '闲鱼', shopName: 'x', unitPrice: 1, condition: '九成新', leadTime: '1周' }] }, { itemId: 9, quotes: [] }] },
  (o, s) => o.error === 'SKILL_INPUT' && o.problems.length === 4 && !s.lastPut);
// 9. 接口结构变了：缺字段、类型变了、状态码不认识、字典缺取值、接口不存在 → ERP_CONTRACT
const noModel = baseDetail(); delete noModel.items[0].model;
await t('缺字段 → ERP_CONTRACT', { detail: noModel }, { op: 'task', taskId: 1 }, (o) => o.error === 'ERP_CONTRACT' && o.problems[0].path.endsWith('.model'));
const badType = baseDetail(); badType.items[0].quantity = '10';
await t('类型变了 → ERP_CONTRACT', { detail: badType }, { op: 'task', taskId: 1 }, (o) => o.error === 'ERP_CONTRACT' && o.problems[0].actual === 'string');
await t('状态码不认识 → ERP_CONTRACT', { detail: baseDetail([q({ status: 9 })]) }, { op: 'task', taskId: 1 }, (o) => o.error === 'ERP_CONTRACT');
await t('字典缺取值 → ERP_CONTRACT', { detail: baseDetail(), dropLabel: '现货' }, { op: 'task', taskId: 1 }, (o) => o.error === 'ERP_CONTRACT' && o.endpoint === 'dict');
await t('接口不存在 → ERP_CONTRACT', { detail: baseDetail(), http404: true }, { op: 'task', taskId: 1 }, (o) => o.error === 'ERP_CONTRACT');
await t('提交前发现结构变了不发 PUT', { detail: noModel }, { op: 'save', taskId: 1, submit: true, items: fresh }, (o, s) => o.error === 'ERP_CONTRACT' && !s.lastPut);
// 10. ERP 拒绝 → ERP_BIZ
await t('ERP 拒绝 → ERP_BIZ', { detail: baseDetail(), putReply: { code: 400, message: 'ES-M1 的货期不在可选值内' } }, { op: 'save', taskId: 1, submit: true, items: fresh },
  (o) => o.error === 'ERP_BIZ' && o.message.includes('货期'));
// 11. 令牌过期：能续期就续期并写回原位置；续不了 → ERP_LOGIN
await t('令牌过期续期', { detail: baseDetail(), expireT1: true, refreshOk: true }, { op: 'ping' }, (o, s, env) => o.ok && env.store.local.zhul_token === 'T2');
await t('续期失败 → ERP_LOGIN', { detail: baseDetail(), expireT1: true, refreshOk: false }, { op: 'ping' }, (o) => o.error === 'ERP_LOGIN');
// 12. 核对：一致、不一致、提交后仍有草稿、待审核算成功
const live = [q({ status: 3, channel: 1, shopName: '店B', unitPrice: 120.46, taxIncluded: true, taxRate: 13, itemCondition: 7, leadTime: 4, note: '新' })];
await t('核对一致（待审核算成功）', { detail: baseDetail(live), filled: 1 }, { op: 'verify', taskId: 1, submitted: true, items: fresh },
  (o) => o.ok && o.mismatches.length === 0 && o.inDoneList === false && o.filledCount === 1);
await t('核对发现单价不一致', { detail: baseDetail([{ ...live[0], unitPrice: 121 }]) }, { op: 'verify', taskId: 1, submitted: true, items: fresh },
  (o) => !o.ok && o.mismatches[0].problem.includes('单价'));
await t('核对发现提交后仍有草稿', { detail: baseDetail([...live, q({ status: 1, shopName: '店Z' })]) }, { op: 'verify', taskId: 1, submitted: true, items: fresh },
  (o) => !o.ok && o.mismatches.some((m) => m.problem === '提交后仍有草稿'));
await t('不需审核时待审核不算', { detail: baseDetail(live, [], false) }, { op: 'verify', taskId: 1, submitted: true, items: fresh },
  (o) => !o.ok && o.mismatches[0].problem === '没有找到这条报价');
await t('不需审核部分提交仍待处理且已填数含跳过草稿', { detail: baseDetail([{ ...live[0], status: 2 }], [q({ status: 1 })], false), filled: 2 },
  { op: 'verify', taskId: 1, submitted: true, items: fresh, skipItemIds: [2] },
  (o) => o.ok && o.mismatches.length === 0 && o.inDoneList === false && o.filledCount === 2 && o.itemCount === 2 && JSON.stringify(o.verifiedItemIds) === '[1]');
const lockedObservation = baseDetail([{ ...live[0], status: 2 }], [q({ status: 2 })], false);
lockedObservation.items[1].locked = true;
await t('不需审核核对锁定型号外的写入不以列表已填数判失败', { detail: lockedObservation, filled: 2 },
  { op: 'verify', taskId: 1, submitted: true, items: fresh },
  (o) => o.ok && o.inDoneList === false && o.filledCount === 2 && JSON.stringify(o.verifiedItemIds) === '[1]');
await t('已回价且已填满不能掩盖报价核对差异', { detail: baseDetail([{ ...live[0], status: 2, unitPrice: 121 }], [], false), done: true, filled: 2 },
  { op: 'verify', taskId: 1, submitted: true, items: fresh },
  (o) => !o.ok && o.inDoneList === true && o.filledCount === 2 && o.mismatches.some((m) => m.problem.includes('单价')));
// 13. 包邮：没写按包邮，店家说不包邮时提交 false；核对包邮是否一致
const noFree = [{ itemId: 1, quotes: [{ ...fresh[0].quotes[0], freeShipping: false }] }];
await t('包邮默认 true，不包邮传 false', { detail: baseDetail() }, { op: 'save', taskId: 1, submit: false, items: [{ itemId: 1, quotes: [fresh[0].quotes[0], { ...noFree[0].quotes[0], shopName: '店C' }] }] },
  (o, s) => o.ok && s.lastPut.items[0].quotes[0].freeShipping === true && s.lastPut.items[0].quotes[1].freeShipping === false);
await t('核对发现包邮不一致', { detail: baseDetail(live) }, { op: 'verify', taskId: 1, submitted: true, items: noFree },
  (o) => !o.ok && o.mismatches[0].problem.includes('包邮'));
await t('核对不包邮一致', { detail: baseDetail([{ ...live[0], freeShipping: false }]) }, { op: 'verify', taskId: 1, submitted: true, items: noFree },
  (o) => o.ok && o.mismatches.length === 0);
// 14. 页面通信异常不抛出
const broken = { page: () => ({ evaluate: async () => { throw new Error('No tab with given id'); } }) };
let brokenOut; try { brokenOut = await erpApi(broken, 1, { op: 'ping' }); } catch (e) { brokenOut = { thrown: String(e) }; }
results.push({ name: '标签页关了不抛出', pass: brokenOut.error === 'ERP_HTTP', ...(brokenOut.error === 'ERP_HTTP' ? {} : { out: JSON.stringify(brokenOut) }) });

// 15. 独立复核：保留附件、按 itemId 分别更新同名型号，以及核对输入和无货边界
await t('同店更新保留原有附件和不包邮', { detail: baseDetail([q({ shopName: '店B', freeShipping: false, attachments: [{ id: 101 }] })]) },
  { op: 'save', taskId: 1, submit: false, items: noFree },
  (o, s) => o.ok && s.lastPut.items[0].quotes[0].freeShipping === false && JSON.stringify(s.lastPut.items[0].quotes[0].attachmentIds) === '[101]');
await t('其他店原报价附件及供应商信息保留', { detail: baseDetail([q({ channel: 4, shopName: '原供应商', supplierId: 88, freeShipping: false, recommended: true, attachments: [{ id: 102 }, { id: 103 }] })], [], false) },
  { op: 'save', taskId: 1, submit: true, items: fresh },
  (o, s) => { const old = s.lastPut.items[0].quotes[0]; return o.ok && old.supplierId === 88 && old.recommended === true && old.freeShipping === false && JSON.stringify(old.attachmentIds) === '[102,103]'; });
await t('同店附件继承草稿优先且不混入已通过', { detail: baseDetail([q({ shopName: '店B', status: 3, attachments: [{ id: 104 }] }), q({ shopName: '店B', status: 1, attachments: [{ id: 105 }] }), q({ shopName: '店B', status: 2, attachments: [{ id: 106 }] })]) },
  { op: 'save', taskId: 1, submit: true, items: fresh },
  (o, s) => o.ok && JSON.stringify(s.lastPut.items[0].quotes[0].attachmentIds) === '[105]');
await t('存草稿不移走原已提交附件', { detail: baseDetail([q({ shopName: '店B', status: 2, attachments: [{ id: 107 }] })], [], false) },
  { op: 'save', taskId: 1, submit: false, items: fresh },
  (o, s) => o.ok && s.lastPut.items[0].quotes[0].attachmentIds.length === 0);
await t('不需审核提交继承被替换的已提交附件', { detail: baseDetail([q({ shopName: '店B', status: 2, attachments: [{ id: 108 }] })], [], false) },
  { op: 'save', taskId: 1, submit: true, items: fresh },
  (o, s) => o.ok && JSON.stringify(s.lastPut.items[0].quotes[0].attachmentIds) === '[108]');
await t('大请求分段保留每条包邮值', { detail: baseDetail() },
  { op: 'save', taskId: 1, submit: false, items: [{ itemId: 1, quotes: Array.from({ length: 16 }, (_, i) => ({ ...fresh[0].quotes[0], shopName: `店${i}`, note: '报价备注'.repeat(75), freeShipping: i % 2 === 0 })) }] },
  (o, s) => o.ok && Buffer.byteLength(JSON.stringify(s.lastPut)) > 4000 && s.lastPut.items[0].quotes.length === 16 && s.lastPut.items[0].quotes.every((q, i) => q.freeShipping === (i % 2 === 0)));
const sameModel = baseDetail(); sameModel.items[1].model = sameModel.items[0].model;
await t('同名多型号按 itemId 分别填报', { detail: sameModel },
  { op: 'save', taskId: 1, submit: false, items: [{ itemId: 2, quotes: [{ ...fresh[0].quotes[0], unitPrice: 222, freeShipping: false }] }, ...fresh] },
  (o, s) => o.ok && s.lastPut.items[0].itemId === 2 && s.lastPut.items[0].quotes[0].unitPrice === 222 && s.lastPut.items[1].itemId === 1 && s.lastPut.items[1].quotes[0].unitPrice === 120.46);
await t('本次无货保留原有正常报价', { detail: baseDetail([q({ status: 1 })]) },
  { op: 'save', taskId: 1, submit: true, items: [{ itemId: 1, noStock: true, quotes: [] }] },
  (o, s) => o.ok && !s.lastPut.items[0].noStock && s.lastPut.items[0].quotes[0].shopName === '店A');
await t('核对无货允许保留原有正常报价', { detail: baseDetail([q({ status: 3 })]) },
  { op: 'verify', taskId: 1, submitted: true, items: [{ itemId: 1, noStock: true, quotes: [] }] },
  (o) => o.ok);
await t('核对真实无货通过', { detail: baseDetail([q({ status: 3, noStock: true, unitPrice: undefined })]) },
  { op: 'verify', taskId: 1, submitted: true, items: [{ itemId: 1, noStock: true, noStockNote: 'n', quotes: [] }] }, (o) => o.ok);
await t('核对非法税率不能假成功', { detail: baseDetail([{ ...live[0], taxRate: 1 }]) },
  { op: 'verify', taskId: 1, submitted: true, items: [{ itemId: 1, quotes: [{ ...fresh[0].quotes[0], taxRate: 1 }] }] },
  (o) => o.error === 'SKILL_INPUT' && o.problems.some((p) => p.path.endsWith('.taxRate')));
await t('核对按 itemId 不借用其他型号报价', { detail: baseDetail(live) },
  { op: 'verify', taskId: 1, submitted: true, items: [{ itemId: 2, quotes: fresh[0].quotes }] },
  (o) => !o.ok && o.mismatches[0].itemId === 2 && o.mismatches[0].problem === '没有找到这条报价');
// 16. HTTP、JSON 和契约边界：全用 mock，无真实接口
await t('网络异常 → ERP_HTTP', { networkError: true }, { op: 'ping' }, (o) => o.error === 'ERP_HTTP');
await t('HTTP 500 即使 JSON 成功也失败', { httpReply: { http: 500, text: '{"code":0,"data":[]}' } }, { op: 'ping' }, (o) => o.error === 'ERP_HTTP');
await t('非 JSON → ERP_HTTP', { httpReply: { http: 200, text: '<html>unavailable</html>' } }, { op: 'ping' }, (o) => o.error === 'ERP_HTTP');
await t('HTTP 405 → ERP_CONTRACT', { httpReply: { http: 405, text: '{}' } }, { op: 'ping' }, (o) => o.error === 'ERP_CONTRACT');
await t('成功 JSON 外层缺 code → ERP_CONTRACT', { httpReply: { http: 200, text: '{"data":[]}' } }, { op: 'ping' }, (o) => o.error === 'ERP_CONTRACT');
await t('HTTP 400 业务错误 → ERP_BIZ', { httpReply: { http: 400, text: '{"code":400,"message":"mock invalid"}' } }, { op: 'ping' }, (o) => o.error === 'ERP_BIZ');

// 17. 故障无价型号由 records 显式排除，不能被自动带上的旧草稿重新提交
for (const noStock of [false, true]) {
  await t(`skipItemIds 保留故障型号旧${noStock ? '无货' : '正常'}草稿`, { detail: baseDetail([], [q({ status: 1, noStock })]) },
    { op: 'save', taskId: 1, submit: true, items: fresh, skipItemIds: [2] },
    (o, s) => o.ok && s.lastPut.items.length === 1 && s.lastPut.items[0].itemId === 1);
}
for (const op of ['save', 'verify']) {
  for (const [label, skipItemIds] of [['未知型号', [99]], ['字符串ID', ['2']], ['null', null], ['重复ID', [2, 2]], ['与items重叠', [1]], ['非数组', 2]]) {
    await t(`${op} 拒绝skipItemIds ${label}`, { detail: baseDetail(live) },
      { op, taskId: 1, submit: true, submitted: true, items: fresh, skipItemIds },
      (o, s) => o.error === 'SKILL_INPUT' && o.problems.some((p) => p.path.startsWith('skipItemIds')) && !s.lastPut);
  }
  for (const [label, unitPrice] of [['null', null], ['空字符串', ''], ['空白', ' '], ['布尔', false], ['数组', []], ['NaN', NaN], ['Infinity', Infinity], ['含单位文字', '100元'], ['四舍五入前负数', -0.001]]) {
    await t(`${op} 拒绝非法单价 ${label}`, { detail: baseDetail(live) },
      { op, taskId: 1, submit: false, submitted: true, items: [{ itemId: 1, quotes: [{ ...fresh[0].quotes[0], unitPrice }] }] },
      (o, s) => o.error === 'SKILL_INPUT' && o.problems.some((p) => p.path.endsWith('.unitPrice')) && !s.lastPut);
  }
}
await t('合法数字字符串及明确零价仍可保存', { detail: baseDetail() },
  { op: 'save', taskId: 1, submit: false, items: [{ itemId: 1, quotes: [{ ...fresh[0].quotes[0], unitPrice: '120.456' }, { ...fresh[0].quotes[0], shopName: '零价店', unitPrice: 0 }] }] },
  (o, s) => o.ok && s.lastPut.items[0].quotes[0].unitPrice === 120.46 && s.lastPut.items[0].quotes[1].unitPrice === 0);
await t('verify允许排除型号保留未提交草稿', { detail: baseDetail(live, [q({ status: 1, noStock: true })]) },
  { op: 'verify', taskId: 1, submitted: true, items: fresh, skipItemIds: [2] }, (o) => o.ok);
await t('全空items且排除旧草稿不发PUT', { detail: baseDetail([], [q({ status: 1, noStock: true })]) },
  { op: 'save', taskId: 1, submit: true, items: [], skipItemIds: [2] },
  (o, s) => o.error === 'SKILL_INPUT' && !s.lastPut);

// 18. 恢复用只读业务快照；保存必须使用持久化基线，不以当前读取覆盖外部变动。
const snapshotDetail = baseDetail([q({ id: 201, supplierId: 88, status: 1, attachments: [{ id: 12, url: 'secret-url' }, { id: 11 }], accessToken: 'secret-token', attachmentIds: 'secret-unknown-field' }),
  q({ id: 202, status: 2 }), q({ id: 203, status: 3, noStock: true, unitPrice: undefined })]);
snapshotDetail.items[1].locked = true;
snapshotDetail.items[0].itemId = 999;
await t('snapshot返回草稿/已提交/待审核业务字段与附件ID，忽略未知敏感值', { detail: snapshotDetail },
  { op: 'snapshot', taskId: 1 }, (o, s, env) => o.ok && o.snapshot.taskId === 1 && o.snapshot.items[1].locked
    && o.snapshot.items[0].quotes[0].supplierId === 88 && o.snapshot.items[0].quotes[2].unitPrice === null
    && JSON.stringify(o.snapshot.items[0].quotes.map((x) => x.status)) === '[1,2,3]'
    && JSON.stringify(o.snapshot.items[0].quotes[0].attachmentIds) === '[11,12]'
    && !JSON.stringify(o).includes('secret-') && !JSON.stringify(o).includes('T1')
    && env.calls.length === 1 && env.calls[0].method === 'GET');
await t('task同时提供兼容状态文字和完整snapshot', { detail: snapshotDetail }, { op: 'task', taskId: 1 },
  (o) => o.ok && JSON.stringify(o.run.items[0].existingQuotes) === '["草稿","已提交","待审核"]' && o.snapshot.items[0].quotes[0].id === 201);
for (const expectedSnapshot of [undefined, null, {}, { taskId: 1, items: [] }]) {
  await t('缺失或不完整expectedSnapshot拒绝保存', { detail: baseDetail() },
    { op: 'save', taskId: 1, submit: false, items: fresh, expectedSnapshot },
    (o, s, env) => o.error === 'SKILL_INPUT' && o.problems[0].path.startsWith('expectedSnapshot') && !s.lastPut && env.calls.length === 0);
}
const beforeDetail = baseDetail([q({ id: 301, attachments: [{ id: 10 }] })], [q({ id: 302, shopName: '店X' })]);
const persisted = (await readSnapshot(beforeDetail)).snapshot;
const fieldChanges = { id: 999, channel: 2, shopName: '人工店名', supplierId: 5, unitPrice: 999, taxIncluded: true,
  taxRate: 3, itemCondition: 2, leadTime: 2, note: '人工备注', noStock: true, freeShipping: false, recommended: true,
  status: 2, attachments: [{ id: 99 }] };
for (const [field, value] of Object.entries(fieldChanges)) {
  const detail = structuredClone(beforeDetail);
  detail.items[0].quotes[0][field] = value;
  await t(`基线漂移${field}拒绝PUT`, { detail },
    { op: 'save', taskId: 1, submit: false, items: fresh, expectedSnapshot: persisted },
    (o, s) => o.error === 'ERP_CONFLICT' && o.conflicts.some((x) => x.itemId === 1) && !s.lastPut);
}
const changedOther = structuredClone(beforeDetail); changedOther.items[1].quotes[0].note = '人工改另一型号';
await t('部分平台草稿仅检查实际写入型号，不标其他型号无货', { detail: changedOther },
  { op: 'save', taskId: 1, submit: false, items: fresh, expectedSnapshot: persisted },
  (o, s) => o.ok && s.lastPut.items.length === 1 && s.lastPut.items[0].itemId === 1 && !s.lastPut.items[0].noStock);
await t('提交自动带入其他型号草稿也必须检查基线', { detail: changedOther },
  { op: 'save', taskId: 1, submit: true, items: fresh, expectedSnapshot: persisted },
  (o, s) => o.error === 'ERP_CONFLICT' && o.conflicts.some((x) => x.itemId === 2) && !s.lastPut);
await t('显式排除其他型号仍保留其ERP修改', { detail: changedOther },
  { op: 'save', taskId: 1, submit: true, items: fresh, skipItemIds: [2], expectedSnapshot: persisted },
  (o, s) => o.ok && s.lastPut.items.length === 1);
const deletedQuote = structuredClone(beforeDetail); deletedQuote.items[0].quotes = [];
await t('人工删除报价也拒绝恢复覆盖', { detail: deletedQuote },
  { op: 'save', taskId: 1, submit: false, items: fresh, expectedSnapshot: persisted },
  (o, s) => o.error === 'ERP_CONFLICT' && !s.lastPut);
for (const [field, value] of [['taskId', 9], ['task', 'OTHER'], ['reviewRequired', false], ['editable', false]]) {
  await t(`任务基线${field}漂移拒绝PUT`, { detail: beforeDetail },
    { op: 'save', taskId: 1, submit: false, items: fresh, expectedSnapshot: { ...persisted, [field]: value } },
    (o, s) => o.error === 'ERP_CONFLICT' && o.conflicts.some((x) => x.path === `snapshot.${field}`) && !s.lastPut);
}
const reordered = structuredClone(beforeDetail);
reordered.items.reverse(); reordered.items[1].quotes[0].attachments.push({ id: 9 });
const orderBaseline = (await readSnapshot(reordered)).snapshot;
reordered.items[1].quotes[0].attachments.reverse(); reordered.items[1].quotes[0].quotedAt = 'new-time';
await t('型号附件顺序与非业务时间变化不误报冲突', { detail: reordered },
  { op: 'save', taskId: 1, submit: false, items: fresh, expectedSnapshot: orderBaseline }, (o) => o.ok);
await t('提交结果未知只verify，返回同次读回快照且无PUT', { detail: baseDetail(live), filled: 1 },
  { op: 'verify', taskId: 1, submitted: true, items: fresh },
  (o, s, env) => o.ok && o.snapshot.items[0].quotes[0].status === 3 && !s.lastPut && env.calls.every((c) => c.method === 'GET'));

// 19. 只有明确未进入 PUT 的返回才允许修复后重试；进入 PUT 后即使报错也不推断未写入。
const writeReq = { op: 'save', taskId: 1, submit: true, items: fresh };
const noWrite = (o, s, env) => o.writeAttempted === false && !s.lastPut && !env.calls.some((c) => c.method === 'PUT');
await t('GET字典登录失败writeAttempted=false且0PUT', { detail: baseDetail(), expireT1: true }, writeReq,
  (o, s, env) => o.error === 'ERP_LOGIN' && noWrite(o, s, env));
await t('GET详情登录失败writeAttempted=false且0PUT', { detail: baseDetail(), detailReply: { http: 401, json: { code: 401 } } }, writeReq,
  (o, s, env) => o.error === 'ERP_LOGIN' && noWrite(o, s, env));
for (const expectedSnapshot of [undefined, { ...persisted, taskId: '1' }]) {
  await t('缺失或错类型snapshot为false且0PUT', { detail: baseDetail() }, { ...writeReq, expectedSnapshot },
    (o, s, env) => o.error === 'SKILL_INPUT' && noWrite(o, s, env));
}
await t('过期snapshot冲突为false且0PUT', { detail: changedOther }, { ...writeReq, expectedSnapshot: persisted },
  (o, s, env) => o.error === 'ERP_CONFLICT' && noWrite(o, s, env));
await t('GET业务拒绝为false且0PUT', { detail: baseDetail(), detailReply: { http: 400, json: { code: 400, message: 'mock GET refused' } } }, writeReq,
  (o, s, env) => o.error === 'ERP_BIZ' && noWrite(o, s, env));
await t('PUT网络失败writeAttempted=true', { detail: baseDetail(), putNetworkError: true }, writeReq,
  (o, s, env) => o.error === 'ERP_HTTP' && o.writeAttempted === true && env.calls.filter((c) => c.method === 'PUT').length === 1);
await t('PUT业务拒绝writeAttempted=true', { detail: baseDetail(), putReply: { code: 400, message: 'mock PUT refused' } }, writeReq,
  (o, s, env) => o.error === 'ERP_BIZ' && o.writeAttempted === true && env.calls.filter((c) => c.method === 'PUT').length === 1);
await t('PUT响应契约错误writeAttempted=true', { detail: baseDetail(), putReply: { message: 'missing code' } }, writeReq,
  (o, s, env) => o.error === 'ERP_CONTRACT' && o.writeAttempted === true && env.calls.filter((c) => c.method === 'PUT').length === 1);
await t('PUT成功writeAttempted=true', { detail: baseDetail() }, writeReq,
  (o, s, env) => o.ok && o.writeAttempted === true && env.calls.filter((c) => c.method === 'PUT').length === 1);

// 20. 会话过期的读取可续期；业务 PUT 一旦进入发送不能靠 401 推断未写入或自动重发。
const refreshes = (env) => env.calls.filter((c) => c.url === '/api/v1/auth/refresh').length;
await t('session令牌优先且续期只回写session原位置', { detail: baseDetail(), store: { local: { zhul_token: 'OLD' }, session: { akt: 'T1' } }, expireT1: true, refreshOk: true },
  { op: 'ping' }, (o, s, env) => o.ok && env.store.session.akt === 'T2' && env.store.local.zhul_token === 'OLD' && refreshes(env) === 1);
await t('无令牌直接ERP_LOGIN且不请求接口', { store: { local: {}, session: {} } }, { op: 'ping' },
  (o, s, env) => o.error === 'ERP_LOGIN' && o.reason === 'no-token' && env.calls.length === 0);
await t('续期后仍401不循环续期', { expireAll: true, refreshOk: true }, { op: 'ping' },
  (o, s, env) => o.error === 'ERP_LOGIN' && refreshes(env) === 1 && env.calls.length === 3);
for (const [label, extra] of [
  ['网络失败', { refreshError: true }],
  ['非JSON', { refreshReply: { http: 200, text: '<html>login</html>' } }],
  ['错误HTTP即使code0', { refreshReply: { http: 500, text: '{"code":0,"data":{"accessToken":"T2"}}' } }],
  ['令牌类型错误', { refreshReply: { http: 200, text: '{"code":0,"data":{"accessToken":123}}' } }],
]) {
  await t(`续期${label}不污染令牌`, { expireT1: true, ...extra }, { op: 'ping' },
    (o, s, env) => o.error === 'ERP_LOGIN' && env.store.local.zhul_token === 'T1' && env.calls.length === 2);
}
await t('save前GET过期可续期且业务PUT恰好一次', { detail: baseDetail(), expireT1: true, refreshOk: true }, writeReq,
  (o, s, env) => o.ok && o.writeAttempted === true && refreshes(env) === 1 && env.calls.filter((c) => c.method === 'PUT').length === 1);
await t('续期成功后GET网络失败为ERP_HTTP而非登录失败', { expireT1: true, refreshOk: true, networkAfterRefresh: true }, { op: 'ping' },
  (o, s, env) => o.error === 'ERP_HTTP' && env.store.local.zhul_token === 'T2' && refreshes(env) === 1 && env.calls.length === 3);
for (const submit of [false, true]) {
  await t(`${submit ? '提交' : '草稿'}PUT401不续期重发`, { detail: baseDetail(), put401: true, refreshOk: true }, { ...writeReq, submit },
    (o, s, env) => o.error === 'ERP_LOGIN' && o.writeAttempted === true && refreshes(env) === 0 && env.calls.filter((c) => c.method === 'PUT').length === 1);
}
await t('verify过期自动续期仅GET及refresh无PUT', { detail: baseDetail(live), expireT1: true, refreshOk: true },
  { op: 'verify', taskId: 1, submitted: true, items: fresh },
  (o, s, env) => o.ok && refreshes(env) === 1 && env.calls.every((c) => c.method !== 'PUT'));
await t('verify续期失败保留ERP_LOGIN且不写入', { detail: baseDetail(live), expireT1: true },
  { op: 'verify', taskId: 1, submitted: true, items: fresh },
  (o, s, env) => o.error === 'ERP_LOGIN' && env.calls.every((c) => c.method !== 'PUT'));
await t('HTTP200/code401读取续期后成功', { expireT1: true, authHttp: 200, refreshOk: true }, { op: 'ping' },
  (o, s, env) => o.ok && refreshes(env) === 1 && env.store.local.zhul_token === 'T2');
await t('HTTP200/code401续期失败返回ERP_LOGIN', { expireT1: true, authHttp: 200 }, { op: 'ping' },
  (o, s, env) => o.error === 'ERP_LOGIN' && refreshes(env) === 1);
await t('PUT HTTP200/code401不续期重发', { detail: baseDetail(), put401: true, authHttp: 200, refreshOk: true }, writeReq,
  (o, s, env) => o.error === 'ERP_LOGIN' && o.writeAttempted === true && refreshes(env) === 0 && env.calls.filter((c) => c.method === 'PUT').length === 1);

// 21. 原提交基线决定全体写入范围；其他型号旧草稿与同型号旧店也不能漏验。
const carried = q({ id: 501, shopName: '原草稿店', note: '原备注', attachments: [{ id: 90 }] });
const fullBaseline = (await readSnapshot(baseDetail([], [carried]))).snapshot;
await t('提交核对发现自动带入的其他型号仍草稿', { detail: baseDetail(live, [carried]) },
  { op: 'verify', taskId: 1, submitted: true, items: fresh, expectedSnapshot: fullBaseline },
  (o) => !o.ok && o.mismatches.some((m) => m.itemId === 2 && m.problem === '提交后仍有草稿'));
await t('提交核对发现自动带入的旧报价遗失', { detail: baseDetail(live) },
  { op: 'verify', taskId: 1, submitted: true, items: fresh, expectedSnapshot: fullBaseline },
  (o) => !o.ok && o.mismatches.some((m) => m.itemId === 2));
await t('提交核对发现同型号保留旧报价遗失', { detail: baseDetail(live) },
  { op: 'verify', taskId: 1, submitted: true, items: fresh, expectedSnapshot: (await readSnapshot(baseDetail([carried]))).snapshot },
  (o) => !o.ok && o.mismatches.some((m) => m.shop === carried.shopName));
await t('提交核对发现原附件遗失', { detail: baseDetail(live, [{ ...carried, status: 3, attachments: [] }]) },
  { op: 'verify', taskId: 1, submitted: true, items: fresh, expectedSnapshot: fullBaseline },
  (o) => !o.ok && o.mismatches.some((m) => m.itemId === 2 && m.problem.includes('附件')));
await t('完整提交旧草稿内容与附件正确通过', { detail: baseDetail(live, [{ ...carried, status: 3 }]) },
  { op: 'verify', taskId: 1, submitted: true, items: fresh, expectedSnapshot: fullBaseline }, (o) => o.ok);
for (const submitted of [false, true]) {
  for (const expectedSnapshot of [undefined, null, {}]) {
    await t('核对缺原持久化基线不读取也不假成功', { detail: baseDetail(live) },
      { op: 'verify', taskId: 1, submitted, items: fresh, expectedSnapshot },
      (o, s, env) => o.error === 'SKILL_INPUT' && env.calls.length === 0);
  }
}
await t('部分草稿核对不把其他型号草稿算已写入', { detail: baseDetail([{ ...live[0], status: 1 }], [carried]) },
  { op: 'verify', taskId: 1, submitted: false, items: fresh, expectedSnapshot: fullBaseline },
  (o) => o.ok && JSON.stringify(o.verifiedItemIds) === '[1]');
await t('草稿核对发现保留旧店报价遗失', { detail: baseDetail([{ ...live[0], status: 1 }]) },
  { op: 'verify', taskId: 1, submitted: false, items: fresh, expectedSnapshot: (await readSnapshot(baseDetail([carried]))).snapshot },
  (o) => !o.ok && o.mismatches.some((m) => m.shop === carried.shopName));
await t('核对缺原无货说明不能假成功', { detail: baseDetail([q({ status: 3, noStock: true, unitPrice: undefined, note: '错误说明' })]) },
  { op: 'verify', taskId: 1, submitted: true, items: [{ itemId: 1, noStock: true, noStockNote: '原无货说明', quotes: [] }], expectedSnapshot: (await readSnapshot(baseDetail())).snapshot },
  (o) => !o.ok && o.mismatches.some((m) => m.problem === '无货说明不一致'));
for (const [submitted, review, status] of [[false, true, 1], [true, true, 3], [true, false, 2]]) {
  await t('核对拒绝本次替换状态桶额外报价', { detail: baseDetail([{ ...live[0], status }, q({ status, shopName: '意外店' })], [], review) },
    { op: 'verify', taskId: 1, submitted, items: fresh, expectedSnapshot: (await readSnapshot(baseDetail([], [], review))).snapshot },
    (o) => !o.ok && o.mismatches.some((m) => m.problem === '本次写入状态中有额外报价行'));
  await t('核对拒绝同店重复报价即使第一条正确', { detail: baseDetail([{ ...live[0], status }, { ...live[0], id: 999, status, unitPrice: 999 }], [], review) },
    { op: 'verify', taskId: 1, submitted, items: fresh, expectedSnapshot: (await readSnapshot(baseDetail([], [], review))).snapshot },
    (o) => !o.ok && o.mismatches.some((m) => m.problem === '本次写入状态中有重复报价行'));
}
await t('无货草稿不能与额外有价行同时核对成功', { detail: baseDetail([q({ status: 1, noStock: true, unitPrice: undefined, note: '无货' }), q({ status: 1, shopName: '意外有货店' })]) },
  { op: 'verify', taskId: 1, submitted: false, items: [{ itemId: 1, noStock: true, noStockNote: '无货', quotes: [] }], expectedSnapshot: (await readSnapshot(baseDetail())).snapshot },
  (o) => !o.ok && o.mismatches.some((m) => m.problem === '本次写入状态中有额外报价行'));
await t('审核流同店旧已通过版本合法保留且核对新待审核版本', { detail: baseDetail([q({ ...live[0], id: 10, status: 2, unitPrice: 99 }), { ...live[0], id: 11 }]) },
  { op: 'verify', taskId: 1, submitted: true, items: fresh, expectedSnapshot: (await readSnapshot(baseDetail([q({ ...live[0], id: 10, status: 2, unitPrice: 99 })]))).snapshot },
  (o) => o.ok);
await t('非审核流明确保留的原推荐标记丢失不能假成功', { detail: baseDetail([{ ...live[0], status: 2 }, { ...carried, status: 2, recommended: false }], [], false) },
  { op: 'verify', taskId: 1, submitted: true, items: fresh, expectedSnapshot: (await readSnapshot(baseDetail([{ ...carried, recommended: true }], [], false))).snapshot },
  (o) => !o.ok && o.mismatches.some((m) => m.problem === '原推荐标记未保留'));
await t('未指定推荐的新报价允许ERP自动推荐', { detail: baseDetail([{ ...live[0], status: 2, recommended: true }], [], false) },
  { op: 'verify', taskId: 1, submitted: true, items: fresh, expectedSnapshot: (await readSnapshot(baseDetail([], [], false))).snapshot },
  (o) => o.ok);
for (const submit of [false, true]) {
  const state = { detail: baseDetail([], [carried]), putApplyThenError: true, refreshOk: true };
  const env = makeEnv(state);
  const payload = { taskId: 1, items: fresh, expectedSnapshot: (await readSnapshot(state.detail)).snapshot };
  const saved = await erpApi(env.browser, 1, { op: 'save', ...payload, submit });
  // 恢复读取时 token 也已过期，依旧只能续期 GET 后核对原 payload。
  state.expireT1 = true;
  const verified = await erpApi(env.browser, 1, { op: 'verify', ...payload, submitted: submit });
  results.push({ name: `${submit ? '提交' : '草稿'}PUT服务端已写入但丢回包，登录恢复后只读核对完整范围`,
    pass: saved.error === 'ERP_HTTP' && saved.writeAttempted === true && verified.ok
      && JSON.stringify(verified.verifiedItemIds) === (submit ? '[1,2]' : '[1]')
      && env.calls.filter((c) => c.method === 'PUT').length === 1 && refreshes(env) === 1 });
}

// 22. 真实异步故障：页面隔离、fetch取消、分段失败、宿主通信挂起和TTL兜底。
const noSlots = (env) => Object.keys(env.context.window.__erpApi || {}).length === 0 && env.timers.size === 0;
const fault = async (name, state, request, check) => {
  const env = makeEnv(state);
  const started = Date.now();
  let output;
  try {
    output = await fastErpApi(env.browser, 1, request);
    const pass = await check(output, env, Date.now() - started);
    results.push({ name, pass: !!pass, ...(pass ? {} : { out: JSON.stringify(output) }) });
  } catch (error) { results.push({ name, pass: false, out: String(error) }); }
};
const hangingFetch = (url, opts) => new Promise((resolve, reject) => {
  if (!opts.signal) { reject(new Error('missing AbortSignal')); return; }
  const abort = () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); };
  if (opts.signal.aborted) abort();
  else opts.signal.addEventListener('abort', abort, { once: true });
});
await fault('挂起GET实际被AbortController取消并清理', { fetchHook: hangingFetch }, { op: 'ping' },
  (o, env, elapsed) => o.error === 'ERP_HTTP' && elapsed < 200 && env.calls.length === 1 && noSlots(env));
await fault('挂起refresh取消属于ERP_HTTP且不污染令牌', { expireT1: true,
  fetchHook: (url, opts) => url === '/api/v1/auth/refresh' ? hangingFetch(url, opts) : undefined }, { op: 'ping' },
  (o, env) => o.error === 'ERP_HTTP' && env.store.local.zhul_token === 'T1'
    && env.calls.length === 2 && noSlots(env));
const faultBaseline = (await readSnapshot(baseDetail())).snapshot;
await fault('挂起PUT取消后writeAttempted为true且绝不重放', { detail: baseDetail(),
  fetchHook: (url, opts) => opts.method === 'PUT' ? hangingFetch(url, opts) : undefined },
  { op: 'save', taskId: 1, submit: false, items: fresh, expectedSnapshot: faultBaseline },
  (o, env) => o.error === 'ERP_HTTP' && o.writeAttempted === true
    && env.calls.filter((c) => c.method === 'PUT').length === 1 && noSlots(env));
for (const stage of ['upload', 'download']) {
  await fault(`${stage}异步故障finally清理且异常令牌不输出`, { detail: baseDetail(),
    evaluateHook: async (actual) => { if (actual === stage) { await delay(1); throw new Error('T1 sensitive context'); } } },
    stage === 'upload' ? { op: 'save', taskId: 1, submit: false, items: [{ itemId: 1, quotes: Array.from({ length: 5 }, (_, n) => ({ ...fresh[0].quotes[0], shopName: `长报文店${n}`, note: '备注'.repeat(100) })) }], expectedSnapshot: faultBaseline } : { op: 'task', taskId: 1 },
    (o, env) => o.error === 'ERP_HTTP' && !JSON.stringify(o).includes('T1') && noSlots(env)
      && (stage !== 'upload' || o.writeAttempted === true && env.calls.every((c) => c.method !== 'PUT')));
}
await fault('evaluate仅返回文件引用也执行finally清理', { detail: baseDetail(),
  evaluateHook: async (stage) => { if (stage === 'download') { await delay(1); return { writtenToFile: true }; } } },
  { op: 'snapshot', taskId: 1 }, (o, env) => o.error === 'ERP_HTTP' && noSlots(env));
await fault('宿主evaluate永久挂起有界返回并清理已建槽', {
  evaluateHook: (stage) => stage === 'request' ? new Promise(() => {}) : undefined }, { op: 'ping' },
  (o, env, elapsed) => o.error === 'ERP_HTTP' && elapsed < 200 && env.calls.length === 0 && noSlots(env));
await fault('cleanup通信挂起不拖住结果且页面TTL自行释放', {
  evaluateHook: (stage) => stage === 'cleanup' ? new Promise(() => {}) : undefined }, { op: 'ping' },
  async (o, env, elapsed) => {
    const bounded = o.ok && elapsed < 150;
    await delay(260);
    return bounded && noSlots(env);
  });
await fault('迟到初始化超过总截止不创建槽或发送请求', {
  evaluateHook: async (stage) => { if (stage === 'init') await delay(270); } }, { op: 'ping' },
  async (o, env, elapsed) => {
    const bounded = o.error === 'ERP_HTTP' && elapsed < 200;
    await delay(280);
    return bounded && env.calls.length === 0 && noSlots(env);
  });
await fault('整次save的多个接口共用总预算，超时前未PUT为false', { detail: baseDetail(),
  evaluateHook: async () => { await delay(30); } },
  { op: 'save', taskId: 1, submit: false, items: fresh, expectedSnapshot: faultBaseline },
  async (o, env, elapsed) => {
    await delay(60);
    return o.error === 'ERP_HTTP' && o.writeAttempted === false && elapsed < 350
      && env.calls.every((c) => c.method !== 'PUT') && noSlots(env);
  });
await fault('响应正文读取挂起同样可取消并清理', { fetchHook: async (url, opts) => ({ status: 200,
  text: () => hangingFetch(url, opts) }) }, { op: 'ping' },
  (o, env) => o.error === 'ERP_HTTP' && env.calls.length === 1 && noSlots(env));
const isolatedEnvs = [makeEnv({}), makeEnv({ store: { local: {}, session: {} } })];
const isolated = await Promise.all(isolatedEnvs.map((env) => fastErpApi(env.browser, 1, { op: 'ping' })));
results.push({ name: '两个页面异步执行独立槽位与令牌，均无残留',
  pass: isolated[0].ok && isolated[1].error === 'ERP_LOGIN' && isolatedEnvs.every(noSlots) });

// 23. 传输通信次数及分片边界；真实历史版本A/B脚本随本次证据保留，不与未来源码耦合。
const transport = async (name, state, request, expectedEvaluations, expectedHttp, check) => {
  const env = makeEnv(state);
  const output = await erpApi(env.browser, 1, request);
  const boundedChunks = env.evaluations.every(({ stage, arg }) =>
    (stage !== 'request' || arg.chunkSize === 800) && (stage !== 'download' || arg.n === 800)
    && (arg?.part === undefined || arg.part.length <= 800));
  results.push({ name: `首分片合并通信次数/HTTP/分片边界：${name}`,
    pass: env.evaluations.length === expectedEvaluations && env.calls.length === expectedHttp
      && boundedChunks && check(output, env) && noSlots(env),
    out: JSON.stringify({ output, evaluations: env.evaluations.length, http: env.calls.length }) });
};
await transport('小ping响应', {}, { op: 'ping' }, 3, 1, (o) => o.ok && o.pending === 1);
await transport('空列表', { done: true }, { op: 'list', done: false }, 3, 1, (o) => o.ok && o.tasks.length === 0);
const escapedDetail = baseDetail();
escapedDetail.items[0].description = ('中文😀\\\"\n\t\u0000').repeat(900);
await transport('多段中文/emoji/转义大响应', { detail: escapedDetail }, { op: 'task', taskId: 1 }, 32, 4,
  (o) => o.ok && o.run.items[0].description === escapedDetail.items[0].description);
await transport('草稿短请求', { detail: baseDetail() }, { op: 'save', taskId: 1, submit: false, items: fresh, expectedSnapshot: faultBaseline }, 17, 5,
  (o, env) => o.ok && o.writeAttempted && env.calls.filter((c) => c.method === 'PUT').length === 1);
const longItems = [{ itemId: 1, quotes: Array.from({ length: 5 }, (_, n) => ({ ...fresh[0].quotes[0], shopName: `商家${n}`, note: '中文\\\"\n\t'.repeat(70) })) }];
await transport('草稿多段中文/转义请求', { detail: baseDetail() }, { op: 'save', taskId: 1, submit: false, items: longItems, expectedSnapshot: faultBaseline }, 21, 5,
  (o, env) => o.ok && env.calls.find((c) => c.method === 'PUT').body.items[0].quotes[0].note === longItems[0].quotes[0].note.slice(0, 300));
await transport('核对完整写入范围/列表观察', { detail: baseDetail() }, { op: 'verify', taskId: 1, submitted: false, items: fresh, expectedSnapshot: faultBaseline }, 20, 6,
  (o, env) => !o.ok && o.mismatches.length > 0 && env.calls.every((c) => c.method === 'GET'));
await transport('GET401续期一次', { expireT1: true, refreshOk: true }, { op: 'ping' }, 3, 3, (o, env) => o.ok && refreshes(env) === 1);
await transport('PUT401绝不续期或重放', { detail: baseDetail(), put401: true }, { op: 'save', taskId: 1, submit: false, items: fresh, expectedSnapshot: faultBaseline }, 17, 5,
  (o, env) => o.error === 'ERP_LOGIN' && o.writeAttempted && refreshes(env) === 0 && env.calls.filter((c) => c.method === 'PUT').length === 1);
await transport('无令牌不下载首段', { store: { local: {}, session: {} } }, { op: 'ping' }, 3, 0, (o) => o.error === 'ERP_LOGIN');
await fault('合并请求首响应超限时仍finally清理且PUT不重放', { detail: baseDetail(),
  evaluateHook: async (stage, arg) => stage === 'request' && arg.method === 'PUT' ? { writtenToFile: true } : undefined },
  { op: 'save', taskId: 1, submit: false, items: fresh, expectedSnapshot: faultBaseline },
  (o, env) => o.error === 'ERP_HTTP' && o.writeAttempted === true && noSlots(env) && env.calls.every((c) => c.method !== 'PUT'));
await fault('携带首请求段的初始化中断仍保守标记未知写入并清理', { detail: baseDetail(),
  evaluateHook: async (stage, arg) => { if (stage === 'init' && arg.part) throw new Error('T1 sensitive context'); } },
  { op: 'save', taskId: 1, submit: false, items: fresh, expectedSnapshot: faultBaseline },
  (o, env) => o.error === 'ERP_HTTP' && o.writeAttempted === true && !JSON.stringify(o).includes('T1')
    && noSlots(env) && env.calls.every((c) => c.method !== 'PUT'));

for (const field of ['taxIncluded', 'freeShipping', 'noStock']) {
  for (const value of [null, 'false', 'true', 0, 1, [], {}]) {
    const items = field === 'noStock' ? [{ itemId: 1, noStock: value, quotes: [] }]
      : [{ itemId: 1, quotes: [{ ...fresh[0].quotes[0], [field]: value }] }];
    for (const op of ['save', 'verify']) for (const submitted of [false, true]) {
      await t(`${op} ${field}拒绝${JSON.stringify(value)}，模式${submitted}且零PUT`, { detail: baseDetail() },
        { op, taskId: 1, items, [op === 'save' ? 'submit' : 'submitted']: submitted },
        (o, s, env) => o.error === 'SKILL_INPUT' && o.problems.some((p) => p.path.endsWith(`.${field}`) && p.expected === 'boolean')
          && (op !== 'save' || o.writeAttempted === false) && !s.lastPut && env.calls.every((c) => c.method !== 'PUT'));
    }
  }
}
for (const flags of [{ taxIncluded: false, freeShipping: false, noStock: false }, {}]) {
  const { noStock, ...quoteFlags } = flags;
  const items = [{ itemId: 1, ...(Object.hasOwn(flags, 'noStock') ? { noStock } : {}), quotes: [{ channel: '淘宝', shopName: '店B', unitPrice: 10, ...quoteFlags }] }];
  await t(`合法false/省略报价布尔默认${JSON.stringify(flags)}`, { detail: baseDetail() }, { op: 'save', taskId: 1, submit: false, items },
    (o, s) => o.ok && s.lastPut.items[0].quotes[0].taxIncluded === false
      && s.lastPut.items[0].quotes[0].freeShipping === (flags.freeShipping ?? true) && !s.lastPut.items[0].noStock);
  await t(`noStock false/省略不造无货${JSON.stringify(flags)}`, { detail: baseDetail() },
    { op: 'save', taskId: 1, submit: false, items: [{ ...items[0], quotes: [] }] },
    (o, s, env) => o.error === 'SKILL_INPUT' && o.writeAttempted === false && !s.lastPut && env.calls.every((c) => c.method !== 'PUT'));
}
await t('ERP已有报价可选null保持兼容', { detail: baseDetail([q({ taxIncluded: null, freeShipping: null })]) },
  { op: 'save', taskId: 1, submit: false, items: fresh },
  (o, s) => o.ok && s.lastPut.items[0].quotes.find((x) => x.shopName === '店A').taxIncluded === false
    && s.lastPut.items[0].quotes.find((x) => x.shopName === '店A').freeShipping === true);

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '\n      ' + r.out + '\n      put=' + r.put}`);
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} 通过`);
if (passed !== results.length) process.exit(1);
