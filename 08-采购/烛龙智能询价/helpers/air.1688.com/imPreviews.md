---
name: "imPreviews"
host: "air.1688.com"
lastVerified: 1792067650292
agent: "claude"
candidate: false
opensPage: false
description: "烛龙智能询价：Saved helper for air.1688.com"
inputs: {}
---

烛龙智能询价：Saved helper for air.1688.com

注册时按 [BrowserOS 准备协议](../../references/browseros-setup.md)使用 `scripts/helpers.mjs` 生成适配源码；运行时名带平台前缀，避免同一次 run 内跨域同名互相覆盖。Markdown 的 `name` 和下方原函数保留源码身份。

Call it:

`helpers["zhul_1688_imPreviews"](browser, pageId, keys)`

```js
async (browser, pageId, keys) => {
  // 只读完整列表名的唯一匹配预览；不匹配预览里的店名，不点开其他会话。
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || !k.trim())) return { ok: false, error: 'SKILL_INPUT' };
  const page = browser.page(pageId);
  const res = await page.evaluate((keys) => {
    const f = [...document.querySelectorAll('iframe')].find((f) => { try { return f.contentDocument.querySelector('.conversation-header'); } catch { return false; } });
    if (!f) return { error: '找不到聊天 iframe，页面可能还在加载' };
    const o = Object.create(null);
    const nameOf = (e) => (e.querySelector('.name')?.textContent || e.innerText.split(/\r?\n/)[0] || '').trim();
    for (const k of keys) {
      const found = [...f.contentDocument.querySelectorAll('.content')].filter((e) => nameOf(e) === k.trim());
      if (found.length > 1) return { ok: false, error: 'CHAT_AMBIGUOUS' };
      if (found.length === 1) o[k] = found[0].innerText.replace(/\s+/g, ' ').trim().slice(0, 160);
    }
    return o;
  }, keys);
  return res && res.value !== undefined ? res.value : res;
}
```
