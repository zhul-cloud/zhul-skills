---
name: "imPreviews"
host: "market.m.taobao.com"
lastVerified: 1792045971229
agent: "claude"
candidate: false
opensPage: true
description: "Saved helper for market.m.taobao.com"
inputs: {}
---

Saved helper for market.m.taobao.com

Call it:

`helpers["imPreviews"](browser)`

```js
async (browser, pageId, keys) => {
  // 只读：返回会话列表中名称包含 keys 的会话预览（名称 / 时间 / 最后一条 / 未读数），不点开、不读其他会话
  const page = browser.page(pageId);
  const res = await page.evaluate((keys) => {
    const d = document.querySelector('iframe').contentDocument; const o = {};
    for (const e of d.querySelectorAll('.conversation-item')) {
      const n = (e.querySelector('.name')?.textContent || '').trim();
      const k = keys.find(k => n.includes(k)); if (k) o[k] = e.innerText.replace(/\n+/g, ' / ').slice(0, 120);
    }
    return o;
  }, keys);
  return res && res.value !== undefined ? res.value : res;
}
```
