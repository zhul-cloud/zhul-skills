---
name: "imPreviews"
host: "air.1688.com"
lastVerified: 1792067650292
agent: "claude"
candidate: false
opensPage: true
description: "Saved helper for air.1688.com"
inputs: {}
---

Saved helper for air.1688.com

Call it:

`helpers["imPreviews"](browser)`

```js
async (browser, pageId, keys) => {
  // 只读：返回 1688 网页版聊天会话列表中名称包含 keys 的会话预览（聊天名 / 时间 / 最后一条），不点开、不读其他会话
  const page = browser.page(pageId);
  const res = await page.evaluate((keys) => {
    const f = [...document.querySelectorAll('iframe')].find((f) => { try { return f.contentDocument.querySelector('.conversation-header'); } catch { return false; } });
    if (!f) return { error: '找不到聊天 iframe，页面可能还在加载' };
    const o = {};
    for (const e of f.contentDocument.querySelectorAll('.content')) {
      const t = e.innerText.replace(/\s+/g, ' ').trim();
      if (t.length > 200) continue;
      const k = keys.find((k) => t.includes(k));
      if (k && !o[k]) o[k] = t.slice(0, 160);
    }
    return o;
  }, keys);
  return res && res.value !== undefined ? res.value : res;
}
```
