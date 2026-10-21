---
name: "searchCandidates"
host: "s.taobao.com"
lastVerified: 1792328175062
agent: "codex"
candidate: false
opensPage: false
description: "烛龙智能询价：Saved helper for s.taobao.com"
inputs: {}
---

注册时按 [BrowserOS 准备协议](../../references/browseros-setup.md)使用 `scripts/helpers.mjs` 生成适配源码；运行时名带平台前缀，避免同一次 run 内跨域同名互相覆盖。Markdown 的 `name` 和下方原函数保留源码身份。

Call it:

`helpers["zhul_taobao_searchCandidates"](browser, pageId, { items: [{ itemId, model }], mode: "current-dom" })`

批量调用一次返回当前 DOM 候选及独立标题、直达商品 URL，`matchItemIds` 仅表示逐明细文本匹配提示；同型号不同 `itemId` 仍分别保留。`legacy[3]` 按付款人数显示值换算，`2万` / `1.2万` 分别为 `20000` / `12000`；万位显示为约数，带 `+` 为下界，不冒称精确人数。结果不表示整页已加载、详情合格或已确认库存。筛选、复用及覆盖边界见 [淘宝平台说明](../../platforms/taobao.md#2-搜索)。

```js
async (browser, pageId, input) => {
  const detailed = typeof input === 'object' && input !== null && !Array.isArray(input);
  const batch = detailed && Object.hasOwn(input, 'items');
  const items = batch ? input.items : null;
  const model = batch ? items?.[0]?.model : detailed ? input.model : input;
  if (typeof model !== 'string' || !model.trim() || detailed && input.mode !== 'current-dom'
    || batch && (Object.hasOwn(input, 'model') || !Array.isArray(items) || !items.length
      || items.some((item) => !item || !['string', 'number'].includes(typeof item.itemId) || !String(item.itemId).trim()
        || typeof item.itemId === 'number' && !Number.isSafeInteger(item.itemId) || typeof item.model !== 'string' || !item.model.trim())
      || new Set(items.map((item) => String(item.itemId))).size !== items.length)) return { ok: false, error: 'SKILL_INPUT' };
  const page = browser.page(pageId);
  const transferKey = '__zhul_search_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const unwrap = (res) => res && res.value !== undefined ? res.value : res;
  const valid = (result) => detailed ? result?.ok === false && typeof result.error === 'string'
    || result?.ok === true && result.scope === 'current-dom' && typeof result.pageUrl === 'string'
      && Array.isArray(result.candidates) && result.candidates.length > 0 && result.counts?.returned === result.candidates.length
      && result.candidates.every((c) => Array.isArray(c?.legacy) && c.legacy.length === 7
        && (c.title === null || typeof c.title === 'string') && (c.productUrl === null || typeof c.productUrl === 'string')
        && (!batch || Array.isArray(c.matchItemIds) && new Set(c.matchItemIds.map(String)).size === c.matchItemIds.length
          && c.matchItemIds.every((id) => items.some((item) => item.itemId === id))))
    : Array.isArray(result) && result.every((row) => Array.isArray(row) && row.length === 7);
  const deadlineAt = Date.now() + 25000;
  const bounded = async (work, ms) => {
    if (ms <= 0) throw new Error('SEARCH_RESULT_TIMEOUT');
    if (typeof setTimeout !== 'function' || typeof clearTimeout !== 'function') throw new Error('SEARCH_RESULT_TRANSPORT');
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('SEARCH_RESULT_TIMEOUT')), ms);
      })]);
    } finally { clearTimeout(timer); }
  };
  let transferred = false;
  try {
  const raw = await bounded(() => page.evaluate(({ model, detailed, items, transferKey, deadlineAt }) => {
    // 迟到的调用不重新读取页面或创建已过期的传输槽。
    if (Date.now() >= deadlineAt) return { ok: false, error: 'SEARCH_RESULT_TIMEOUT' };
    const result = (() => {
    const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = norm(model); const parts = model.split('-');
    const hints = (value, text) => { const bits = value.split('-'); return norm(text).includes(norm(value))
      || bits.length >= 2 && norm(text).includes(norm(bits[0])) && text.toUpperCase().includes(bits[1].toUpperCase()); };
    const sel = 'a[href*="item.taobao.com/item.htm"], a[href*="detail.tmall.com/item.htm"]';
    const idOf = (h) => (h.match(/[?&]id=(\d+)/) || [])[1];
    const links = [...document.querySelectorAll(sel)];
    const out = []; const candidates = []; const seen = new Set();
    for (const a of links) {
      const id = idOf(a.href); if (!id || seen.has(id)) continue;
      let card = a;
      while (card.parentElement) { const ids = new Set([...card.parentElement.querySelectorAll(sel)].map(x => idOf(x.href))); if (ids.size > 1) break; card = card.parentElement; }
      seen.add(id);
      const t = card.innerText.replace(/\s+/g, ' ');
      const paid = t.match(/(\d+(?:\.\d+)?)\s*(万)?\s*\+?\s*人付款/);
      const paidCount = paid ? Number(paid[1]) * (paid[2] ? 10000 : 1) : 0;
      const variant = parts.length >= 2 && norm(t).includes(norm(parts[0])) && t.toUpperCase().includes(parts[1].toUpperCase());
      out.push([out.length + 1, id, parseFloat(((t.match(/¥\s*([\d.]+)/) || [])[1]) || '0'), paidCount, norm(t).includes(key) || variant ? 1 : 0, /基本全新|二手|拆机|翻新|99新|九成新/.test(t) ? 1 : 0, /广告|掌柜热卖/.test(t) ? 1 : 0]);
      if (detailed) {
        const titles = card.querySelectorAll('[class*="title--"]');
        const title = titles.length === 1 ? titles[0].textContent.trim().replace(/\s+/g, ' ') || null : null;
        const url = new URL(a.href);
        const productUrl = ['item.taobao.com', 'detail.tmall.com'].includes(url.hostname) && url.pathname === '/item.htm' && url.searchParams.get('id') === id && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
          ? url.origin + url.pathname + '?id=' + id : null;
        candidates.push({ legacy: out[out.length - 1], title, productUrl,
          ...(items ? { matchItemIds: items.filter((item) => hints(item.model, t)).map((item) => item.itemId) } : {}) });
      }
    }
    if (!detailed) return out;
    if (!out.length) return { ok: false, error: 'SEARCH_CANDIDATES_UNAVAILABLE', scope: 'current-dom' };
    return { ok: true, scope: 'current-dom', pageUrl: location.href, candidates,
      counts: { matchedAnchors: links.length, cardCandidates: out.length, returned: candidates.length } };
    })();
    const text = JSON.stringify(result);
    if (Date.now() >= deadlineAt) return { ok: false, error: 'SEARCH_RESULT_TIMEOUT' };
    // 只传同一 DOM 快照；不让 BrowserOS 的 5000 UTF-8 字节文件引用冒充候选。
    if (new TextEncoder().encode(text).length <= 4000) return result;
    const slot = { text, timer: null };
    globalThis[transferKey] = slot;
    slot.timer = setTimeout(() => { delete globalThis[transferKey]; }, 60000);
    return { transfer: true, length: text.length, first: text.slice(0, 600) };
  }, { model, detailed, items, transferKey, deadlineAt }), deadlineAt - Date.now());
  const res = unwrap(raw);
  if (Date.now() >= deadlineAt) { transferred = true; return { ok: false, error: 'SEARCH_RESULT_TIMEOUT' }; }
  if (raw?.writtenToFile || res?.writtenToFile) { transferred = true; return { ok: false, error: 'SEARCH_RESULT_TRANSPORT' }; }
  if (res?.transfer !== true) {
    if (!valid(res)) { transferred = true; return { ok: false, error: 'SEARCH_RESULT_TRANSPORT' }; }
    return res;
  }
  transferred = true;
  if (!Number.isSafeInteger(res.length) || res.length <= 600 || typeof res.first !== 'string' || res.first.length !== 600) return { ok: false, error: 'SEARCH_RESULT_TRANSPORT' };
  let text = res.first;
  for (let i = 600; i < res.length; i += 600) {
    if (Date.now() >= deadlineAt) return { ok: false, error: 'SEARCH_RESULT_TIMEOUT' };
    const rawPart = await bounded(() => page.evaluate(({ transferKey, i }) => {
      const slot = globalThis[transferKey];
      return slot ? { part: slot.text.slice(i, i + 600) } : { error: 'SEARCH_RESULT_EXPIRED' };
    }, { transferKey, i }), deadlineAt - Date.now());
    const part = unwrap(rawPart);
    if (Date.now() >= deadlineAt) return { ok: false, error: 'SEARCH_RESULT_TIMEOUT' };
    if (rawPart?.writtenToFile || part?.writtenToFile || typeof part?.part !== 'string' || part.part.length !== Math.min(600, res.length - i)) return { ok: false, error: 'SEARCH_RESULT_TRANSPORT' };
    text += part.part;
  }
  if (text.length !== res.length) return { ok: false, error: 'SEARCH_RESULT_TRANSPORT' };
  const result = JSON.parse(text);
  if (!valid(result)) return { ok: false, error: 'SEARCH_RESULT_TRANSPORT' };
  return result;
  } catch (error) {
    transferred = true;
    return { ok: false, error: error?.message === 'SEARCH_RESULT_TIMEOUT' ? 'SEARCH_RESULT_TIMEOUT' : 'SEARCH_RESULT_TRANSPORT' };
  }
  finally {
    if (transferred) {
      try {
        // 清理使用独立短预算，通信挂起不拖住原结果；页面 TTL 仍是兜底。
        await bounded(() => page.evaluate((transferKey) => {
          const slot = globalThis[transferKey];
          if (slot) { clearTimeout(slot.timer); delete globalThis[transferKey]; }
          return true;
        }, transferKey), 500);
      } catch { /* 导航/断开时原快照随文档销毁；否则最迟 60 秒过期。 */ }
    }
  }
}
```
