import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { helperSource } from './helpers.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));

// 不打开浏览器。模拟已知DOM契约，验证对象筛选/拒绝边界；实际选择器兼容性仍须真实UI核验。
function environment(platform, names, header = '目标店', controls = [], options = {}) {
    const counts = { clicks: 0, messages: 0, previews: 0, company: 0, evaluate: 0, observers: 0, timers: 0, listeners: 0 };
    const observers = new Set();
    const timers = new Set();
    const listeners = new Set();
    const notify = () => { for (const observer of [...observers]) observer.callback(); };
    const renderedControls = controls.map((control) => typeof control === 'string' ? { text: control, selector: 'a' } : control);
    let active;
    const items = names.map((name) => ({
        id: `chat:${name}`,
        querySelector: (selector) => selector === '.name' ? { textContent: name } : null,
        get innerText() { counts.previews++; return `${name}\n12:00\n最后一条提到目标店`; },
        click: () => { counts.clicks++; active = name; options.onClick?.(state); },
    }));
    for (const item of items) item.closest = (selector) => selector === '.conversation-item' ? item : null;
    const headerNode = {
        get innerText() { return header + renderedControls.map((c) => c.text).join(''); },
        cloneNode: () => {
            const removed = new Set();
            return {
                get textContent() { return header + renderedControls.filter((_, i) => !removed.has(i)).map((c) => c.text).join(''); },
                querySelectorAll: (selector) => renderedControls.flatMap((control, i) => selector.split(',').map((s) => s.trim()).includes(control.selector)
                    ? [{ textContent: control.text, remove: () => removed.add(i) }] : []),
            };
        },
    };
    const message = {
        __reactFiber$fixture: { return: { return: { memoizedProps: { message: { get conversationCode() { return `chat:${active}`; } } } } } },
        classList: { contains: () => false },
        querySelectorAll: () => [],
        get innerText() { counts.messages++; return '目标会话消息'; },
    };
    let messages = [message];
    const companyNode = { get innerText() { counts.company++; return '目标公司'; } };
    const loading = {
        __reactFiber$fixture: { return: { memoizedProps: { visible: false } } },
        classList: { contains: () => false },
    };
    const profile = {
        __reactFiber$fixture: { return: { memoizedProps: { get activeConversationName() { return active; }, activeDomain: 'cnalichn' } } },
        querySelectorAll: (selector) => selector === '.next-loading' ? [loading] : selector === '.nameLine' ? [companyNode] : [],
    };
    const doc = {
        querySelector: (selector) => selector === '.conversation-header' ? headerNode : selector === '.nameLine' ? { innerText: '目标公司' } : null,
        querySelectorAll: (selector) => {
            if (selector === '.conversation-item' || selector === '.content') return items;
            if (selector === '.conversation-item.active') return items.filter((_, i) => names[i] === active);
            if (selector === '.message-item') return messages;
            if (selector === '.information-tab') return [profile];
            return [];
        },
    };
    const iframe = { contentDocument: doc };
    const document = { querySelector: () => iframe, querySelectorAll: () => [iframe],
        addEventListener: (event, callback) => { listeners.add(callback); counts.listeners = listeners.size; },
        removeEventListener: (event, callback) => { listeners.delete(callback); counts.listeners = listeners.size; } };
    const state = { message, items, iframe, doc, notify, profile, loading, companyNode,
        setMessages: (value) => { messages = value; }, setHeader: (value) => { header = value; },
        setActive: (value) => { active = value; },
        load: () => { for (const callback of listeners) callback(); } };
    const context = { document, Date: { now: options.now || Date.now },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe() { observers.add(this); counts.observers = observers.size; }
            disconnect() { observers.delete(this); counts.observers = observers.size; }
        },
        setTimeout: (callback, ms) => {
            const timer = setTimeout(() => { timers.delete(timer); counts.timers = timers.size; callback(); }, Math.min(ms, 10));
            timers.add(timer); counts.timers = timers.size; return timer;
        },
        clearTimeout: (timer) => { clearTimeout(timer); timers.delete(timer); counts.timers = timers.size; },
    };
    const page = {
        evaluate: async (fn, arg) => {
            counts.evaluate++;
            return { value: await runInNewContext(`(${fn})`, context)(plain(arg)) };
        },
        waitForTime: async () => {},
    };
    const browser = { page: () => page };
    const fn = (name) => runInNewContext(`(${helperSource(`${platform}/${name}`).source})`);
    return { counts, state, call: async (name, input) => plain(await fn(name)(browser, 42, input)) };
}

for (const platform of ['market.m.taobao.com', 'air.1688.com']) {
    for (const key of ['', '  ', null, {}, 12, { contact: 12 }, { contact: '目标店', headerName: 12 }]) {
        test(`${platform} rejects invalid target ${JSON.stringify(key)} before page access`, async () => {
            const env = environment(platform, ['目标店']);
            assert.equal((await env.call('imOpenAndRead', key)).error, 'SKILL_INPUT');
            assert.equal(env.counts.evaluate, 0);
        });
    }
    for (const names of [['目标店分店'], ['其他店'], ['目标店', '目标店']]) {
        test(`${platform} refuses missing/prefix/duplicate contacts ${names.join('/')}`, async () => {
            const env = environment(platform, names);
            assert.equal((await env.call('imOpenAndRead', '目标店')).ok, false);
            assert.equal(env.counts.clicks, 0);
            assert.equal(env.counts.messages, 0);
            assert.equal(env.counts.previews, 0);
        });
    }
    test(`${platform} reads only the unique full contact after identity matches`, async () => {
        const env = environment(platform, ['目标店分店', '目标店']);
        const out = await env.call('imOpenAndRead', '目标店');
        assert.equal(out.ok, true);
        assert.equal(env.counts.clicks, 1);
        assert.ok(env.counts.messages > 0);
        assert.equal(env.counts.previews, platform === 'air.1688.com' ? 1 : 0);
    });
    test(`${platform} rejects a mismatched current header before reading messages`, async () => {
        const env = environment(platform, ['目标店'], '目标店分店');
        assert.equal((await env.call('imOpenAndRead', '目标店')).error, 'CHAT_IDENTITY');
        assert.equal(env.counts.messages, 0);
    });
    test(`${platform} accepts an explicitly verified contact/header alias`, async () => {
        const env = environment(platform, ['目标店'], '客服子账号');
        assert.equal((await env.call('imOpenAndRead', { contact: '目标店', headerName: '客服子账号' })).ok, true);
    });
    test(`${platform} previews match names instead of other names or message text`, async () => {
        const env = environment(platform, ['目标店分店', '其他店']);
        assert.deepEqual(await env.call('imPreviews', ['目标店']), {});
        assert.equal(env.counts.previews, 0);
        const own = environment(platform, ['目标店', '其他店']);
        assert.match((await own.call('imPreviews', ['目标店']))['目标店'], /最后一条/);
        assert.equal(own.counts.previews, 1);
        assert.equal(own.counts.clicks, 0);
    });
    test(`${platform} ambiguous preview rejects before reading any preview`, async () => {
        const env = environment(platform, ['目标店', '目标店']);
        assert.equal((await env.call('imPreviews', ['目标店'])).error, 'CHAT_AMBIGUOUS');
        assert.equal(env.counts.previews, 0);
    });
    for (const keys of [[''], [null], '目标店']) {
        test(`${platform} rejects invalid preview keys ${JSON.stringify(keys)}`, async () => {
            const env = environment(platform, ['目标店']);
            assert.equal((await env.call('imPreviews', keys)).error, 'SKILL_INPUT');
            assert.equal(env.counts.evaluate, 0);
        });
    }
}

test('1688 removes only a separate 进店 control while preserving the contact identity', async () => {
    const env = environment('air.1688.com', ['目标店'], '目标店', ['进店']);
    assert.equal((await env.call('imOpenAndRead', '目标店')).ok, true);
    const wrong = environment('air.1688.com', ['目标店'], '目标店进店');
    assert.equal((await wrong.call('imOpenAndRead', '目标店')).error, 'CHAT_IDENTITY');
    assert.equal(wrong.counts.messages, 0);
});

test('1688 actual go-shop-container header removes only its independent div.go-shop control', async () => {
    // 实机结构：.conversation-header > .go-shop-container > 名称文本 + div.go-shop[进店]。
    const contact = '测试工控店';
    const env = environment('air.1688.com', [contact], contact, [{ text: '进店', selector: '.go-shop' }]);
    assert.equal((await env.call('imOpenAndRead', contact)).ok, true);
    const mismatch = environment('air.1688.com', [contact], `${contact}分店`, [{ text: '进店', selector: '.go-shop' }]);
    assert.equal((await mismatch.call('imOpenAndRead', contact)).error, 'CHAT_IDENTITY');
    assert.equal(mismatch.counts.messages, 0);
    const unknownControl = environment('air.1688.com', [contact], contact, [{ text: '进店', selector: 'div.unknown' }]);
    assert.equal((await unknownControl.call('imOpenAndRead', contact)).error, 'CHAT_IDENTITY');
});

const taobao = 'market.m.taobao.com';
const boundMessage = (code, text = '目标消息', alternate) => {
    let reads = 0;
    return {
        __reactFiber$fixture: { return: { return: { memoizedProps: { message: { conversationCode: code } },
            ...(alternate === undefined ? {} : { alternate: { memoizedProps: { message: { conversationCode: alternate } } } }) } } },
        get reads() { return reads; },
        classList: { contains: () => false },
        querySelectorAll: () => [],
        get innerText() { reads++; return text; },
    };
};
const cleaned = (env) => {
    assert.equal(env.counts.observers, 0);
    assert.equal(env.counts.timers, 0);
    assert.equal(env.counts.listeners, 0);
};
test('淘宝一次通信立即读取完整绑定的消息，并清理observer/timer', async () => {
    const env = environment(taobao, ['目标店']);
    assert.deepEqual(await env.call('imOpenAndRead', '目标店'), { ok: true, header: '目标店', conv: '目标会话消息' });
    assert.equal(env.counts.evaluate, 1);
    assert.equal(env.counts.clicks, 1);
    cleaned(env);
});
test('淘宝标题已切而旧消息残留时等归属更新；不读取旧正文', async () => {
    const old = boundMessage('chat:其他店', '不该读取');
    const env = environment(taobao, ['目标店'], '目标店', [], { onClick: (state) => {
        state.setMessages([old]);
        queueMicrotask(() => { state.setMessages([boundMessage('chat:目标店', '延迟正确消息')]); state.notify(); });
    } });
    assert.equal((await env.call('imOpenAndRead', '目标店')).conv, '延迟正确消息');
    assert.equal(env.counts.messages, 0);
    assert.equal(old.reads, 0);
    cleaned(env);
});
for (const [name, messages, error] of [
    ['空消息', [], 'CHAT_MESSAGES_UNAVAILABLE'],
    ['没有fiber', [{ get innerText() { assert.fail('不得读取'); } }], 'CHAT_BINDING_UNAVAILABLE'],
    ['没有conversationCode', [boundMessage(undefined)], 'CHAT_BINDING_UNAVAILABLE'],
    ['旧消息', [boundMessage('chat:其他店')], 'CHAT_MESSAGE_IDENTITY'],
    ['alternate冲突', [boundMessage('chat:目标店', '', 'chat:其他店')], 'CHAT_MESSAGE_IDENTITY'],
    ['alternate缺code', [boundMessage('chat:目标店', '', null)], 'CHAT_MESSAGE_IDENTITY'],
    ['混合消息归属', [boundMessage('chat:目标店'), boundMessage('chat:其他店')], 'CHAT_MESSAGE_IDENTITY'],
]) {
    test(`淘宝${name}截止后明确失败且清理`, async () => {
        const env = environment(taobao, ['目标店']);
        env.state.setMessages(messages);
        const out = await env.call('imOpenAndRead', '目标店');
        assert.equal(out.error, error);
        assert.equal(out.timedOut, true);
        assert.equal(env.counts.messages, 0);
        for (const message of messages) if ('reads' in message) assert.equal(message.reads, 0);
        cleaned(env);
    });
}
test('淘宝缺active id不能由正确标题和消息放行', async () => {
    const env = environment(taobao, ['目标店']);
    env.state.items[0].id = '';
    assert.equal((await env.call('imOpenAndRead', '目标店')).error, 'CHAT_IDENTITY');
    assert.equal(env.counts.messages, 0);
    cleaned(env);
});
test('淘宝alternate冲突消除后才可读取；不按固定等待提前放行', async () => {
    const env = environment(taobao, ['目标店'], '目标店', [], { onClick: (state) => {
        state.setMessages([boundMessage('chat:目标店', '', 'chat:其他店')]);
        queueMicrotask(() => { state.setMessages([boundMessage('chat:目标店', '一致', 'chat:目标店')]); state.notify(); });
    } });
    assert.equal((await env.call('imOpenAndRead', '目标店')).conv, '一致');
    cleaned(env);
});
test('淘宝iframe被替换时重挂observer并在load后重新核验', async () => {
    const env = environment(taobao, ['目标店'], '目标店', [], { onClick: (state) => {
        state.iframe.contentDocument = null;
        state.notify();
        queueMicrotask(() => { state.iframe.contentDocument = { ...state.doc }; state.load(); });
    } });
    assert.equal((await env.call('imOpenAndRead', '目标店')).ok, true);
    cleaned(env);
});
test('淘宝点击异常也清理所有已注册监听', async () => {
    const env = environment(taobao, ['目标店'], '目标店', [], { onClick: () => { throw new Error('fixture click failure'); } });
    await assert.rejects(env.call('imOpenAndRead', '目标店'), /fixture click failure/);
    cleaned(env);
});
test('淘宝消息fiber搜索有层数上限且多fiber身份不明确时拒绝', async () => {
    for (const variant of ['too-deep', 'multiple']) {
        const message = boundMessage('chat:目标店');
        if (variant === 'too-deep') {
            let fiber = message.__reactFiber$fixture;
            for (let n = 0; n < 8; n++) fiber = { return: fiber };
            message.__reactFiber$fixture = fiber;
        } else message.__reactFiber$other = message.__reactFiber$fixture;
        const env = environment(taobao, ['目标店']);
        env.state.setMessages([message]);
        assert.equal((await env.call('imOpenAndRead', '目标店')).error, 'CHAT_BINDING_UNAVAILABLE');
        assert.equal(message.reads, 0);
        cleaned(env);
    }
});
test('淘宝iframe持续不可用超时清理，不能读取保留的旧document', async () => {
    const env = environment(taobao, ['目标店'], '目标店', [], { onClick: (state) => { state.iframe.contentDocument = null; state.notify(); } });
    const out = await env.call('imOpenAndRead', '目标店');
    assert.equal(out.error, 'CHAT_DOM');
    assert.equal(out.timedOut, true);
    assert.equal(env.counts.messages, 0);
    cleaned(env);
});
test('淘宝截止后才到达的合法消息不能成功或泄漏observer', async () => {
    let now = 100;
    const late = boundMessage('chat:目标店', '来迟的合法消息');
    const env = environment(taobao, ['目标店'], '目标店', [], { now: () => now, onClick: (state) => {
        state.setMessages([boundMessage('chat:其他店')]);
        queueMicrotask(() => { now += 2201; state.setMessages([late]); state.notify(); });
    } });
    const out = await env.call('imOpenAndRead', '目标店');
    assert.equal(out.ok, false);
    assert.equal(out.timedOut, true);
    assert.equal(out.error, 'CHAT_MESSAGE_IDENTITY');
    assert.equal(late.reads, 0);
    env.state.notify();
    env.state.load();
    assert.equal(late.reads, 0);
    cleaned(env);
});

// 实机证据：同一条已绑定消息先为 .content > span 占位，64ms后才显示客服评价正文。
test('淘宝富消息占位消失后才返回客服评价，不丢失聊天结束信号', async () => {
    const message = boundMessage('chat:目标店', '您对客服的服务满意吗');
    let rendering = true;
    message.querySelectorAll = (selector) => {
        assert.equal(selector, '.content > span');
        return rendering ? [{ textContent: '暂不支持的消息类型' }] : [];
    };
    const env = environment(taobao, ['目标店'], '目标店', [], { onClick: (state) => {
        state.setMessages([message]);
        queueMicrotask(() => {
            assert.equal(message.reads, 0);
            rendering = false;
            state.notify();
        });
    } });
    const out = await env.call('imOpenAndRead', '目标店');
    assert.equal(out.ok, true);
    assert.equal(out.conv, '您对客服的服务满意吗');
    assert.equal(message.reads, 1);
    assert.equal(env.counts.evaluate, 1);
    cleaned(env);
});

test('淘宝永久不支持的富消息明确失败，不返回看似完整的其余消息', async () => {
    const text = boundMessage('chat:目标店', '1750');
    const rich = boundMessage('chat:目标店', '暂不支持的消息类型');
    rich.querySelectorAll = () => [{ textContent: ' 暂不支持的消息类型 ' }];
    const env = environment(taobao, ['目标店']);
    env.state.setMessages([text, rich]);
    const out = await env.call('imOpenAndRead', '目标店');
    assert.equal(out.error, 'CHAT_MESSAGES_RENDERING');
    assert.equal(out.timedOut, true);
    assert.equal(text.reads, 0);
    assert.equal(rich.reads, 0);
    cleaned(env);
});

test('淘宝正文引用占位措辞但不是精确占位节点时仍可读取', async () => {
    const message = boundMessage('chat:目标店', '页面刚显示暂不支持的消息类型，现在好了');
    message.querySelectorAll = () => [{ textContent: '页面刚显示暂不支持的消息类型，现在好了' }];
    const env = environment(taobao, ['目标店']);
    env.state.setMessages([message]);
    assert.equal((await env.call('imOpenAndRead', '目标店')).conv, '页面刚显示暂不支持的消息类型，现在好了');
    cleaned(env);
});

test('淘宝在所有消息归属通过前也不检查占位文本', async () => {
    const message = boundMessage('chat:其他店', '不该读取');
    message.querySelectorAll = () => { assert.fail('不得检查其他会话占位文本'); };
    const env = environment(taobao, ['目标店']);
    env.state.setMessages([message]);
    assert.equal((await env.call('imOpenAndRead', '目标店')).error, 'CHAT_MESSAGE_IDENTITY');
    assert.equal(message.reads, 0);
    cleaned(env);
});

const ali1688 = 'air.1688.com';
for (const [name, messages, error] of [
    ['空消息', [], 'CHAT_MESSAGES_UNAVAILABLE'],
    ['缺fiber', [{ classList: { contains: () => false }, get innerText() { assert.fail('不得读取'); } }], 'CHAT_BINDING_UNAVAILABLE'],
    ['旧消息残留', [boundMessage('chat:其他店')], 'CHAT_MESSAGE_IDENTITY'],
    ['alternate冲突', [boundMessage('chat:目标店', '', 'chat:其他店')], 'CHAT_MESSAGE_IDENTITY'],
    ['混合消息归属', [boundMessage('chat:目标店'), boundMessage('chat:其他店')], 'CHAT_MESSAGE_IDENTITY'],
]) {
    test(`1688${name}超时拒绝且清理`, async () => {
        const env = environment(ali1688, ['目标店']);
        env.state.setMessages(messages);
        const out = await env.call('imOpenAndRead', '目标店');
        assert.equal(out.error, error);
        assert.equal(out.timedOut, true);
        for (const message of messages) if ('reads' in message) assert.equal(message.reads, 0);
        assert.equal(env.counts.previews, 0);
        cleaned(env);
    });
}
test('1688不能以列表存在代替唯一active父项匹配', async () => {
    const env = environment(ali1688, ['目标店', '其他店'], '目标店', [], { onClick: (state) => state.setActive('其他店') });
    assert.equal((await env.call('imOpenAndRead', '目标店')).error, 'CHAT_IDENTITY');
    assert.equal(env.counts.messages, 0);
    assert.equal(env.counts.previews, 0);
    cleaned(env);
});
test('1688不将消息区域.content当会话项解析', async () => {
    const env = environment(ali1688, ['目标店']);
    env.state.items.push({ closest: () => null, get innerText() { assert.fail('不读非会话内容'); } });
    assert.equal((await env.call('imOpenAndRead', '目标店')).ok, true);
    cleaned(env);
});
test('1688消息归属延迟更新后才读正文，并且只通信一次', async () => {
    const old = boundMessage('chat:其他店');
    const env = environment(ali1688, ['目标店'], '目标店', [], { onClick: (state) => {
        state.setMessages([old]);
        queueMicrotask(() => { state.setMessages([boundMessage('chat:目标店', '更新后')]); state.notify(); });
    } });
    assert.deepEqual((await env.call('imOpenAndRead', '目标店')).msgs, [{ self: false, text: '更新后' }]);
    assert.equal(old.reads, 0);
    assert.equal(env.counts.evaluate, 1);
    cleaned(env);
});
test('1688富消息占位更新后才成功，永久占位不返回部分正文', async () => {
    for (const resolvePlaceholder of [false, true]) {
        let rendering = true;
        const rich = boundMessage('chat:目标店', '机器人回复');
        rich.querySelectorAll = () => rendering ? [{ textContent: '暂不支持的消息类型' }] : [];
        const text = boundMessage('chat:目标店', '2000');
        const env = environment(ali1688, ['目标店'], '目标店', [], { onClick: (state) => {
            state.setMessages([text, rich]);
            if (resolvePlaceholder) queueMicrotask(() => { rendering = false; state.notify(); });
        } });
        const out = await env.call('imOpenAndRead', '目标店');
        assert.equal(out.ok, resolvePlaceholder);
        if (!resolvePlaceholder) {
            assert.equal(out.error, 'CHAT_MESSAGES_RENDERING');
            assert.equal(out.timedOut, true);
            assert.equal(text.reads, 0);
            assert.equal(rich.reads, 0);
        } else assert.equal(out.msgs[1].text, '机器人回复');
        cleaned(env);
    }
});
test('1688保留self/20条300字/company/preview/ended格式且排除line', async () => {
    const env = environment(ali1688, ['目标店']);
    const messages = Array.from({ length: 22 }, (_, n) => {
        const message = boundMessage('chat:目标店', `${n} ` + '字'.repeat(400));
        message.classList = { contains: (name) => name === 'self' && n % 2 === 0 };
        return message;
    });
    messages.push({ classList: { contains: (name) => name === 'message-item-line' }, get innerText() { assert.fail('不读line'); } });
    env.state.setMessages(messages);
    Object.defineProperty(env.state.items[0], 'innerText', { value: '目标店\n客服评价邀请' });
    const out = await env.call('imOpenAndRead', '目标店');
    assert.equal(out.msgs.length, 20);
    assert.equal(out.msgs[0].text, ('2 ' + '字'.repeat(400)).slice(0, 300));
    assert.equal(out.msgs[0].self, true);
    assert.equal(out.msgs[1].self, false);
    assert.equal(out.company, '目标公司');
    assert.equal(out.preview, '目标店 客服评价邀请');
    assert.equal(out.ended, true);
    cleaned(env);
});
test('1688点击异常与iframe消失超时均清理观察器', async () => {
    const broken = environment(ali1688, ['目标店'], '目标店', [], { onClick: () => { throw new Error('click failed'); } });
    await assert.rejects(broken.call('imOpenAndRead', '目标店'), /click failed/);
    cleaned(broken);
    const missing = environment(ali1688, ['目标店'], '目标店', [], { onClick: (state) => { state.iframe.contentDocument = null; state.notify(); } });
    assert.equal((await missing.call('imOpenAndRead', '目标店')).error, 'CHAT_DOM');
    cleaned(missing);
});

test('1688消息先完成时仍等待目标公司档案加载；不提前读取旧公司或消息', async () => {
    const env = environment(ali1688, ['目标店'], '目标店', [], { onClick: (state) => {
        state.loading.__reactFiber$fixture.return.memoizedProps.visible = true;
        queueMicrotask(() => {
            assert.equal(env.counts.company, 0);
            assert.equal(env.counts.messages, 0);
            state.loading.__reactFiber$fixture.return.memoizedProps.visible = false;
            Object.defineProperty(state.companyNode, 'innerText', { value: '9年\n目标公司' });
            state.notify();
        });
    } });
    const out = await env.call('imOpenAndRead', '目标店');
    assert.equal(out.company, '9年\n目标公司');
    assert.equal(out.ok, true);
    assert.equal(env.counts.evaluate, 1);
    cleaned(env);
});

for (const variant of ['旧档案', 'alternate冲突', 'domain冲突', '同为错误domain', '没有fiber', '多fiber', '超出层数', '加载中', 'alternate加载中', '未说明加载状态', '可见遮罩']) {
    test(`1688${variant}不泄漏公司与聊天正文`, async () => {
        const env = environment(ali1688, ['目标店']);
        const { profile, loading } = env.state;
        const profileFiber = profile.__reactFiber$fixture.return;
        const loadingFiber = loading.__reactFiber$fixture.return;
        if (variant === '旧档案') profileFiber.memoizedProps = { activeConversationName: '其他店', activeDomain: 'cnalichn' };
        if (variant === 'alternate冲突') profileFiber.alternate = { memoizedProps: { activeConversationName: '其他店', activeDomain: 'cnalichn' } };
        if (variant === 'domain冲突') profileFiber.alternate = { memoizedProps: { activeConversationName: '目标店', activeDomain: '其他平台' } };
        if (variant === '同为错误domain') {
            profileFiber.memoizedProps.activeDomain = 'cntaobao';
            profileFiber.alternate = { memoizedProps: { activeConversationName: '目标店', activeDomain: 'cntaobao' } };
        }
        if (variant === '没有fiber') delete profile.__reactFiber$fixture;
        if (variant === '多fiber') profile.__reactFiber$other = profile.__reactFiber$fixture;
        if (variant === '超出层数') for (let i = 0; i < 8; i++) profile.__reactFiber$fixture = { return: profile.__reactFiber$fixture };
        if (variant === '加载中') loadingFiber.memoizedProps.visible = true;
        if (variant === 'alternate加载中') loadingFiber.alternate = { memoizedProps: { visible: true } };
        if (variant === '未说明加载状态') delete loadingFiber.memoizedProps.visible;
        if (variant === '可见遮罩') loading.classList.contains = () => true;
        const out = await env.call('imOpenAndRead', '目标店');
        assert.equal(out.ok, false);
        assert.equal(out.timedOut, true);
        assert.match(out.error, /^CHAT_PROFILE_/);
        assert.equal(env.counts.company, 0);
        assert.equal(env.counts.messages, 0);
        assert.equal(env.counts.previews, 0);
        cleaned(env);
    });
}

test('1688空档案不能成功；非空后继承完整结果，迟到则仍超时', async () => {
    for (const mode of ['永久空', '及时', '迟到']) {
        let now = 100, company = '';
        const env = environment(ali1688, ['目标店'], '目标店', [], { now: () => now, onClick: (state) => {
            Object.defineProperty(state.companyNode, 'innerText', { get: () => company });
            if (mode !== '永久空') queueMicrotask(() => {
                assert.equal(env.counts.messages, 0);
                if (mode === '迟到') now += 2201;
                company = '目标公司';
                state.notify();
            });
        } });
        const out = await env.call('imOpenAndRead', '目标店');
        assert.equal(out.ok, mode === '及时');
        if (mode !== '及时') {
            assert.equal(out.error, 'CHAT_PROFILE_RENDERING');
            assert.equal(out.timedOut, true);
            assert.equal(env.counts.messages, 0);
        } else assert.equal(out.company, '目标公司');
        cleaned(env);
    }
});
