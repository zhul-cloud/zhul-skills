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

注册时按 [BrowserOS 准备协议](../../references/browseros-setup.md)使用 `scripts/helpers.mjs` 生成适配源码；运行时名带平台前缀，避免同一次 run 内跨域同名互相覆盖。Markdown 的 `name` 和下方原函数保留源码身份。

Call it:

`helpers["zhul_taobao_imOpenAndRead"](browser, pageId, key)`

```js
async (browser, pageId, key) => {
  // key 为完整列表名；已核实客服别名时可传 { contact, headerName }，不以子串匹配聊天对象。
  const contact = typeof key === 'string' ? key.trim() : typeof key?.contact === 'string' ? key.contact.trim() : '';
  const headerName = typeof key === 'string' || key?.headerName === undefined ? contact : typeof key.headerName === 'string' ? key.headerName.trim() : '';
  if (!contact || !headerName) return { ok: false, error: 'SKILL_INPUT' };
  const page = browser.page(pageId);
  const selected = await page.evaluate((contact) => {
    const d = document.querySelector('iframe')?.contentDocument;
    if (!d) return { ok: false, error: 'CHAT_DOM' };
    const items = [...d.querySelectorAll('.conversation-item')].filter((e) => (e.querySelector('.name')?.textContent || '').trim() === contact);
    if (items.length !== 1) return { ok: false, error: items.length ? 'CHAT_AMBIGUOUS' : 'CHAT_NOT_FOUND' };
    items[0].click();
    return { ok: true };
  }, contact);
  const opened = selected && selected.value !== undefined ? selected.value : selected;
  if (!opened?.ok) return opened;
  await page.waitForTime(2200);
  const res = await page.evaluate(({ contact, headerName }) => {
    const d = document.querySelector('iframe')?.contentDocument;
    if (!d) return { ok: false, error: 'CHAT_DOM' };
    const header = d.querySelector('.conversation-header')?.innerText.trim() || '';
    const active = [...d.querySelectorAll('.conversation-item.active')];
    if (active.length !== 1 || (active[0].querySelector('.name')?.textContent || '').trim() !== contact || header !== headerName) {
      return { ok: false, error: 'CHAT_IDENTITY', header };
    }
    // 只读当前消息项；不再从整页 body 截取，避免带入其他会话预览。
    const messages = [...d.querySelectorAll('.message-item')];
    if (!messages.length) return { ok: false, error: 'CHAT_MESSAGES_UNAVAILABLE', header };
    return { ok: true, header, conv: messages.map((e) => e.innerText.trim()).join('\n').slice(-1500) };
  }, { contact, headerName });
  return res && res.value !== undefined ? res.value : res;
}
```
