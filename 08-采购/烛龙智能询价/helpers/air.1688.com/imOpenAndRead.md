---
name: "imOpenAndRead"
host: "air.1688.com"
lastVerified: 1792067650292
agent: "claude"
candidate: false
opensPage: false
description: "烛龙智能询价：Saved helper for air.1688.com"
inputs: {}
---

烛龙智能询价：Saved helper for air.1688.com

Call it:

`helpers["imOpenAndRead"](browser, pageId, key)`

```js
async (browser, pageId, key) => {
  // 点开聊天名包含 key 的会话（会标为已读），用 .conversation-header 核对当前会话，返回最近的消息（最多 20 条）和该会话在列表里的预览
  // 结束信号「客服评价邀请」只出现在列表预览里，不在消息里，判断是否结束要看 preview
  const page = browser.page(pageId);
  await page.evaluate((key) => {
    const d = [...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).find((d) => d && d.querySelector('.conversation-header'));
    const it = d && [...d.querySelectorAll('.content')].find((e) => e.innerText.length < 200 && e.innerText.includes(key));
    it && it.click();
  }, key);
  await page.waitForTime(2200);
  const res = await page.evaluate((key) => {
    const d = [...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).find((d) => d && d.querySelector('.conversation-header'));
    if (!d) return { ok: false, error: '找不到聊天 iframe' };
    const header = d.querySelector('.conversation-header').innerText.replace(/\s+/g, ' ').trim();
    if (!header.includes(key)) return { ok: false, header };
    const msgs = [...d.querySelectorAll('.message-item')]
      .filter((e) => !e.classList.contains('message-item-line'))
      .map((e) => ({ self: e.classList.contains('self'), text: e.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) }));
    const item = [...d.querySelectorAll('.content')].find((e) => e.innerText.length < 200 && e.innerText.includes(key));
    const preview = item ? item.innerText.replace(/\s+/g, ' ').trim() : '';
    return { ok: true, header, company: (d.querySelector('.nameLine') || {}).innerText || '', preview, ended: /客服评价邀请/.test(preview), msgs: msgs.slice(-20) };
  }, key);
  return res && res.value !== undefined ? res.value : res;
}
```
