---
name: "searchCandidates"
host: "s.1688.com"
lastVerified: 1792328204332
agent: "codex"
candidate: false
opensPage: false
description: "烛龙智能询价：Saved helper for s.1688.com"
inputs: {}
---

烛龙智能询价：Saved helper for s.1688.com

注册时按 [BrowserOS 准备协议](../../references/browseros-setup.md)使用 `scripts/helpers.mjs` 生成适配源码；运行时名带平台前缀，避免同一次 run 内跨域同名互相覆盖。Markdown 的 `name` 和下方原函数保留源码身份。

Call it:

`helpers["zhul_1688_searchCandidates"](browser, pageId, { model, mode: "current-dom" })`

对象调用返回当前 DOM 的全部候选及独立标题、直达商品 URL；不表示整页已经加载完毕。字符串 `model` 调用仍返回原 7 字段数组的前 20 条，仅用于旧入口兼容。筛选和覆盖边界见 [1688 平台说明](../../platforms/1688.md#2-搜索)。

```js
async (browser, pageId, input) => {
  const detailed = typeof input === 'object' && input !== null && !Array.isArray(input);
  const model = detailed ? input.model : input;
  if (typeof model !== 'string' || !model.trim() || detailed && input.mode !== 'current-dom') return { ok: false, error: 'SKILL_INPUT' };
  const page = browser.page(pageId);
  const transferKey = '__zhul_search_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const unwrap = (res) => res && res.value !== undefined ? res.value : res;
  const valid = (result) => detailed ? result?.ok === false && typeof result.error === 'string'
    || result?.ok === true && result.scope === 'current-dom' && typeof result.pageUrl === 'string'
      && Array.isArray(result.candidates) && result.candidates.length > 0 && result.counts?.returned === result.candidates.length
      && result.candidates.every((c) => Array.isArray(c?.legacy) && c.legacy.length === 7
        && (c.title === null || typeof c.title === 'string') && (c.productUrl === null || typeof c.productUrl === 'string'))
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
  const raw = await bounded(() => page.evaluate(({ model, detailed, transferKey, deadlineAt }) => {
    // 迟到的调用不重新读取页面或创建已过期的传输槽。
    if (Date.now() >= deadlineAt) return { ok: false, error: 'SEARCH_RESULT_TIMEOUT' };
    const result = (() => {
    const norm = (x) => x.toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');
    const key = norm(model);
    const links = [...document.querySelectorAll('a[href]')].filter((a) => /detail\.1688\.com\/offer\/\d+|dj\.1688\.com/.test(a.href));
    const out = []; const candidates = []; const seen = new Set();
    for (const a of links) {
      let card = a;
      for (let i = 0; i < 8 && card.parentElement && !/offerCard|ad-common/.test(card.className.toString()); i++) card = card.parentElement;
      if (seen.has(card)) continue;
      seen.add(card);
      const t = card.innerText.replace(/\s+/g, ' ');
      const id = (a.href.match(/offer\/(\d+)\.html/) || [])[1] || '';
      const ad = /dj\.1688\.com/.test(a.href) || /ad-common/.test(card.className.toString()) ? 1 : 0;
      const company = (t.match(/[一-龥()（）A-Za-z0-9]{2,30}(有限公司|商行|经营部|商贸部|工作室)/) || [])[0] || '';
      out.push([out.length + 1, id, parseFloat(((t.match(/¥\s*([\d.]+)/) || [])[1]) || '0'), company,
        norm(t).includes(key) ? 1 : 0, /基本全新|二手|拆机|翻新|99新|九成新/.test(t) ? 1 : 0, ad]);
      if (detailed) {
        const titles = card.querySelectorAll('[class*="titleText--"]');
        const title = titles.length === 1 ? titles[0].textContent.trim().replace(/\s+/g, ' ') || null : null;
        const url = new URL(a.href);
        const productUrl = url.hostname === 'detail.1688.com' && url.pathname === '/offer/' + id + '.html' && id && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
          ? url.origin + url.pathname : null;
        candidates.push({ legacy: out[out.length - 1], title, productUrl });
      }
    }
    if (!detailed) return out.slice(0, 20);
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
  }, { model, detailed, transferKey, deadlineAt }), deadlineAt - Date.now());
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
