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
  // 结束信号「客服评价邀请」只出现在列表预览里，判断是否结束要看 preview。
  const contact = typeof key === 'string' ? key.trim() : typeof key?.contact === 'string' ? key.contact.trim() : '';
  const headerName = typeof key === 'string' || key?.headerName === undefined ? contact : typeof key.headerName === 'string' ? key.headerName.trim() : '';
  if (!contact || !headerName) return { ok: false, error: 'SKILL_INPUT' };
  const page = browser.page(pageId);
  const res = await page.evaluate(async ({ contact, headerName }) => {
    const chatDocument = () => [...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).find((d) => d && d.querySelector('.conversation-header'));
    const nameOf = (e) => (e.querySelector('.name')?.textContent || e.innerText.split(/\r?\n/)[0] || '').trim();
    const contacts = (d) => [...d.querySelectorAll('.content')].filter((e) => e.closest('.conversation-item') && nameOf(e) === contact);
    const d = chatDocument();
    if (!d) return { ok: false, error: 'CHAT_DOM' };
    const items = contacts(d);
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
    // 公司档案独立于消息加载；只查看当前档案节点的有限祖先，不遍历应用状态。
    const propsFor = (element, key) => {
      const keys = Object.keys(element).filter((k) => k.startsWith('__reactFiber$'));
      if (keys.length !== 1) return null;
      let fiber = element[keys[0]];
      for (let depth = 0; fiber && depth < 6; depth++, fiber = fiber.return) {
        const current = fiber.memoizedProps, alternate = fiber.alternate?.memoizedProps;
        if ((current && Object.hasOwn(current, key)) || (alternate && Object.hasOwn(alternate, key))) return { current, alternate };
      }
      return null;
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
            const headerElement = current.querySelector('.conversation-header');
            const header = headerElement?.innerText.replace(/\s+/g, ' ').trim() || '';
            const identity = headerElement?.cloneNode(true);
            for (const control of identity?.querySelectorAll('a, button, .go-shop') || []) if (control.textContent.trim() === '进店') control.remove();
            const matches = contacts(current);
            const active = [...current.querySelectorAll('.conversation-item.active')];
            last = { ok: false, error: 'CHAT_IDENTITY', header };
            if (matches.length !== 1 || active.length !== 1 || active[0] !== matches[0].closest('.conversation-item') || identity?.textContent.trim() !== headerName || !active[0].id?.trim()) return;
            const messages = [...current.querySelectorAll('.message-item')].filter((e) => !e.classList.contains('message-item-line'));
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
            const profiles = [...current.querySelectorAll('.information-tab')];
            last = { ok: false, error: 'CHAT_PROFILE_UNAVAILABLE', header };
            if (profiles.length !== 1) return;
            const profile = profiles[0];
            const identityProps = propsFor(profile, 'activeConversationName');
            if (!identityProps?.current) return;
            last = { ok: false, error: 'CHAT_PROFILE_IDENTITY', header };
            if (identityProps.current.activeConversationName !== contact || identityProps.current.activeDomain !== 'cnalichn' ||
              (identityProps.alternate && (identityProps.alternate.activeConversationName !== contact || identityProps.alternate.activeDomain !== identityProps.current.activeDomain))) return;
            const loadings = [...profile.querySelectorAll('.next-loading')];
            last = { ok: false, error: 'CHAT_PROFILE_RENDERING', header };
            if (loadings.length !== 1) return;
            const loadingProps = propsFor(loadings[0], 'visible');
            if (loadingProps?.current?.visible !== false || (loadingProps.alternate && loadingProps.alternate.visible !== false) || loadings[0].classList.contains('next-open')) return;
            const companyNodes = [...profile.querySelectorAll('.nameLine')];
            if (companyNodes.length !== 1) return;
            const company = companyNodes[0].innerText;
            if (!company?.trim()) return;
            const msgs = messages.map((e) => ({ self: e.classList.contains('self'), text: e.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) }));
            const preview = matches[0].innerText.replace(/\s+/g, ' ').trim();
            finish({ ok: true, header, company, preview, ended: /客服评价邀请/.test(preview), msgs: msgs.slice(-20) });
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
