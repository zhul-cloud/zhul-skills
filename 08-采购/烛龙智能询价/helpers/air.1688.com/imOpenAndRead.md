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
  const mode = typeof key === 'object' && key ? key.op || (key.binding ? 'read' : 'legacy') : 'legacy';
  const expected = typeof key === 'object' && key ? key.binding : undefined;
  const contact = typeof key === 'string' ? key.trim() : typeof key?.contact === 'string' ? key.contact.trim() : typeof expected?.contact === 'string' ? expected.contact.trim() : '';
  const headerName = typeof key === 'string' || key?.headerName === undefined ? (expected?.headerName || contact) : typeof key.headerName === 'string' ? key.headerName.trim() : '';
  if (!['legacy', 'account', 'read', 'rebind'].includes(mode) || mode !== 'account' && (!contact || !headerName) || mode === 'rebind' && !expected || expected && !['read', 'rebind'].includes(mode)) return { ok: false, error: 'SKILL_INPUT' };
  const page = browser.page(pageId);
  const transferKey = '__zhul_chat_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const unwrap = (res) => res && res.value !== undefined ? res.value : res;
  let transferred = false;
  try {
  const res = unwrap(await page.evaluate(async ({ contact, headerName, mode, expected, transferKey }) => {
    const result = await (async () => {
    const wantedIdentity = mode !== 'legacy';
    const platform = "1688";
    const spec = platform === '淘宝' ? { type: 'loginNick', source: 'site-nav-login-info-nick', targetType: '3', bizType: '11001' }
      : { type: 'loginId', source: 'conversation-list.currentLoginId', targetType: '8', bizType: '11152' };
    const namedProps = (element, key) => {
      const keys = Object.keys(element).filter((k) => k.startsWith('__reactFiber$'));
      if (keys.length !== 1) return null;
      let fiber = element[keys[0]];
      for (let n = 0; fiber && n < 6; n++, fiber = fiber.return) {
        const current = fiber.memoizedProps, alternate = fiber.alternate?.memoizedProps;
        if ((current && Object.hasOwn(current, key)) || (alternate && Object.hasOwn(alternate, key))) return { current, alternate };
      }
      return null;
    };
    const accountOf = (d) => {
      if (platform === '淘宝') {
        const nodes = [...document.querySelectorAll('.site-nav-login-info-nick')];
        const value = nodes.length === 1 ? nodes[0].textContent.trim() : '';
        return value ? { type: spec.type, value, source: spec.source } : null;
      }
      const lists = [...d.querySelectorAll('.conversation-list')];
      if (lists.length !== 1) return null;
      const props = namedProps(lists[0], 'currentLoginId');
      const value = props?.current?.currentLoginId;
      if (typeof value !== 'string' || !value.trim() || value !== value.trim() || (props.alternate && props.alternate.currentLoginId !== value)) return null;
      return { type: spec.type, value, source: spec.source };
    };
    const sameAccount = (a, b) => a && b && a.type === b.type && a.value === b.value && a.source === b.source;
    const sameRecipient = (a, b) => a && b && typeof a.targetId === 'string' && !!a.targetId && ['targetId', 'targetType', 'bizType', 'entityType', 'channelType', 'source'].every((k) => a?.[k] === b?.[k]);
    const conversationOf = (row) => {
      const props = namedProps(row, 'conversation');
      const read = (c) => {
        const i = c?.conversationIdentifier, target = i?.target;
        if (c?.conversationCode !== row.id || c.channelType !== 3 || i?.entityType !== 'U' || i.bizType !== spec.bizType
          || typeof target?.targetId !== 'string' || !target.targetId || target.targetType !== spec.targetType) return null;
        return { targetId: target.targetId, targetType: target.targetType, entityType: i.entityType, bizType: i.bizType,
          channelType: c.channelType, source: 'conversationIdentifier.target' };
      };
      const recipient = read(props?.current?.conversation);
      if (!recipient || (props.alternate && !sameRecipient(recipient, read(props.alternate.conversation)))) return null;
      return recipient;
    };
    let accountBefore;
    const identityOf = (d, row, messages) => {
      const account = accountOf(d);
      if (!account) return { ok: false, error: 'CHAT_ACCOUNT_UNAVAILABLE' };
      if (!sameAccount(accountBefore, account)) return { ok: false, error: 'CHAT_ACCOUNT_CHANGED' };
      const recipient = conversationOf(row);
      if (!recipient) return { ok: false, error: 'CHAT_RECIPIENT_UNAVAILABLE' };
      if (expected && (!sameRecipient(expected.recipient, recipient) || mode !== 'rebind' && expected.conversationId !== row.id)) return { ok: false, error: 'CHAT_BINDING_CONFLICT' };
      let buyer;
      for (const element of messages.filter((e) => e.classList.contains('self'))) {
        const props = namedProps(element, 'message');
        const nick = element.querySelector('.nick')?.textContent.trim();
        const sender = (message) => {
          const s = message?.sender, uid = message?.originPaasMessageData?.message?.sender?.uid;
          // 真实自身消息的 receiver 可能为空；对象归属由已核验的会话行和每条消息的 conversationCode 确定。
          return typeof s?.targetId === 'string' && s.targetId && s.targetType === spec.targetType && typeof uid === 'string' && uid === s.targetId + '@cntaobao'
            ? { targetId: s.targetId, targetType: s.targetType, uid, displayName: nick, source: 'self-message' } : null;
        };
        const current = sender(props?.current?.message);
        const alternate = props?.alternate ? sender(props.alternate.message) : current;
        if (!current || !alternate || !nick) return { ok: false, error: 'CHAT_SELF_UNAVAILABLE' };
        if (nick !== account.value || ['targetId', 'targetType', 'uid'].some((k) => current[k] !== alternate[k] || buyer && buyer[k] !== current[k])) return { ok: false, error: 'CHAT_SELF_IDENTITY' };
        buyer = current;
      }
      if (!buyer) return { ok: false, error: 'CHAT_SELF_UNAVAILABLE' };
      if (expected && ['targetId', 'targetType', 'uid'].some((k) => expected.buyer?.[k] !== buyer[k])) return { ok: false, error: 'CHAT_SELF_IDENTITY' };
      return { ok: true, identity: { platform, account, recipient, buyer, conversationId: row.id, contact, headerName,
        verifiedAt: new Date().toISOString(), businessIdentity: null } };
    };

    const chatDocument = () => [...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).find((d) => d && d.querySelector('.conversation-header'));
    const nameOf = (e) => (e.querySelector('.name')?.textContent || e.innerText.split(/\r?\n/)[0] || '').trim();
    const contacts = (d) => [...d.querySelectorAll('.content')].filter((e) => e.closest('.conversation-item') && nameOf(e) === contact);
    const d = chatDocument();
    if (!d) return { ok: false, error: 'CHAT_DOM' };
    if (wantedIdentity) {
      accountBefore = accountOf(d);
      if (!accountBefore) return { ok: false, error: 'CHAT_ACCOUNT_UNAVAILABLE' };
      if (mode === 'account') return { ok: true, platform, account: accountBefore };
      if (expected && (expected.platform !== platform || !sameAccount(expected.account, accountBefore))) return { ok: false, error: 'CHAT_ACCOUNT_MISMATCH' };
    }
    let items;
    if (expected) {
      if (!expected.recipient || !expected.buyer || typeof expected.conversationId !== 'string' || !expected.conversationId) return { ok: false, error: 'SKILL_INPUT' };
      let rows;
      if (mode === 'rebind') rows = [...d.querySelectorAll('.conversation-item')].filter((row) => sameRecipient(conversationOf(row), expected.recipient));
      else { const row = d.getElementById(expected.conversationId); rows = row?.classList.contains('conversation-item') ? [row] : []; }
      if (rows.length !== 1) return { ok: false, error: rows.length ? 'CHAT_BINDING_AMBIGUOUS' : 'CHAT_BINDING_STALE' };
      const row = rows[0];
      if (!sameRecipient(conversationOf(row), expected.recipient)) return { ok: false, error: 'CHAT_BINDING_CONFLICT' };
      const name = nameOf(row.querySelector('.content'));
      if (mode === 'rebind') { headerName = name === contact ? headerName : name; contact = name; }
      if (name !== contact) return { ok: false, error: 'CHAT_BINDING_STALE' };
      items = [row.querySelector('.content')];
    } else {
    items = contacts(d);
    if (items.length !== 1) return { ok: false, error: items.length ? 'CHAT_AMBIGUOUS' : 'CHAT_NOT_FOUND' };
    }
    const selectedConversationId = expected ? items[0].closest('.conversation-item').id : null;
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
            const row = expected ? current.getElementById(selectedConversationId) : null;
            const content = row?.classList.contains('conversation-item') ? row.querySelector('.content') : null;
            const matches = expected ? (content && nameOf(content) === contact ? [content] : []) : contacts(current);
            const active = [...current.querySelectorAll('.conversation-item.active')];
            last = { ok: false, error: 'CHAT_IDENTITY', header };
            if (matches.length !== 1 || active.length !== 1 || active[0] !== matches[0].closest('.conversation-item') || identity?.textContent.trim() !== headerName || !active[0].id?.trim()) return;
            const messages = [...current.querySelectorAll('.message-item')].filter((e) => !e.classList.contains('message-item-line'));
            if (!messages.length) { last = { ok: false, error: 'CHAT_MESSAGES_UNAVAILABLE', header }; return; }
            for (const message of messages) {
              const error = binding(message, active[0].id);
              if (error) { last = { ok: false, error, header }; return; }
            }
            let verifiedIdentity;
            if (wantedIdentity) {
              const verified = identityOf(current, active[0], messages);
              if (!verified.ok) { last = { ...verified, header }; if (verified.error === 'CHAT_ACCOUNT_CHANGED') finish(last); return; }
              verifiedIdentity = verified.identity;
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

            if (wantedIdentity && !sameAccount(accountBefore, accountOf(current))) { finish({ ok: false, error: 'CHAT_ACCOUNT_CHANGED', header }); return; }
            const msgs = messages.map((e) => ({ self: e.classList.contains('self'), text: e.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) }));
            const preview = matches[0].innerText.replace(/\s+/g, ' ').trim();
            finish({ ok: true, header, ...(wantedIdentity ? { identity: verifiedIdentity } : {}), company, preview, ended: /客服评价邀请/.test(preview), msgs: msgs.slice(-20) });
          } catch { last = { ok: false, error: 'CHAT_DOM' }; }
        };
        outerObserver = new MutationObserver(inspect);
        outerObserver.observe(document, { childList: true, subtree: true });
        document.addEventListener('load', inspect, true);
        timer = setTimeout(() => finish({ ...last, timedOut: true }), 2200);
        inspect();
        // 缓存目标已唯一激活时不重复点击；每次检查仍重取当前DOM并核验完整身份及就绪。
        clicked = true;
        const activeNow = [...d.querySelectorAll('.conversation-item.active')];
        const targetRow = items[0].closest('.conversation-item');
        if (!expected || activeNow.length !== 1 || activeNow[0] !== targetRow) items[0].click();
        inspect();
      });
    } finally {
      outerObserver?.disconnect();
      innerObserver?.disconnect();
      clearTimeout(timer);
      document.removeEventListener('load', inspect, true);
    }
    })();
    const text = JSON.stringify(result);
    // BrowserOS evaluate 默认仅内联 5000 UTF-8 字节；长结果保留同一已核验快照，分段取回。
    if (new TextEncoder().encode(text).length <= 4000) return result;
    const slot = { text, timer: null };
    globalThis[transferKey] = slot;
    slot.timer = setTimeout(() => { delete globalThis[transferKey]; }, 60000);
    return { transfer: true, length: text.length, first: text.slice(0, 600) };
  }, { contact, headerName, mode, expected, transferKey }));
  if (res?.writtenToFile) return { ok: false, error: 'CHAT_RESULT_TRANSPORT' };
  if (res?.transfer !== true) return res;
  transferred = true;
  let text = res.first;
  for (let i = 600; i < res.length; i += 600) {
    const part = unwrap(await page.evaluate(({ transferKey, i }) => {
      const slot = globalThis[transferKey];
      return slot ? { part: slot.text.slice(i, i + 600) } : { error: 'CHAT_RESULT_EXPIRED' };
    }, { transferKey, i }));
    if (typeof part?.part !== 'string' || !part.part) return { ok: false, error: 'CHAT_RESULT_TRANSPORT' };
    text += part.part;
  }
  if (text.length !== res.length) return { ok: false, error: 'CHAT_RESULT_TRANSPORT' };
  return JSON.parse(text);
  } finally {
    // 短结果不额外调用页面；长结果立即回收，页面断开时另有过期清理。
    if (transferred) {
      try {
        await page.evaluate((transferKey) => {
          const slot = globalThis[transferKey];
          if (slot) { clearTimeout(slot.timer); delete globalThis[transferKey]; }
          return true;
        }, transferKey);
      } catch { /* 页面已关闭或导航；缓存随原文档销毁，最迟 60 秒过期。 */ }
    }
  }
}
```
