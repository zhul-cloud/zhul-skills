---
name: "imOpenAndRead"
host: "market.m.taobao.com"
lastVerified: 1792045971240
agent: "claude"
candidate: false
opensPage: false
description: "烛龙智能询价：Saved helper for market.m.taobao.com"
inputs: {}
---

烛龙智能询价：Saved helper for market.m.taobao.com

Call it:

`helpers["imOpenAndRead"](browser, pageId, key)`

```js
async (browser, pageId, key) => {
  // 点开名称包含 key 的会话，用 .conversation-header 核对当前会话，返回本会话从我方询价开始、截取末尾 1500 字符的消息；核对完整历史时须另行读取
  const page = browser.page(pageId);
  await page.evaluate((key) => { const d = document.querySelector('iframe').contentDocument; const it = [...d.querySelectorAll('.conversation-item')].find(e => (e.querySelector('.name')?.textContent || '').includes(key)); it && it.click(); }, key);
  await page.waitForTime(2200);
  const res = await page.evaluate((key) => {
    const d = document.querySelector('iframe').contentDocument;
    const header = d.querySelector('.conversation-header')?.innerText.trim() || '';
    if (!header.includes(key)) return { ok: false, header };
    const t = d.body.innerText; const end = t.indexOf('0 / 500');
    const start = t.lastIndexOf(header, t.lastIndexOf('\n', end - 1));
    const conv = t.slice(t.indexOf('\n', t.lastIndexOf(key, t.lastIndexOf('帮我查一下', end))) + 1, end).trim();
    return { ok: true, header, conv: conv.slice(-1500) };
  }, key);
  return res && res.value !== undefined ? res.value : res;
}
```
