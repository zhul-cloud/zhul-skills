// 执行平台文档中的真实提取片段；只用匿名DOM/公开初始化fixture，不打开浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { identityProblems } from '../scripts/contacts.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));
function extract(platform, context, input) {
    const markdown = readFileSync(new URL(`../platforms/${platform}.md`, import.meta.url), 'utf8');
    const blocks = [...markdown.matchAll(/```js\r?\n([\s\S]*?)\r?\n```/g)];
    const source = blocks.find((match) => match[1].includes(`zhul-business-observation: ${platform}`));
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
