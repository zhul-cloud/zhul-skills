// ERP 接口脚本 erpApi 的离线测试：用模拟的 ERP 和 page.evaluate（返回超过 4000 字节时像 BrowserOS 一样只给文件引用）。
// 不连 ERP、不需要浏览器。改了 helpers/_erp/erpApi.md 之后运行：node scripts/erp-api.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const md = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'helpers', '_erp', 'erpApi.md'), 'utf8');
// 仓库在 Windows 上检出时是 CRLF 换行
const src = md.match(/```js\r?\n([\s\S]*?)\r?\n```/)[1];
const erpApi = (0, eval)('(' + src + ')');

const DICTS = {
  inquiry_item_condition: ['全新原装', '99新', '翻新', '二手', '拆机件', '国产替代', '待确认'],
  inquiry_lead_time: ['现货', '1-2天', '2-3天', '3-5天', '5-7天', '1-2周', '2-4周', '4-8周', '8周以上'],
};
const dictItems = (type) => type === 'inquiry_tax_rate'
  ? [{ itemName: '13%', itemValue: '13', status: 1 }, { itemName: '3%', itemValue: '3', status: 1 }, { itemName: '1%', itemValue: '1', status: 1 }]
  : DICTS[type].map((n, i) => ({ itemName: n, itemValue: String(i + 1), status: 1 }));

function makeEnv(state) {
  const store = { local: { zhul_token: 'T1' }, session: {} };
  const calls = [];
  const fetchMock = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, body: opts.body ? JSON.parse(opts.body) : null });
    const reply = (http, json) => ({ status: http, text: async () => JSON.stringify(json), json: async () => json });
    if (url === '/api/v1/auth/refresh') return state.refreshOk ? reply(200, { code: 0, data: { accessToken: 'T2' } }) : reply(401, { code: 401 });
    const auth = (opts.headers || {}).Authorization;
    if (state.expireT1 && auth === 'Bearer T1') return reply(401, { code: 401, message: 'expired' });
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
    if (method === 'PUT') { state.lastPut = JSON.parse(opts.body); return reply(200, state.putReply || { code: 0, message: 'ok' }); }
    if (state.detailReply) return reply(state.detailReply.http, state.detailReply.json);
    const detail = JSON.parse(JSON.stringify(state.detail));
    return reply(200, { code: 0, message: 'ok', data: detail });
  };
  const sandboxPage = {
    evaluate: async (fn, arg) => {
      globalThis.window = globalThis.window || {};
      globalThis.sessionStorage = { getItem: (k) => store.session[k] ?? null, setItem: (k, v) => { store.session[k] = v; } };
      globalThis.localStorage = { getItem: (k) => store.local[k] ?? null, setItem: (k, v) => { store.local[k] = v; } };
      globalThis.fetch = fetchMock;
      const value = await fn(arg);
      const size = Buffer.byteLength(JSON.stringify({ page: 1, value }) ?? '');
      if (size > 4000) return { page: 1, path: 'x.txt', writtenToFile: true, contentLength: size };
      return { page: 1, value };
    },
  };
  return { browser: { page: () => sandboxPage }, store, calls };
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
const readSnapshot = async (detail) => erpApi(makeEnv({ detail }).browser, 1, { op: 'snapshot', taskId: 1 });
const t = async (name, state, req, check) => {
  const env = makeEnv(state);
  let out;
  try {
    if (req.op === 'save' && !Object.hasOwn(req, 'expectedSnapshot')) {
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
  { op: 'verify', taskId: 1, submitted: true, items: [{ itemId: 1, noStock: true, quotes: [] }] }, (o) => o.ok);
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

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '\n      ' + r.out + '\n      put=' + r.put}`);
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} 通过`);
if (passed !== results.length) process.exit(1);
