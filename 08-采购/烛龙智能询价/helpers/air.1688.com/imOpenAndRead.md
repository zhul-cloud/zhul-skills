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

注册时按 [BrowserOS 准备协议](../../references/browseros-setup.md)使用 `scripts/helpers.mjs` 生成适配源码；运行时名带平台前缀，避免同一次 run 内跨域同名互相覆盖。Markdown 的 `name` 和下方原函数保留源码身份。

Call it:

`helpers["zhul_1688_imOpenAndRead"](browser, pageId, key)`

```js
async (browser, pageId, key) => {
  // key 为完整列表名；已核实客服别名时可传 { contact, headerName }。点开会标为已读。
  // 结束信号「客服评价邀请」只出现在列表预览里，不在消息里，判断是否结束要看 preview
  const contact = typeof key === 'string' ? key.trim() : typeof key?.contact === 'string' ? key.contact.trim() : '';
  const headerName = typeof key === 'string' || key?.headerName === undefined ? contact : typeof key.headerName === 'string' ? key.headerName.trim() : '';
  if (!contact || !headerName) return { ok: false, error: 'SKILL_INPUT' };
  const page = browser.page(pageId);
  const selected = await page.evaluate((contact) => {
    const d = [...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).find((d) => d && d.querySelector('.conversation-header'));
    if (!d) return { ok: false, error: 'CHAT_DOM' };
    const nameOf = (e) => (e.querySelector('.name')?.textContent || e.innerText.split(/\r?\n/)[0] || '').trim();
    const found = [...d.querySelectorAll('.content')].filter((e) => nameOf(e) === contact);
    if (found.length !== 1) return { ok: false, error: found.length ? 'CHAT_AMBIGUOUS' : 'CHAT_NOT_FOUND' };
    found[0].click();
    return { ok: true };
  }, contact);
  const opened = selected && selected.value !== undefined ? selected.value : selected;
  if (!opened?.ok) return opened;
  await page.waitForTime(2200);
  const res = await page.evaluate(({ contact, headerName }) => {
    const d = [...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).find((d) => d && d.querySelector('.conversation-header'));
    if (!d) return { ok: false, error: '找不到聊天 iframe' };
    const headerElement = d.querySelector('.conversation-header');
    const header = headerElement.innerText.replace(/\s+/g, ' ').trim();
    // “进店”为界面操作，仅当独立控件出现时去除；不从整段标题里盲删文字。
    const identity = headerElement.cloneNode(true);
    for (const control of identity.querySelectorAll('a, button, .go-shop')) if (control.textContent.trim() === '进店') control.remove();
    if (identity.textContent.trim() !== headerName) return { ok: false, error: 'CHAT_IDENTITY', header };
    const nameOf = (e) => (e.querySelector('.name')?.textContent || e.innerText.split(/\r?\n/)[0] || '').trim();
    const found = [...d.querySelectorAll('.content')].filter((e) => nameOf(e) === contact);
    if (found.length !== 1) return { ok: false, error: 'CHAT_IDENTITY', header };
    const msgs = [...d.querySelectorAll('.message-item')]
      .filter((e) => !e.classList.contains('message-item-line'))
      .map((e) => ({ self: e.classList.contains('self'), text: e.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) }));
    const preview = found[0].innerText.replace(/\s+/g, ' ').trim();
    return { ok: true, header, company: (d.querySelector('.nameLine') || {}).innerText || '', preview, ended: /客服评价邀请/.test(preview), msgs: msgs.slice(-20) };
  }, { contact, headerName });
  return res && res.value !== undefined ? res.value : res;
}
```
