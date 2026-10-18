// 执行平台文档中的真实提取片段；只用匿名DOM/公开初始化fixture，不打开浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { identityProblems } from '../scripts/contacts.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));
function extract(platform, context, input, marker = 'business-observation') {
    const markdown = readFileSync(new URL(`../platforms/${platform}.md`, import.meta.url), 'utf8');
    const blocks = [...markdown.matchAll(/```js\r?\n([\s\S]*?)\r?\n```/g)];
    const source = blocks.find((match) => match[1].includes(`zhul-${marker}: ${platform}`));
    assert.ok(source, '平台文档必须提供可执行的具名提取片段');
    return plain(runInNewContext(`(${source[1]})`, { URL, Date, ...context })(input));
}
test('淘宝只从已核实锚点有限Fiber具名字段提取sellerId，不从URL猜shopId', () => {
    const shopUrl = 'https://anonymous-shop.taobao.com/category.htm';
    const props = { sellerId: 'seller-test', itemId: '10001', storeCardVO: { shopName: '匿名店', shopUrl } };
    const fiber = { return: { return: { memoizedProps: props, alternate: { memoizedProps: structuredClone(props) } } } };
    const anchor = { href: shopUrl + '?topIds=10001', __reactFiber$fixture: fiber };
    const context = { document: { querySelectorAll: () => [anchor] }, location: new URL('https://item.taobao.com/item.htm?id=10001') };
    const out = extract('taobao', context, { recipientId: 'seller-test', verifiedShopUrl: shopUrl });
    assert.equal(out.value, 'seller-test'); assert.equal(out.itemId, '10001'); assert.equal(out.source, 'seller-anchor.memoizedProps.sellerId');
    assert.equal(out.shopId, undefined); assert.equal(out.memberId, undefined);
    assert.equal(extract('taobao', context, { recipientId: 'wrong', verifiedShopUrl: shopUrl }), null);
    fiber.return.return.alternate.memoizedProps.sellerId = 'wrong';
    assert.equal(extract('taobao', context, { recipientId: 'seller-test', verifiedShopUrl: shopUrl }), null);
});

function productEnvironment(platform, options = {}) {
    const counts = { reads: 0, queries: 0 };
    const node = (text, visible = true) => ({
        get innerText() { counts.reads++; return text; },
        get textContent() { counts.reads++; return text; },
        getClientRects: () => visible ? [{}] : [],
    });
    const title = '全新 MODEL-A-01 原装';
    const shop = Object.assign(node('匿名设备有限公司\n评分4.8\n平均8小时发货'), { href: `https://anonymous-shop.${platform === 'taobao' ? 'taobao' : '1688'}.com/?tracking=anonymous`, closest: () => node('匿名设备有限公司\n评级AAA\n平均8小时发货') });
    if (platform === '1688') Object.defineProperty(shop, 'innerText', { get() { counts.reads++; return '匿名设备有限公司'; } });
    const nodes = {
        title: (options.titles || [title]).map((text) => node(text)),
        shop: options.duplicateShop ? [shop, shop] : [shop],
        sku: (options.sku || ['MODEL-A-01']).map((text) => node(text)),
        rows: (options.rows || []).map((text) => node(text)),
        challenge: options.challenge ? [node('需要验证')] : [],
    };
    const document = { querySelectorAll: (selector) => {
        counts.queries++;
        if (selector.startsWith('.nc_scale')) return nodes.challenge;
        if (selector === 'div[class^="ItemTitle--"]' || selector === '.title-content h1') return nodes.title;
        if (selector === 'a[class*="detailWrap--"]' || selector === 'a.shop-company-name') return nodes.shop;
        if (selector === 'span[class*="valueItemText--"]' || selector === '.item-label') return nodes.sku;
        if (selector === 'tr.ant-descriptions-row') return nodes.rows;
        if (selector === 'a.delivery-limit') return [node('承诺24小时发货')];
        assert.fail(`未审查的选择器 ${selector}`);
    } };
    const location = new URL(platform === 'taobao' ? 'https://item.taobao.com/item.htm?id=10001' : 'https://detail.1688.com/offer/10001.html');
    return { counts, nodes, node, read: (input = { itemId: '10001', model: 'MODEL-A-01' }) => extract(platform, { document, location }, input, 'product-fields') };
}

for (const platform of ['taobao', '1688']) {
    test(`${platform}详情片段一次读取独立型号与店铺原文，不产生业务操作`, () => {
        const env = productEnvironment(platform);
        const result = env.read();
        assert.equal(result.ok, true);
        assert.equal(result.itemId, '10001');
        assert.equal(result.title, '全新 MODEL-A-01 原装');
        assert.deepEqual(result.exactSku, ['MODEL-A-01']);
        assert.equal(result.shopName, '匿名设备有限公司');
        assert.equal(result.shopUrl, `https://anonymous-shop.${platform === 'taobao' ? 'taobao' : '1688'}.com/`);
        assert.match(result.shopHeader, /发货/);
    });
    test(`${platform}详情片段拒绝错误商品与缺字段，不读错页正文`, () => {
        const env = productEnvironment(platform);
        assert.equal(env.read({ itemId: 'other', model: 'MODEL-A-01' }).error, 'SKILL_INPUT');
        assert.equal(env.read({ itemId: '10002', model: 'MODEL-A-01' }).error, 'PRODUCT_IDENTITY');
        assert.equal(env.counts.queries, 0);
        assert.equal(env.counts.reads, 0);
        assert.equal(productEnvironment(platform, { sku: [] }).read().error, 'PRODUCT_FIELDS_UNAVAILABLE');
        assert.equal(productEnvironment(platform, { duplicateShop: true }).read().error, 'PRODUCT_FIELDS_UNAVAILABLE');
    });
    test(`${platform}详情片段遇到可见验证立即拒绝，不读商品或店铺正文`, () => {
        const env = productEnvironment(platform, { challenge: true });
        assert.equal(env.read().error, 'VISIBLE_VERIFICATION');
        assert.equal(env.counts.reads, 0);
    });
}

test('淘宝同文可见标题重复可读，异文标题歧义拒绝', () => {
    assert.equal(productEnvironment('taobao', { titles: ['MODEL-A-01', 'MODEL-A-01'] }).read().ok, true);
    assert.equal(productEnvironment('taobao', { titles: ['MODEL-A-01', 'MODEL-B-01'] }).read().error, 'PRODUCT_FIELDS_UNAVAILABLE');
});

test('1688标题命中不能掩盖独立SKU为其他型号或较长后缀', () => {
    const wrong = productEnvironment('1688', { sku: ['3RW3016'], rows: ['型号 3RW3016'] }).read();
    assert.equal(wrong.title, '全新 MODEL-A-01 原装');
    assert.equal(wrong.error, 'PRODUCT_MODEL_UNCONFIRMED');
    assert.equal(productEnvironment('1688', { sku: ['MODEL-A-010'], rows: ['型号 MODEL-A-010'] }).read().ok, false);
    const attributeOnly = productEnvironment('1688', { sku: [], rows: ['描述 兼容MODEL-A-01 品牌匿名'] }).read();
    assert.equal(attributeOnly.ok, false, '任意属性/描述行的目标文字不能代替独立SKU核验');
    assert.deepEqual(attributeOnly.attributeRows, ['描述 兼容MODEL-A-01 品牌匿名']);
});
test('淘宝锚点歧义或商品不对应时不输出商家身份', () => {
    const shopUrl = 'https://anonymous-shop.taobao.com/category.htm';
    const anchor = { href: shopUrl, __reactFiber$fixture: { memoizedProps: { sellerId: 'seller-test', itemId: 'other-item', storeCardVO: { shopName: '匿名店', shopUrl } } } };
    const context = { document: { querySelectorAll: () => [anchor] }, location: new URL('https://item.taobao.com/item.htm?id=10001') };
    assert.equal(extract('taobao', context, { recipientId: 'seller-test', verifiedShopUrl: shopUrl }), null);
    context.document.querySelectorAll = () => [anchor, anchor];
    assert.equal(extract('taobao', context, { recipientId: 'seller-test', verifiedShopUrl: shopUrl }), null);
});
test('1688仅白名单公开字段，买家/卖家/domain交叉；不读取秘密字段', () => {
    const globalData = { sellerId: 12345, buyerId: 67890, buyerIsLogin: true, domain: 'anonymous-shop.1688.com', memberId: 'opaque-member-test',
        get token() { assert.fail('不得读token'); } };
    const context = { window: { pageData: { globalData } }, location: new URL('https://anonymous-shop.1688.com/') };
    const input = { recipientId: '12345', buyerId: '67890' };
    const out = extract('1688', context, input);
    assert.equal(out.value, '12345'); assert.equal(out.buyerId, '67890'); assert.equal(out.memberId, 'opaque-member-test');
    assert.equal(out.token, undefined); assert.equal(out.source, 'window.pageData.globalData.sellerId');
    const identity = { platform: '1688', account: { type: 'loginId', value: '匿名买家', source: 'conversation-list.currentLoginId' },
        recipient: { targetId: '12345', targetType: '8', bizType: '11152', entityType: 'U', channelType: 3, source: 'conversationIdentifier.target' },
        buyer: { targetId: '67890', targetType: '8', uid: '67890@cntaobao', displayName: '匿名买家', source: 'self-message' },
        conversationId: 'opaque', contact: '匿名店', headerName: '匿名店', verifiedAt: new Date().toISOString(), businessIdentity: out };
    assert.deepEqual(identityProblems(identity), []);
    for (const [key, value] of [['buyerIsLogin', false], ['buyerId', 111], ['domain', 'wrong.1688.com'], ['sellerId', Number.MAX_SAFE_INTEGER + 1]]) {
        const before = globalData[key]; globalData[key] = value;
        assert.equal(extract('1688', context, input), null); globalData[key] = before;
    }
});
