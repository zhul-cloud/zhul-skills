import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { helperSource } from './helpers.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));

// 不打开浏览器。模拟已知DOM契约，验证对象筛选/拒绝边界；实际选择器兼容性仍须真实UI核验。
function environment(platform, names, header = '目标店', controls = []) {
    const counts = { clicks: 0, messages: 0, previews: 0, evaluate: 0 };
    const renderedControls = controls.map((control) => typeof control === 'string' ? { text: control, selector: 'a' } : control);
    let active;
    const items = names.map((name) => ({
        querySelector: (selector) => selector === '.name' ? { textContent: name } : null,
        get innerText() { counts.previews++; return `${name}\n12:00\n最后一条提到目标店`; },
        click: () => { counts.clicks++; active = name; },
    }));
    const headerNode = {
        innerText: header + renderedControls.map((c) => c.text).join(''),
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
        classList: { contains: () => false },
        get innerText() { counts.messages++; return '目标会话消息'; },
    };
    const doc = {
        querySelector: (selector) => selector === '.conversation-header' ? headerNode : selector === '.nameLine' ? { innerText: '目标公司' } : null,
        querySelectorAll: (selector) => {
            if (selector === '.conversation-item' || selector === '.content') return items;
            if (selector === '.conversation-item.active') return items.filter((_, i) => names[i] === active);
            if (selector === '.message-item') return [message];
            return [];
        },
    };
    const iframe = { contentDocument: doc };
    const document = { querySelector: () => iframe, querySelectorAll: () => [iframe] };
    const page = {
        evaluate: async (fn, arg) => {
            counts.evaluate++;
            return { value: await runInNewContext(`(${fn})`, { document })(plain(arg)) };
        },
        waitForTime: async () => {},
    };
    const browser = { page: () => page };
    const fn = (name) => runInNewContext(`(${helperSource(`${platform}/${name}`).source})`);
    return { counts, call: async (name, input) => plain(await fn(name)(browser, 42, input)) };
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
