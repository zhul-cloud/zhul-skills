import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { helperSource } from '../scripts/helpers.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));
const detail = { model: 'MODEL-A-01', mode: 'current-dom' };

// 匿名 DOM fixture；运行实际 helper 回调，不镜像候选提取/传输算法。
class Element {
    constructor({ href, className = '', text = '', children = [] } = {}) {
        Object.assign(this, { href, className, text, children });
        for (const child of children) child.parentElement = this;
    }
    get innerText() { return this.text || this.children.map((child) => child.innerText).join(' '); }
    get textContent() { return this.innerText; }
    querySelectorAll(selector) {
        const matches = (node) => selector === 'a[href]' ? !!node.href
            : selector === '[class*="title--"]' ? node.className.includes('title--')
                : selector === '[class*="titleText--"]' ? node.className.includes('titleText--')
                    : !!node.href && /item\.taobao\.com\/item\.htm|detail\.tmall\.com\/item\.htm/.test(node.href);
        return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
}

function card(platform, id, options = {}) {
    const { title = '全新 MODEL-A-01 完整后缀', price = 180, paid = '12', used = false, ad = false, suffix = '', missingTitle = false } = options;
    const href = options.href || (ad ? 'https://dj.1688.com/ci_bb?promotion=anonymous'
        : platform === 'taobao' ? `https://item.taobao.com/item.htm?id=${id}${suffix}` : `https://detail.1688.com/offer/${id}.html${suffix}`);
    const titleNode = new Element({ className: platform === 'taobao' ? 'title--fixture' : 'titleText--fixture', text: title });
    const text = `${title} ¥${price} ${paid}人付款 ${used ? '拆机' : ''} ${ad ? '广告' : ''} 匿名设备有限公司`;
    return platform === 'taobao'
        ? new Element({ text, children: [new Element({ href }), ...(missingTitle ? [] : [titleNode])] })
        : new Element({ href, text, className: ad ? 'ad-common' : 'offerCard--fixture', children: [...(missingTitle ? [] : [titleNode]), new Element({ className: 'shopRow--fixture', text: '匿名设备有限公司' })] });
}

function environment(platform, cards, options = {}) {
    const document = new Element({ children: cards });
    const counts = { pages: 0, evaluate: 0, stringify: 0, replyBytes: [], cleanup: 0 };
    const timers = new Map();
    const hostTimers = new Map();
    let now = 0, nextTimer = 0;
    let nextHostTimer = 0;
    const context = createContext({ document, location: { href: `https://s.${platform === 'taobao' ? 'taobao' : '1688'}.com/search?model=anonymous` }, URL, TextEncoder,
        Date: { now: () => now }, Math,
        JSON: { stringify: (value) => { counts.stringify++; return JSON.stringify(value); }, parse: JSON.parse },
        setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, () => { timers.delete(id); callback(); }); return id; },
        clearTimeout: (id) => timers.delete(id),
    });
    // 宿主通信期限与页面 TTL 使用不同计时器，模拟真正不 settle 的 SDK 请求。
    const host = createContext({ Date: { now: () => now }, Math,
        setTimeout: (callback, ms) => { const id = ++nextHostTimer; hostTimers.set(id, { callback, at: now + ms }); return id; },
        clearTimeout: (id) => hostTimers.delete(id),
    });
    const source = helperSource(`s.${platform === 'taobao' ? 'taobao' : '1688'}.com/searchCandidates`).source;
    const helper = runInContext(`(${source})`, host);
    const browser = { page: (id) => {
        counts.pages++; assert.equal(id, 42);
        return { evaluate: async (callback, argument) => {
            counts.evaluate++;
            if (typeof argument === 'string') counts.cleanup++;
            await options.before?.({ context, counts, timers, argument, advance: (ms) => { now += ms; } });
            context.__argument = argument;
            let result = await runInContext(`(${callback.toString()})(__argument)`, context);
            const override = await options.after?.({ context, counts, timers, argument, result });
            if (override !== undefined) result = override;
            const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
            counts.replyBytes.push(bytes);
            if (bytes > 5000) return { writtenToFile: true, filePath: 'synthetic-result' };
            return options.bare ? result : { value: result };
        } };
    } };
    return { counts, timers, hostTimers, context,
        advanceHost: (ms) => {
            now += ms;
            for (const [id, timer] of [...hostTimers]) if (timer.at <= now) { hostTimers.delete(id); timer.callback(); }
        },
        read: async (input = detail) => plain(await helper(browser, 42, input)),
    };
}

for (const platform of ['taobao', '1688']) {
    for (const stage of ['initial', 'chunk', 'initial-response']) {
        test(`${platform}: permanently pending ${stage} SDK call returns at the operation deadline`, { timeout: 2000 }, async () => {
            const never = () => new Promise(() => {});
            const env = environment(platform, [card(platform, '10001', { title: '汉'.repeat(2500) })], {
                before: ({ counts }) => stage === 'initial' && counts.evaluate === 1 || stage === 'chunk' && counts.evaluate === 2 ? never() : undefined,
                after: ({ counts }) => stage === 'initial-response' && counts.evaluate === 1 ? never() : undefined,
            });
            const pending = env.read();
            await nextTurn();
            assert.equal(env.counts.evaluate, stage === 'chunk' ? 2 : 1);
            assert.equal(env.hostTimers.size, 1);
            env.advanceHost(25000);
            assert.deepEqual(await pending, { ok: false, error: 'SEARCH_RESULT_TIMEOUT' });
            assert.equal(env.counts.cleanup, 1);
            assert.equal(env.hostTimers.size, 0);
            assert.equal(env.timers.size, 0);
            assert.deepEqual(Object.keys(env.context).filter((key) => key.startsWith('__zhul_search_')), []);
        });
    }

    test(`${platform}: permanently pending cleanup has its own short budget and preserves the successful result`, { timeout: 2000 }, async () => {
        const env = environment(platform, [card(platform, '10001', { title: '汉'.repeat(2500) })], {
            before: ({ argument }) => typeof argument === 'string' ? new Promise(() => {}) : undefined,
        });
        const pending = env.read();
        await nextTurn();
        assert.equal(env.counts.cleanup, 1);
        assert.equal(env.hostTimers.size, 1);
        assert.equal([...env.hostTimers.values()][0].at, 500);
        env.advanceHost(500);
        assert.equal((await pending).ok, true);
        assert.equal(env.hostTimers.size, 0);
        assert.equal(env.timers.size, 1, 'page TTL survives unreachable cleanup');
        for (const callback of [...env.timers.values()]) callback();
        assert.equal(env.timers.size, 0);
        assert.deepEqual(Object.keys(env.context).filter((key) => key.startsWith('__zhul_search_')), []);
    });

    test(`${platform}: pending result and pending cleanup stay within the combined 25s plus 500ms budget`, { timeout: 2000 }, async () => {
        const env = environment(platform, [card(platform, '10001', { title: '汉'.repeat(2500) })], {
            before: ({ argument }) => typeof argument === 'string' ? new Promise(() => {}) : undefined,
            after: ({ counts }) => counts.evaluate === 1 ? new Promise(() => {}) : undefined,
        });
        const pending = env.read();
        await nextTurn();
        env.advanceHost(25000);
        await nextTurn();
        assert.equal(env.counts.cleanup, 1);
        assert.equal([...env.hostTimers.values()][0].at, 25500);
        env.advanceHost(500);
        assert.deepEqual(await pending, { ok: false, error: 'SEARCH_RESULT_TIMEOUT' });
        assert.equal(env.hostTimers.size, 0);
        for (const callback of [...env.timers.values()]) callback();
        assert.deepEqual(Object.keys(env.context).filter((key) => key.startsWith('__zhul_search_')), []);
    });

    test(`${platform}: a delayed initial callback cannot recreate a snapshot after timeout cleanup`, { timeout: 2000 }, async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const env = environment(platform, [card(platform, '10001', { title: '汉'.repeat(2500) })], {
            before: ({ counts }) => counts.evaluate === 1 ? gate : undefined,
        });
        const pending = env.read();
        await nextTurn();
        env.advanceHost(25000);
        assert.deepEqual(await pending, { ok: false, error: 'SEARCH_RESULT_TIMEOUT' });
        release();
        await nextTurn();
        assert.equal(env.counts.stringify, 0, 'expired delayed callback skips page extraction');
        assert.equal(env.hostTimers.size, 0);
        assert.equal(env.timers.size, 0);
        assert.deepEqual(Object.keys(env.context).filter((key) => key.startsWith('__zhul_search_')), []);
    });

    test(`${platform}: legacy seven fields and evidence preserve order, flags and original model`, async () => {
        const cards = [card(platform, '10001'), card(platform, '10002', { title: 'MODEL-A-02', price: 50, used: true }), card(platform, '10003', { title: 'UNRELATED', price: 99 })];
        const env = environment(platform, cards);
        const legacy = await env.read('MODEL-A-01');
        const result = await env.read();
        assert.equal(result.ok, true);
        assert.equal(result.scope, 'current-dom');
        assert.equal(Object.hasOwn(result, 'loadedComplete'), false);
        assert.deepEqual(result.candidates.map((item) => item.legacy), legacy);
        assert.deepEqual(legacy[0], [1, '10001', 180, platform === 'taobao' ? 12 : '匿名设备有限公司', 1, 0, 0]);
        // 淘宝旧版片段匹配仍只是提示；1688旧版完整规范化规则不变。
        assert.equal(legacy[1][4], platform === 'taobao' ? 1 : 0);
        assert.equal(legacy[1][5], 1);
        assert.equal(legacy[2][4], 0);
        assert.equal(result.candidates[0].title, '全新 MODEL-A-01 完整后缀');
        assert.match(result.candidates[0].productUrl, /10001/);
        assert.deepEqual(result.counts, { matchedAnchors: 3, cardCandidates: 3, returned: 3 });
        assert.equal(env.counts.evaluate, 2);
        assert.equal(env.timers.size, 0);
    });

    test(`${platform}: malformed arguments are rejected before accessing a page`, async () => {
        const env = environment(platform, []);
        for (const input of [null, [], {}, 1, '', '  ', { model: 'MODEL', mode: 'all' }, { model: 2, mode: 'current-dom' }]) {
            assert.deepEqual(await env.read(input), { ok: false, error: 'SKILL_INPUT' });
        }
        assert.equal(env.counts.pages, 0);
    });

    test(`${platform}: empty DOM is an unavailable read, not no-stock evidence`, async () => {
        const env = environment(platform, []);
        assert.deepEqual(await env.read(), { ok: false, error: 'SEARCH_CANDIDATES_UNAVAILABLE', scope: 'current-dom' });
        assert.deepEqual(await env.read('MODEL-A-01'), []);
    });

    test(`${platform}: missing product title never substitutes a company name`, async () => {
        const result = await environment(platform, [card(platform, '10001', { missingTitle: true })]).read();
        assert.equal(result.candidates[0].title, null);
        assert.equal(result.candidates.length, 1);
    });

    test(`${platform}: bare SDK results work and credential-bearing links never become product entry URLs`, async () => {
        const href = platform === 'taobao' ? 'https://user:secret@item.taobao.com/item.htm?id=10001' : 'https://user:secret@detail.1688.com/offer/10001.html';
        const env = environment(platform, [card(platform, '10001', { href })], { bare: true });
        const result = await env.read();
        assert.equal(result.ok, true);
        assert.equal(result.candidates[0].productUrl, null);
        const failed = environment(platform, [card(platform, '10001')], { bare: true, after: ({ counts }) => counts.evaluate === 1 ? { writtenToFile: true } : undefined });
        assert.deepEqual(await failed.read(), { ok: false, error: 'SEARCH_RESULT_TRANSPORT' });
    });

    test(`${platform}: canonical product entry removes observed tracking/SKU query without guessing an ID`, async () => {
        const result = await environment(platform, [card(platform, '10001', { suffix: platform === 'taobao' ? '&skuId=anonymous&spm=tracking' : '?skuId=anonymous&trace_log=tracking' })]).read();
        assert.equal(result.candidates[0].productUrl, platform === 'taobao' ? 'https://item.taobao.com/item.htm?id=10001' : 'https://detail.1688.com/offer/10001.html');
        assert.equal(result.candidates[0].legacy[1], '10001');
    });

    test(`${platform}: failed immediate cleanup retains only the bounded TTL fallback`, async () => {
        const env = environment(platform, [card(platform, '10001', { title: '汉'.repeat(2500) })], {
            before: ({ argument }) => { if (typeof argument === 'string') throw new Error('page unavailable'); },
        });
        assert.equal((await env.read()).ok, true);
        assert.equal(env.timers.size, 1);
        for (const callback of [...env.timers.values()]) callback();
        assert.equal(env.timers.size, 0);
        assert.deepEqual(Object.keys(env.context).filter((key) => key.startsWith('__zhul_search_')), []);
    });

    for (const text of ['汉'.repeat(100), '汉"\\\n😀'.repeat(35)]) {
        test(`${platform}: complete UTF-8/escaped snapshot exceeds SDK limit and is reconstructed without truncation (${text.length})`, async () => {
            const env = environment(platform, Array.from({ length: 35 }, (_, i) => card(platform, String(10000 + i), { title: `MODEL-A-01 ${text} ${i}` })));
            const result = await env.read();
            assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') > 5000);
            assert.equal(result.candidates.length, 35);
            assert.equal(result.candidates[34].title, `MODEL-A-01 ${text} 34`.replace(/\s+/g, ' '));
            assert.equal(result.candidates[34].legacy[0], 35);
            assert.ok(env.counts.evaluate > 2);
            assert.ok(env.counts.replyBytes.every((bytes) => bytes <= 5000));
            assert.equal(env.counts.stringify, 1, 'one immutable DOM snapshot is serialized');
            assert.equal(env.counts.cleanup, 1);
            assert.equal(env.timers.size, 0);
            assert.deepEqual(Object.keys(env.context).filter((key) => key.startsWith('__zhul_search_')), []);
        });
    }

    for (const failure of ['expired', 'short', 'file', 'throw', 'bad-json', 'deadline']) {
        test(`${platform}: ${failure} during long transport fails safely and cleans its snapshot`, async () => {
            const env = environment(platform, [card(platform, '10001', { title: 'MODEL-A-01 ' + '汉'.repeat(2500) })], {
                before: ({ counts, timers, advance }) => {
                    if (counts.evaluate !== 2) return;
                    if (failure === 'expired') for (const callback of [...timers.values()]) callback();
                    if (failure === 'throw') throw new Error('disconnected');
                    if (failure === 'deadline') advance(25000);
                },
                after: ({ counts, result }) => counts.evaluate !== 2 ? undefined
                    : failure === 'short' ? { part: result.part.slice(1) }
                        : failure === 'file' ? { writtenToFile: true }
                            : failure === 'bad-json' ? { part: '\u0000' + result.part.slice(1) } : undefined,
            });
            const result = await env.read();
            assert.equal(result.ok, false);
            assert.equal(result.error, failure === 'deadline' ? 'SEARCH_RESULT_TIMEOUT' : 'SEARCH_RESULT_TRANSPORT');
            assert.equal(env.counts.cleanup, 1);
            assert.equal(env.timers.size, 0);
            assert.deepEqual(Object.keys(env.context).filter((key) => key.startsWith('__zhul_search_')), []);
        });
    }

    for (const invalid of [{ writtenToFile: true }, { ok: true }, { transfer: true, length: -1, first: '' }, { transfer: true, length: 2000, first: 'short' }]) {
        test(`${platform}: SDK metadata/malformed result is never a candidate list (${JSON.stringify(invalid)})`, async () => {
            const env = environment(platform, [card(platform, '10001')], { after: ({ counts }) => counts.evaluate === 1 ? invalid : undefined });
            assert.deepEqual(await env.read(), { ok: false, error: 'SEARCH_RESULT_TRANSPORT' });
            assert.equal(env.timers.size, 0);
        });
    }
}

test('1688: new mode preserves all current DOM rows past 20, including empty-ID advertisements', async () => {
    const cards = [...Array.from({ length: 48 }, (_, i) => card('1688', String(10000 + i))), ...Array.from({ length: 14 }, () => card('1688', '', { ad: true }))];
    const env = environment('1688', cards);
    const legacy = await env.read('MODEL-A-01');
    const result = await env.read();
    assert.equal(legacy.length, 20);
    assert.equal(result.candidates.length, 62);
    assert.deepEqual(result.candidates.slice(0, 20).map((item) => item.legacy), legacy);
    assert.deepEqual(result.candidates[25].legacy, [26, '10025', 180, '匿名设备有限公司', 1, 0, 0]);
    assert.deepEqual(result.candidates[47].legacy, [48, '10047', 180, '匿名设备有限公司', 1, 0, 0]);
    assert.equal(result.candidates[61].legacy[1], '');
    assert.equal(result.candidates[61].legacy[6], 1);
    assert.equal(result.candidates[61].productUrl, null);
});

test('淘宝: repeated product anchors remain deduplicated, tracking links excluded, Tmall direct route retained', async () => {
    const env = environment('taobao', [card('taobao', '10001', { paid: '2万' }), card('taobao', '10001'),
        card('taobao', '10002', { href: 'https://detail.tmall.com/item.htm?id=10002' }),
        card('taobao', '10003', { href: 'https://click.simba.taobao.com/cc_im?id=10003' })]);
    const result = await env.read();
    assert.equal(result.counts.matchedAnchors, 3);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0].legacy[3], 10000);
    assert.equal(result.candidates[1].productUrl, 'https://detail.tmall.com/item.htm?id=10002');
});
