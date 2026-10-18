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
  const res = await page.evaluate(async ({ contact, headerName }) => {
    const chatDocument = () => { try { return document.querySelector('iframe')?.contentDocument; } catch { return null; } };
    const d = chatDocument();
    if (!d) return { ok: false, error: 'CHAT_DOM' };
    const items = [...d.querySelectorAll('.conversation-item')].filter((e) => (e.querySelector('.name')?.textContent || '').trim() === contact);
    if (items.length !== 1) return { ok: false, error: items.length ? 'CHAT_AMBIGUOUS' : 'CHAT_NOT_FOUND' };
    if (typeof MutationObserver !== 'function' || typeof setTimeout !== 'function' || typeof clearTimeout !== 'function') {
      return { ok: false, error: 'CHAT_WAIT_UNAVAILABLE' };
    }
    // 标题可能先于消息切换；每条消息的有限 Fiber 归属必须与当前 active.id 一致，才读取正文。
    const binding = (element, id) => {
      const keys = Object.keys(element).filter((k) => k.startsWith('__reactFiber$'));
      if (keys.length !== 1) return 'CHAT_BINDING_UNAVAILABLE';
      let fiber = element[keys[0]];
      for (let depth = 0; fiber && depth < 6; depth++, fiber = fiber.return) {
        const message = fiber.memoizedProps?.message;
        const alternate = fiber.alternate?.memoizedProps?.message;
        if (!message && !alternate) continue;
        if (typeof message?.conversationCode !== 'string' || !message.conversationCode) return 'CHAT_BINDING_UNAVAILABLE';
        if (message.conversationCode !== id) return 'CHAT_MESSAGE_IDENTITY';
        if (alternate && alternate.conversationCode !== id) return 'CHAT_MESSAGE_IDENTITY';
        return null;
      }
      return 'CHAT_BINDING_UNAVAILABLE';
    };
    let outerObserver, innerObserver, observedDocument, timer, inspect;
    let last = { ok: false, error: 'CHAT_DOM' };
    try {
      return await new Promise((resolve) => {
        let settled = false;
        let clicked = false;
        const deadlineAt = Date.now() + 2200;
        const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
        inspect = () => {
          if (settled) return;
          if (Date.now() >= deadlineAt) { finish({ ...last, timedOut: true }); return; }
          try {
            const current = chatDocument();
            if (current !== observedDocument) {
              innerObserver?.disconnect();
              observedDocument = current;
              if (current) {
                innerObserver = new MutationObserver(inspect);
                innerObserver.observe(current, { childList: true, subtree: true, characterData: true, attributes: true });
              }
            }
            if (!clicked) return;
            if (!current) { last = { ok: false, error: 'CHAT_DOM' }; return; }
            const header = current.querySelector('.conversation-header')?.innerText.trim() || '';
            const matches = [...current.querySelectorAll('.conversation-item')].filter((e) => (e.querySelector('.name')?.textContent || '').trim() === contact);
            const active = [...current.querySelectorAll('.conversation-item.active')];
            last = { ok: false, error: 'CHAT_IDENTITY', header };
            if (matches.length !== 1 || active.length !== 1 || active[0] !== matches[0] || header !== headerName || !active[0].id?.trim()) return;
            const messages = [...current.querySelectorAll('.message-item')];
            if (!messages.length) { last = { ok: false, error: 'CHAT_MESSAGES_UNAVAILABLE', header }; return; }
            for (const message of messages) {
              const error = binding(message, active[0].id);
              if (error) { last = { ok: false, error, header }; return; }
            }
            // 已绑定的富消息也可能先呈现占位，随后才渲染客服评价等正文；不能把占位当成完整消息。
            if (messages.some((message) => [...message.querySelectorAll('.content > span')]
              .some((span) => span.textContent.trim() === '暂不支持的消息类型'))) {
              last = { ok: false, error: 'CHAT_MESSAGES_RENDERING', header };
              return;
            }
            finish({ ok: true, header, conv: messages.map((e) => e.innerText.trim()).join('\n').slice(-1500) });
          } catch { last = { ok: false, error: 'CHAT_DOM' }; }
        };
        outerObserver = new MutationObserver(inspect);
        outerObserver.observe(document, { childList: true, subtree: true });
        document.addEventListener('load', inspect, true);
        timer = setTimeout(() => finish({ ...last, timedOut: true }), 2200);
        inspect();
        // 即使目标当前已打开也保留一次明确选择；读取只发生在 click 后的检查。
        clicked = true;
        items[0].click();
        inspect();
      });
    } finally {
      outerObserver?.disconnect();
      innerObserver?.disconnect();
      clearTimeout(timer);
      document.removeEventListener('load', inspect, true);
    }
  }, { contact, headerName });
  return res && res.value !== undefined ? res.value : res;
}
```
