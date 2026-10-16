---
name: "erpApi"
host: "<ERP>"
lastVerified: 1792166400000
agent: "claude"
candidate: false
opensPage: false
description: "烛龙智能询价：在 ERP 标签页里调用「我的询价」接口（取任务、存草稿、提交回价、核对），每次校验接口结构"
inputs: {}
---

烛龙智能询价：在 ERP 标签页里调用「我的询价」接口。由 `records.mjs install-helpers` 按 `config.json` 里的 ERP 地址装进对应域名，`host` 由安装时填入。

Call it:

`helpers["erpApi"](browser, pageId, { op: "task", taskId: 1 })`

- `pageId`：任意一个已登录 ERP 的标签页（同一个 ERP 地址）。脚本只在页面里取令牌、发请求，不点页面，也不返回令牌。
- `op`：`ping`（检查登录）、`list`（`done`: true 已回价 / false 待处理）、`task`（`taskId`；读任务，返回可直接写进 run.json 的内容）、`save`（`taskId`、`items`、`submit`: false 存草稿 / true 提交回价）、`verify`（`taskId`、`items`、`submitted`: 是否已提交；逐条核对）。`items` 由 `records.mjs erp-items` 生成。
- `save` / `verify` 同时传 `erp-items` 输出的 `skipItemIds`（不传按空数组）：因询价故障且无有效报价而排除的型号 ID，必须属于本任务、不重复且不与 `items` 重叠。提交时这些型号的原草稿保留原状，其余型号的草稿照常一并提交；核对只检查 `items`。
- 返回 `{ ok: true, ... }`；出错返回 `{ ok: false, error, ... }`：
  - `ERP_CONTRACT`：接口结构和下面 CONTRACT 记录的不一致（缺字段、类型变了、取值不认识、接口不存在）。**立即停止任务**，提示「ERP 接口已修改，烛龙智能询价没有同步，请更新技能」，把 `problems` 写进实跑报告。
  - `ERP_LOGIN`：没登录或登录已过期且无法续期，请用户在 BrowserOS neo 里重新登录 ERP（建议勾选「记住我」）。
  - `ERP_BIZ`：ERP 拒绝了这次请求（如「货期不在可选值内」），仅正式提交前草稿可按 message 改正；提交已执行或结果未知只读核对并转人工，不重复 submit。
  - `ERP_HTTP`：网络或服务器错误、ERP 标签页不可用，最多重试一次；提交已执行或未知时仅重试只读核对；仍失败按 [ERP 重试边界](../../references/erp-api.md#erp-错误与重试边界)转人工。
  - `SKILL_INPUT`：技能传进来的内容不对（如型号不在任务里、货况文字不认识），本次输入未进入业务 PUT；仅正式提交前草稿可改正重试，此前提交已执行或未知时只读核对，不重复 submit。
- ERP 新增的字段不算错误，在返回的 `extraFields` 里列出，写进实跑报告即可。

```js
async (browser, pageId, req) => {
  // ===== 接口约定 =====
  // ERP 可能跑在本机、测试服务器或正式服务器上，部署的是哪个版本无法从接口读到，所以不按版本号判断，
  // 而是每次请求都按下面的结构核对：对得上就能用，对不上就停。checkedAt 是这份约定最后一次对照 ERP 核对的日期。
  // 类型写法：'number' 'string' 'boolean'；末尾带 ? 表示可以没有（ERP 不返回空字段）；[x] 为数组；{...} 为对象。
  // 'any?' 是 ERP 有、技能不用的字段，列出来是为了分辨哪些字段是 ERP 新增的；'*' 表示这个对象的其他字段都不关心
  const CONTRACT = {
    checkedAt: '2026-10-16',
    // 所有接口的外层：code 为 0 表示成功
    envelope: { code: 'number', message: 'string?', data: 'any?' },
    endpoints: {
      list: { method: 'GET', path: '/api/v1/inquiry/my-tasks', query: { done: 'boolean' },
        data: [{ id: 'number', taskCode: 'string', brand: 'string?', category: 'string?', itemCount: 'number',
          filledCount: 'number', status: 'number', quoteDeadline: 'string?', remainingMinutes: 'number?',
          timeout: 'boolean?', urgent: 'boolean?', editable: 'boolean?',
          salesId: 'any?', salesName: 'any?', level: 'any?', customerType: 'any?', customerName: 'any?',
          assignedAt: 'any?', updateTime: 'any?', shared: 'any?' }] },
      detail: { method: 'GET', path: '/api/v1/inquiry/my-tasks/{taskId}',
        data: {
          task: { id: 'number', taskCode: 'string', brand: 'string?', itemCount: 'number', filledCount: 'number',
            status: 'number', quoteDeadline: 'string?', remainingMinutes: 'number?', editable: 'boolean?',
            category: 'any?', timeout: 'any?', urgent: 'any?', salesId: 'any?', salesName: 'any?', level: 'any?',
            customerType: 'any?', customerName: 'any?', assignedAt: 'any?', updateTime: 'any?', shared: 'any?' },
          items: [{ id: 'number', model: 'string', quantity: 'number', unit: 'string?', description: 'string?',
            inquiryScript: 'string', searchKeywords: ['string'], locked: 'boolean?',
            originalModel: 'any?', actualModel: 'any?', lifecycle: 'any?', replacementModel: 'any?', archiveStatus: 'any?',
            archiveStatusName: 'any?', productId: 'any?', difficulty: 'any?', historyKind: 'any?', historyPrice: 'any?',
            historyDate: 'any?', reviewStatus: 'any?', reviewNote: 'any?', reviewedByName: 'any?', reviewedAt: 'any?',
            quotes: [{ id: 'number', channel: 'number', shopName: 'string?', supplierId: 'number?', unitPrice: 'number?',
              taxIncluded: 'boolean?', taxRate: 'number?', itemCondition: 'number?', leadTime: 'number?', note: 'string?',
              noStock: 'boolean?', freeShipping: 'boolean?', recommended: 'boolean?', status: 'number',
              reviewNote: 'any?', quotedAt: 'any?', attachments: [{ id: 'number', '*': 'any' }, '?'] }] }],
          reviewRequired: 'boolean?' } },
      dict: { method: 'GET', path: '/api/v1/system/dict-items', query: { dictType: 'string' },
        data: [{ itemName: 'string', itemValue: 'string', status: 'number',
          id: 'any?', dictType: 'any?', dictTypeId: 'any?', itemCode: 'any?', itemNameEn: 'any?', cssClass: 'any?',
          listClass: 'any?', sortOrder: 'any?', isDefault: 'any?', remark: 'any?', createTime: 'any?', updateTime: 'any?' }] },
      // 请求体：items[].quotes[] 的码值见下方 enums 和字典；submit=false 存草稿，true 提交回价。
      // 注意：一次请求会替换本人在所涉型号上的草稿（提交时连已提交/待审核的一起替换），所以同一型号要一次带上全部报价行。
      save: { method: 'PUT', path: '/api/v1/inquiry/my-tasks/{taskId}/quotes',
        body: { items: [{ itemId: 'number', noStock: 'boolean?', noStockNote: 'string?',
          quotes: [{ channel: 'number', shopName: 'string', supplierId: 'number?', unitPrice: 'number', taxIncluded: 'boolean',
            taxRate: 'number?', itemCondition: 'number', leadTime: 'number', note: 'string', freeShipping: 'boolean?',
            recommended: 'boolean?', attachmentIds: ['number'] }] }], submit: 'boolean' },
        data: 'any?' },
      refresh: { method: 'POST', path: '/api/v1/auth/refresh', data: { accessToken: 'string' } },
    },
    enums: {
      channel: { '淘宝': 1, '1688': 2 },              // 其余：闲鱼 3、供应商 4、其他 5，技能不用
      quoteStatus: { 1: '草稿', 2: '已提交', 3: '待审核', 4: '作废' },
    },
    // 字典：技能会用到的取值必须都在，且码值一致；ERP 多出来的取值不算错误
    dicts: {
      inquiry_item_condition: { '全新原装': 1, '99新': 2, '翻新': 3, '二手': 4, '拆机件': 5, '国产替代': 6, '待确认': 7 },
      inquiry_lead_time: { '现货': 1, '1-2天': 2, '2-3天': 3, '3-5天': 4, '5-7天': 5, '1-2周': 6, '2-4周': 7, '4-8周': 8, '8周以上': 9 },
      inquiry_tax_rate: { '13%': 13, '3%': 3 },
    },
    // 货源直达链接，与 ERP 前端 searchLinks 相同
    searchLinks: { '淘宝': 'https://s.taobao.com/search?q=', '1688': 'https://s.1688.com/selloffer/offer_search.htm?keywords=' },
  };

  const page = browser.page(pageId);
  const extraFields = new Set();

  // ----- 结构校验：缺字段、类型不对记为 problems；多出来的字段记进 extraFields -----
  const check = (value, spec, path, problems) => {
    if (spec === 'any?' || spec === 'any') return;
    if (typeof spec === 'string') {
      const optional = spec.endsWith('?');
      const type = optional ? spec.slice(0, -1) : spec;
      if (value === undefined || value === null) {
        if (!optional) problems.push({ path, expected: type, actual: 'missing' });
        return;
      }
      if (typeof value !== type) problems.push({ path, expected: type, actual: typeof value });
      return;
    }
    if (Array.isArray(spec)) {
      const optional = spec[1] === '?';
      if (value === undefined || value === null) {
        if (!optional) problems.push({ path, expected: 'array', actual: 'missing' });
        return;
      }
      if (!Array.isArray(value)) { problems.push({ path, expected: 'array', actual: typeof value }); return; }
      value.forEach((v, i) => check(v, spec[0], `${path}[${i}]`, problems));
      return;
    }
    if (value === undefined || value === null) { problems.push({ path, expected: 'object', actual: 'missing' }); return; }
    if (typeof value !== 'object' || Array.isArray(value)) { problems.push({ path, expected: 'object', actual: Array.isArray(value) ? 'array' : typeof value }); return; }
    for (const [k, s] of Object.entries(spec)) if (k !== '*') check(value[k], s, `${path}.${k}`, problems);
    if (!('*' in spec)) for (const k of Object.keys(value)) if (!(k in spec)) extraFields.add(`${path.replace(/\[\d+\]/g, '[]')}.${k}`);
  };

  const contractError = (endpoint, problems) => ({ ok: false, error: 'ERP_CONTRACT', endpoint, problems,
    contractCheckedAt: CONTRACT.checkedAt, hint: 'ERP 接口已修改，烛龙智能询价没有同步，请更新技能' });

  // ----- 在 ERP 页面里发请求：令牌取自页面的登录状态，过期时按前端同样的方式续期；令牌不返回 -----
  // 页面通信出错（标签页关了、页面跳走等）时不抛出，按 ERP_HTTP 返回
  const call = async (name, opts) => {
    try {
      return await callRaw(name, opts);
    } catch (e) {
      return { fail: { ok: false, error: 'ERP_HTTP', endpoint: name, message: String((e && e.message) || e) } };
    }
  };
  const callRaw = async (name, { pathParams = {}, query, body } = {}) => {
    const ep = CONTRACT.endpoints[name];
    let url = ep.path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(pathParams[k])));
    if (query) url += '?' + Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
    // BrowserOS 的 page.evaluate 返回超过约 4KB 时会改写成文件、不给内容，所以请求体和响应都分段传：
    // 内容先放在页面的 window.__erpApi 里，每次只传一小段（800 个字符，中文和转义后也在限制内）
    const CHUNK = 800;
    const ev = async (fn, arg) => {
      const w = await page.evaluate(fn, arg);
      if (w && w.writtenToFile) throw new Error('page.evaluate 返回内容过大');
      return w && w.value !== undefined ? w.value : w;
    };
    const key = `k${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const bodyText = body ? JSON.stringify(body) : '';
    await ev((key) => { (window.__erpApi = window.__erpApi || {})[key] = { up: '', text: '' }; return true; }, key);
    for (let i = 0; i < bodyText.length; i += CHUNK) {
      await ev(({ key, part }) => { window.__erpApi[key].up += part; return true; }, { key, part: bodyText.slice(i, i + CHUNK) });
    }
    const res = await ev(async ({ key, method, url, refreshPath }) => {
      const slot = window.__erpApi[key];
      const body = slot.up || undefined;
      const read = () => sessionStorage.getItem('akt') || localStorage.getItem('zhul_token');
      const send = async (token) => {
        const r = await fetch(url, { method, credentials: 'include',
          headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body });
        slot.text = await r.text();
        return r.status;
      };
      let token = read();
      if (!token) return { login: true, reason: 'no-token' };
      let http = await send(token);
      if (http === 401) {
        // 与前端相同：用 HttpOnly 续期 Cookie 换新令牌，写回原来的位置（只有登录时勾了「记住我」才有续期 Cookie）
        try {
          const r = await fetch(refreshPath, { method: 'POST', credentials: 'include' });
          const j = await r.json();
          if (j && j.code === 0 && j.data && j.data.accessToken) {
            if (sessionStorage.getItem('akt')) sessionStorage.setItem('akt', j.data.accessToken);
            else localStorage.setItem('zhul_token', j.data.accessToken);
            token = j.data.accessToken;
            http = await send(token);
          }
        } catch (e) { /* 续期失败，按未登录处理 */ }
        if (http === 401) return { login: true, reason: 'expired' };
      }
      return { http, length: slot.text.length };
    }, { key, method: ep.method, url, refreshPath: CONTRACT.endpoints.refresh.path });
    if (!res.login) {
      let text = '';
      for (let i = 0; i < res.length; i += CHUNK) {
        text += await ev(({ key, i, n }) => window.__erpApi[key].text.slice(i, i + n), { key, i, n: CHUNK });
      }
      try { res.json = JSON.parse(text); } catch (e) { res.json = null; }
    }
    await ev((key) => { delete window.__erpApi[key]; return true; }, key);

    if (res.login) return { fail: { ok: false, error: 'ERP_LOGIN', reason: res.reason,
      hint: '请在 BrowserOS neo 里重新登录 ERP（建议勾选「记住我」，令牌才能在其他标签页使用并自动续期）' } };
    if (res.http === 404 || res.http === 405) return { fail: contractError(name, [{ path: url, expected: `${ep.method} 接口存在`, actual: `HTTP ${res.http}` }]) };
    if (res.http >= 500 || !res.json) return { fail: { ok: false, error: 'ERP_HTTP', endpoint: name, http: res.http } };
    const problems = [];
    check(res.json, CONTRACT.envelope, name, problems);
    if (problems.length) return { fail: contractError(name, problems) };
    if (res.json.code !== 0) return { fail: { ok: false, error: 'ERP_BIZ', endpoint: name, code: res.json.code, message: res.json.message } };
    check(res.json.data, ep.data, `${name}.data`, problems);
    if (problems.length) return { fail: contractError(name, problems) };
    return { data: res.json.data };
  };

  // ----- 字典：技能用到的取值必须都在、码值一致 -----
  const loadDicts = async () => {
    const out = {};
    for (const [type, expected] of Object.entries(CONTRACT.dicts)) {
      const r = await call('dict', { query: { dictType: type } });
      if (r.fail) return r;
      const enabled = new Map(r.data.filter((d) => d.status === 1).map((d) => [d.itemName, Number(d.itemValue)]));
      const problems = [];
      for (const [label, code] of Object.entries(expected)) {
        if (!enabled.has(label)) problems.push({ path: `dict.${type}`, expected: `启用的「${label}」`, actual: 'missing' });
        else if (enabled.get(label) !== code) problems.push({ path: `dict.${type}.${label}`, expected: code, actual: enabled.get(label) });
      }
      if (problems.length) return { fail: contractError('dict', problems) };
      out[type] = expected;
    }
    return { data: out };
  };

  const checkQuoteEnums = (items) => {
    const problems = [];
    const known = { channel: [1, 2, 3, 4, 5], status: Object.keys(CONTRACT.enums.quoteStatus).map(Number) };
    items.forEach((it, i) => (it.quotes || []).forEach((q, j) => {
      if (!known.channel.includes(q.channel)) problems.push({ path: `detail.data.items[${i}].quotes[${j}].channel`, expected: known.channel.join('/'), actual: q.channel });
      if (!known.status.includes(q.status)) problems.push({ path: `detail.data.items[${i}].quotes[${j}].status`, expected: known.status.join('/'), actual: q.status });
    }));
    return problems;
  };

  const loadTask = async (taskId) => {
    const r = await call('detail', { pathParams: { taskId } });
    if (r.fail) return r;
    const problems = checkQuoteEnums(r.data.items);
    if (problems.length) return { fail: contractError('detail', problems) };
    return r;
  };

  const extras = () => [...extraFields];
  const op = req && req.op;
  if (op === 'ping') {
    const r = await call('list', { query: { done: false } });
    return r.fail || { ok: true, pending: r.data.length, extraFields: extras() };
  }

  if (op === 'list') {
    const r = await call('list', { query: { done: !!req.done } });
    if (r.fail) return r.fail;
    return { ok: true, tasks: r.data.map((t) => ({ taskId: t.id, task: t.taskCode, brand: t.brand ?? '', category: t.category ?? '',
      itemCount: t.itemCount, filledCount: t.filledCount, status: t.status, quoteDeadline: t.quoteDeadline ?? null,
      remainingMinutes: t.remainingMinutes ?? null, timeout: !!t.timeout, urgent: !!t.urgent })), extraFields: extras() };
  }

  if (op === 'task') {
    const d = await loadDicts();
    if (d.fail) return d.fail;
    const r = await loadTask(req.taskId);
    if (r.fail) return r.fail;
    const { task, items } = r.data;
    const readAt = new Date();
    const deadline = task.remainingMinutes == null ? null : new Date(readAt.getTime() + task.remainingMinutes * 60000).toISOString();
    const links = (keywords) => Object.fromEntries(Object.entries(CONTRACT.searchLinks)
      .map(([platform, base]) => [platform, keywords.map((k) => base + encodeURIComponent(k))]));
    const statusName = (s) => CONTRACT.enums.quoteStatus[s];
    return { ok: true, run: {
      task: task.taskCode, taskId: task.id, readAt: readAt.toISOString(), deadline,
      quoteDeadline: task.quoteDeadline ?? null, reviewRequired: !!r.data.reviewRequired, editable: task.editable !== false,
      items: items.filter((i) => !i.locked).map((i) => ({ itemId: i.id, model: i.model, quantity: i.quantity, unit: i.unit ?? '',
        description: i.description ?? '', script: i.inquiryScript, links: links(i.searchKeywords),
        existingQuotes: i.quotes.map((q) => statusName(q.status)) })),
      lockedItems: items.filter((i) => i.locked).map((i) => ({ itemId: i.id, model: i.model, reason: '已报给客户' })),
    }, extraFields: extras() };
  }

  // ----- 把技能整理的报价（文字取值）换成 ERP 码值，并带上本人原有的报价行 -----
  const toEntry = (q, dicts, where, problems) => {
    const channel = CONTRACT.enums.channel[q.channel];
    if (!channel) problems.push({ path: `${where}.channel`, expected: Object.keys(CONTRACT.enums.channel).join('/'), actual: q.channel });
    const condLabel = q.condition || '待确认';
    const itemCondition = dicts.inquiry_item_condition[condLabel];
    if (itemCondition === undefined) problems.push({ path: `${where}.condition`, expected: Object.keys(dicts.inquiry_item_condition).join('/'), actual: condLabel });
    const leadTime = q.leadTime ? dicts.inquiry_lead_time[q.leadTime] : 0;
    if (leadTime === undefined) problems.push({ path: `${where}.leadTime`, expected: Object.keys(dicts.inquiry_lead_time).join('/'), actual: q.leadTime });
    // ERP 单价存两位小数
    const price = Number(q.unitPrice);
    const unitPrice = Math.round(price * 100) / 100;
    if (!(typeof q.unitPrice === 'number' || (typeof q.unitPrice === 'string' && q.unitPrice.trim()))
      || !Number.isFinite(price) || price < 0 || !Number.isFinite(unitPrice)) {
      problems.push({ path: `${where}.unitPrice`, expected: '非负有限数字或非空数字字符串', actual: q.unitPrice });
    }
    const taxIncluded = !!q.taxIncluded;
    const taxRate = taxIncluded ? Number(q.taxRate) : undefined;
    if (taxIncluded && !Object.values(dicts.inquiry_tax_rate).includes(taxRate)) problems.push({ path: `${where}.taxRate`, expected: Object.values(dicts.inquiry_tax_rate).join('/'), actual: q.taxRate });
    // ERP 店铺名称最长 128 字、备注最长 300 字
    const entry = { channel, shopName: String(q.shopName || '').trim().slice(0, 128), unitPrice, taxIncluded, itemCondition, leadTime,
      note: String(q.note || '').slice(0, 300), freeShipping: q.freeShipping !== false, attachmentIds: [] };
    if (taxIncluded) entry.taxRate = taxRate;
    return entry;
  };
  const fromExisting = (q, review) => {
    const e = { channel: q.channel, shopName: q.shopName ?? '', unitPrice: q.unitPrice, taxIncluded: !!q.taxIncluded,
      itemCondition: q.itemCondition ?? 0, leadTime: q.leadTime ?? 0, note: q.note ?? '',
      freeShipping: q.freeShipping !== false, attachmentIds: (q.attachments || []).map((a) => a.id) };
    if (q.taxIncluded && q.taxRate != null) e.taxRate = Math.round(Number(q.taxRate));
    if (q.supplierId != null) e.supplierId = q.supplierId;
    if (!review && q.recommended) e.recommended = true;
    return e;
  };
  const keyOf = (channel, shop) => `${channel}|${String(shop || '').trim()}`;
  // 本人原有的报价行要不要随本次请求带上，取决于 ERP 这次会替换哪些记录（与页面「保存草稿」「提交回价」一致）：
  // 存草稿只替换草稿；提交时，不需要审核的账号替换草稿和已提交的，需要审核的账号替换草稿和待审核的（已通过的版本 ERP 自己保留）
  const keepStatuses = (submit, review) => (!submit ? [1] : review ? [1, 3] : [1, 2]);
  const keptQuotes = (item, statuses, skipKeys, review) => {
    const byKey = new Map();
    // 同一平台同一店铺有草稿也有旧版本时，以草稿为准
    for (const q of [...item.quotes].sort((a, b) => (a.status === 1 ? 0 : 1) - (b.status === 1 ? 0 : 1))) {
      if (q.noStock || !statuses.includes(q.status)) continue;
      const k = keyOf(q.channel, q.shopName);
      if (skipKeys.has(k) || byKey.has(k)) continue;
      byKey.set(k, fromExisting(q, review));
    }
    return [...byKey.values()];
  };
  const skippedItems = (byId, problems) => {
    const ids = req.skipItemIds === undefined ? [] : req.skipItemIds;
    check(ids, ['number'], 'skipItemIds', problems);
    const skipped = new Set();
    if (!Array.isArray(ids)) return skipped;
    for (const [n, id] of ids.entries()) {
      if (!byId.has(id)) problems.push({ path: `skipItemIds[${n}]`, expected: '本任务的型号ID', actual: id });
      if (skipped.has(id)) problems.push({ path: `skipItemIds[${n}]`, expected: '不重复的型号ID', actual: id });
      if ((req.items || []).some((it) => it.itemId === id)) problems.push({ path: `skipItemIds[${n}]`, expected: '不能同时出现在items中', actual: id });
      skipped.add(id);
    }
    return skipped;
  };

  if (op === 'save') {
    const d = await loadDicts();
    if (d.fail) return d.fail;
    const r = await loadTask(req.taskId);
    if (r.fail) return r.fail;
    const review = !!r.data.reviewRequired;
    const byId = new Map(r.data.items.map((i) => [i.id, i]));
    const problems = [];
    const skipped = skippedItems(byId, problems);
    const body = { items: [], submit: !!req.submit };
    const touched = new Set();
    for (const [n, it] of (req.items || []).entries()) {
      const item = byId.get(it.itemId);
      if (!item) { problems.push({ path: `items[${n}].itemId`, expected: '本任务的型号', actual: it.itemId }); continue; }
      if (item.locked) continue; // 已报给客户的型号不能再改
      touched.add(item.id);
      const fresh = (it.quotes || []).map((q, j) => toEntry(q, d.data, `items[${n}].quotes[${j}]`, problems));
      const freshKeys = new Set(fresh.map((e) => keyOf(e.channel, e.shopName)));
      // 本人原有的报价行照带，同一平台同一店铺的以本次为准
      const existing = keptQuotes(item, keepStatuses(body.submit, review), new Set(), review);
      // 本次报价不上传附件；更新同店报价时继承被替换版本的附件（同店仍以草稿优先）
      for (const e of fresh) {
        const previous = existing.find((q) => keyOf(q.channel, q.shopName) === keyOf(e.channel, e.shopName));
        if (previous) e.attachmentIds = previous.attachmentIds;
      }
      const keep = existing.filter((q) => !freshKeys.has(keyOf(q.channel, q.shopName)));
      const quotes = [...keep, ...fresh];
      if (quotes.length) body.items.push({ itemId: item.id, quotes });
      else if (it.noStock) body.items.push({ itemId: item.id, noStock: true, noStockNote: String(it.noStockNote || '').slice(0, 300), quotes: [] });
    }
    if (problems.length) return { ok: false, error: 'SKILL_INPUT', problems, hint: '技能整理的报价取值不对，改正 run.json 后重试' };
    // 提交时，本人在其他型号上的草稿也一并提交；故障无价而显式排除的型号保留原状
    if (body.submit) {
      for (const item of r.data.items) {
        if (touched.has(item.id) || skipped.has(item.id) || item.locked) continue;
        const drafts = item.quotes.filter((q) => q.status === 1);
        if (!drafts.length) continue;
        const noStock = drafts.find((q) => q.noStock);
        body.items.push(noStock ? { itemId: item.id, noStock: true, noStockNote: noStock.note ?? '', quotes: [] }
          : { itemId: item.id, quotes: keptQuotes(item, keepStatuses(true, review), new Set(), review) });
      }
    }
    if (!body.items.length) return { ok: false, error: 'SKILL_INPUT', problems: [{ path: 'items', expected: '至少一个型号有报价或无货', actual: 'empty' }] };
    const bodyProblems = [];
    check(body, CONTRACT.endpoints.save.body, 'save.body', bodyProblems);
    if (bodyProblems.length) return { ok: false, error: 'SKILL_INPUT', problems: bodyProblems };
    const s = await call('save', { pathParams: { taskId: req.taskId }, body });
    if (s.fail) return s.fail;
    return { ok: true, submit: body.submit, reviewRequired: review, items: body.items.map((i) => ({ itemId: i.itemId, quotes: i.quotes.length, noStock: !!i.noStock })), extraFields: extras() };
  }

  if (op === 'verify') {
    const d = await loadDicts();
    if (d.fail) return d.fail;
    const r = await loadTask(req.taskId);
    if (r.fail) return r.fail;
    const review = !!r.data.reviewRequired;
    const submitted = !!req.submitted;
    const okStatus = submitted ? (review ? [3, 2] : [2]) : [1];
    const byId = new Map(r.data.items.map((i) => [i.id, i]));
    const problems = [];
    skippedItems(byId, problems);
    if (problems.length) return { ok: false, error: 'SKILL_INPUT', problems };
    const mismatches = [];
    const same = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
    for (const [n, it] of (req.items || []).entries()) {
      const item = byId.get(it.itemId);
      if (!item) { mismatches.push({ itemId: it.itemId, problem: '型号不在任务里' }); continue; }
      const live = item.quotes.filter((q) => okStatus.includes(q.status));
      if (submitted && item.quotes.some((q) => q.status === 1)) mismatches.push({ itemId: it.itemId, model: item.model, problem: '提交后仍有草稿' });
      if (it.noStock && !(it.quotes || []).length) {
        if (!live.some((q) => q.noStock) && !live.length) mismatches.push({ itemId: it.itemId, model: item.model, problem: '无货没有录入' });
        continue;
      }
      for (const [j, q] of (it.quotes || []).entries()) {
        const p = [];
        const e = toEntry(q, d.data, `items[${n}].quotes[${j}]`, p);
        if (p.length) return { ok: false, error: 'SKILL_INPUT', problems: p, hint: '技能整理的报价取值不对，改正 run.json 后重试' };
        const hit = live.find((x) => x.channel === e.channel && String(x.shopName || '').trim() === e.shopName);
        if (!hit) { mismatches.push({ itemId: it.itemId, model: item.model, shop: e.shopName, problem: '没有找到这条报价' }); continue; }
        const diff = [];
        if (!same(hit.unitPrice, e.unitPrice)) diff.push(`单价 ${hit.unitPrice} ≠ ${e.unitPrice}`);
        if (!!hit.taxIncluded !== e.taxIncluded) diff.push('含税不一致');
        if (e.taxIncluded && Math.round(Number(hit.taxRate)) !== e.taxRate) diff.push(`税率 ${hit.taxRate} ≠ ${e.taxRate}`);
        if ((hit.itemCondition ?? 0) !== e.itemCondition) diff.push(`货况码 ${hit.itemCondition} ≠ ${e.itemCondition}`);
        if ((hit.leadTime ?? 0) !== e.leadTime) diff.push(`货期码 ${hit.leadTime} ≠ ${e.leadTime}`);
        if (String(hit.note ?? '').trim() !== e.note.trim()) diff.push('备注不一致');
        if ((hit.freeShipping !== false) !== e.freeShipping) diff.push(`包邮 ${hit.freeShipping !== false} ≠ ${e.freeShipping}`);
        if (diff.length) mismatches.push({ itemId: it.itemId, model: item.model, shop: e.shopName, problem: diff.join('；') });
      }
    }
    // 第二道检查：已回价列表与已填数（需要审核的账号，审核通过前任务留在待处理，不算失败）
    const done = await call('list', { query: { done: true } });
    if (done.fail) return done.fail;
    const pending = await call('list', { query: { done: false } });
    if (pending.fail) return pending.fail;
    const row = [...done.data, ...pending.data].find((t) => t.id === Number(req.taskId));
    return { ok: mismatches.length === 0, mismatches, reviewRequired: review,
      inDoneList: done.data.some((t) => t.id === Number(req.taskId)), filledCount: row ? row.filledCount : null,
      itemCount: row ? row.itemCount : null, extraFields: extras() };
  }

  return { ok: false, error: 'SKILL_INPUT', problems: [{ path: 'op', expected: 'ping/list/task/save/verify', actual: op }] };
}
```
