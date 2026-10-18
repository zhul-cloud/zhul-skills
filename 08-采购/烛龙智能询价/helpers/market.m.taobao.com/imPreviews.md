---
name: "imPreviews"
host: "market.m.taobao.com"
lastVerified: 1792045971229
agent: "claude"
candidate: false
opensPage: false
description: "烛龙智能询价：Saved helper for market.m.taobao.com"
inputs: {}
---

注册时按 [BrowserOS 准备协议](../../references/browseros-setup.md)使用 `scripts/helpers.mjs` 生成适配源码；运行时名带平台前缀，避免同一次 run 内跨域同名互相覆盖。Markdown 的 `name` 和下方原函数保留源码身份。

Call it:

`helpers["zhul_taobao_imPreviews"](browser, pageId, keys)`

```js
async (browser, pageId, keys) => {
  // 只读完整列表名的唯一匹配预览；拒绝空名、重复名及前缀碰撞，不点开会话。
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || !k.trim())) return { ok: false, error: 'SKILL_INPUT' };
  const page = browser.page(pageId);
  const res = await page.evaluate((keys) => {
    const d = document.querySelector('iframe')?.contentDocument; const o = Object.create(null);
    if (!d) return { ok: false, error: 'CHAT_DOM' };
    for (const k of keys) {
      const found = [...d.querySelectorAll('.conversation-item')].filter((e) => (e.querySelector('.name')?.textContent || '').trim() === k.trim());
      if (found.length > 1) return { ok: false, error: 'CHAT_AMBIGUOUS' };
      if (found.length === 1) o[k] = found[0].innerText.replace(/\n+/g, ' / ').slice(0, 120);
    }
    return o;
  }, keys);
  return res && res.value !== undefined ? res.value : res;
}
```
