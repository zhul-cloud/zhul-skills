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
    const counts = { reads: 0, bodyReads: 0, queries: 0 };
    const node = (text, visible = true) => ({
        get innerText() { counts.reads++; return text; },
        get textContent() { counts.reads++; return text; },
        getClientRects: () => visible ? [{}] : [],
        closest: () => null,
    });
    const tableNode = (text, hidden = false, spans = {}) => Object.assign(node(text, !hidden), { colSpan: 1, rowSpan: 1, ...spans });
    const wrappers = (options.tables || []).map(table => {
        const headers = (table.headers || ['型号', '极数', '辅助触点形式', '线圈额定电压', '额定电流', '']).map((text, i) => tableNode(text, table.hiddenHeader === i, { closest: () => table.ariaHiddenHeader === i ? {} : null, ...table.headerSpans?.[i] }));
        const headerRow = Object.assign(node('', !table.hiddenHeaderRow), { querySelectorAll: selector => { assert.equal(selector, ':scope > th'); return headers; } });
        const rows = (table.rows || [['MODEL-A-01', '3P', '1NO1NC', 'DC24V', '9A']]).map((values, rowIndex) => Object.assign(node('', table.hiddenRow !== rowIndex), { closest: () => table.ariaHiddenRow === rowIndex || table.measureRow === rowIndex ? {} : null, querySelectorAll: selector => {
            assert.equal(selector, ':scope > td'); return values.map((value, index) => tableNode(value, table.hiddenCell === index, { closest: () => table.ariaHiddenCell === index ? {} : null, ...table.cellSpans?.[index] }));
        } }));
        const container = Object.assign(node('', !table.hiddenContainer), { closest: () => table.ariaHiddenContainer ? {} : null, querySelectorAll: selector => {
            if (selector === '.ant-table-header .ant-table-thead > tr') return [headerRow];
            if (selector === '.ant-table-body .ant-table-tbody > tr[data-row-key]') return rows;
            assert.fail(`未审查的SKU容器选择器 ${selector}`);
        } });
        return Object.assign(node('', !table.hiddenWrapper), { closest: () => table.ariaHiddenWrapper ? {} : null, querySelectorAll: selector => { assert.equal(selector, '.ant-table-container'); return table.duplicateContainer ? [container, container] : [container]; } });
    });
    const skuModule = Object.assign(node('', !options.hiddenSkuModule), { closest: () => options.ariaHiddenSkuModule ? {} : null, querySelectorAll: selector => { assert.equal(selector, '.ant-table-wrapper.sku-attr-table'); return wrappers; } });
    const title = '全新 MODEL-A-01 原装';
    const shop = Object.assign(node('匿名设备有限公司\n评分4.8\n平均8小时发货'), { href: options.shopUrl ?? `https://anonymous-shop.${platform === 'taobao' ? 'taobao' : '1688'}.com/?tracking=anonymous`, closest: selector => selector === '.shop-container' ? node('匿名设备有限公司\n评级AAA\n平均8小时发货') : null });
    if (platform === '1688') Object.defineProperty(shop, 'innerText', { get() { counts.reads++; return '匿名设备有限公司'; } });
    const nodes = {
        title: (options.titles || [title]).map((text) => node(text)),
        shop: options.duplicateShop ? [shop, shop] : [shop],
        sku: (options.sku || ['MODEL-A-01']).map((text) => node(text)),
        rows: (options.rows || []).map((text) => node(text)),
        challenge: options.challenge ? [node('需要验证')] : [],
    };
    const document = { body: options.bodyMissing ? null : { get innerText() {
        counts.bodyReads++;
        if (options.forbidBody) assert.fail('错误页面不得读取正文');
        return options.bodyText ?? '正常商品详情';
    } }, querySelectorAll: (selector) => {
        counts.queries++;
        if (selector.startsWith('.nc_scale')) return nodes.challenge;
        if (selector === 'div[class^="ItemTitle--"]' || selector === '.title-content h1') return nodes.title;
        if (selector === 'a[class*="detailWrap--"]' || selector === 'a.shop-company-name') return nodes.shop;
        if (selector === 'span[class*="valueItemText--"]' || selector === '.item-label') return nodes.sku;
        if (selector === 'tr.ant-descriptions-row') return nodes.rows;
        if (selector === '.module-od-product-attributes') return options.tables && !options.tableOutsideModule ? options.duplicateSkuModule ? [skuModule, skuModule] : [skuModule] : [];
        if (selector === 'a.delivery-limit') return [node('承诺24小时发货')];
        assert.fail(`未审查的选择器 ${selector}`);
    } };
    const location = new URL(options.href ?? (platform === 'taobao' ? 'https://item.taobao.com/item.htm?id=10001' : 'https://detail.1688.com/offer/10001.html'));
    const forbidden = () => assert.fail('详情片段不得访问网络或秘密存储');
    const secretStorage = new Proxy({}, { get: forbidden });
    return { counts, nodes, node, read: (input = { itemId: '10001', model: 'MODEL-A-01' }) => extract(platform,
        { document, location, fetch: forbidden, XMLHttpRequest: forbidden, localStorage: secretStorage, sessionStorage: secretStorage }, input, 'product-fields') };
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

test('淘宝独立SKU允许精确型号与竖线规格两段并保留完整原文', () => {
    const source = 'MODEL-A-01 | 24V 3.2A 不含配件';
    for (const href of ['https://item.taobao.com/item.htm?id=10001', 'https://detail.tmall.com/item.htm?id=10001']) {
        const result = productEnvironment('taobao', { href, sku: ['MODEL-A-010 | 24V 3.2A', source, 'MODEL-B-01 | 12V 6A'] }).read();
        assert.equal(result.ok, true); assert.deepEqual(result.exactSku, [source]);
    }
});

test('淘宝竖线SKU拒绝右段型号、型号前后缀、多型号段及含糊描述', () => {
    for (const sku of ['OTHER | MODEL-A-01 24V', 'MODEL-A-010 | 24V', 'XMODEL-A-01 | 24V', 'MODEL-A-01X | 24V',
        'MODELA01 | 24V', 'MODEL-A-01 24V 3.2A', 'MODEL-A-01 | ', ' | MODEL-A-01',
        'MODEL-A-01 / MODEL-B-01 | 24V', 'MODEL-A-01 | MODEL-B-01 | 24V', 'MODEL-A-01 ｜ 24V']) {
        assert.equal(productEnvironment('taobao', { sku: [sku] }).read().error, 'PRODUCT_MODEL_UNCONFIRMED', sku);
    }
});

test('淘宝实际提示页或登录URL不能作为目标商品，不读页面正文或商品字段', () => {
    for (const [href, error] of [
        ['https://huodong.taobao.com/wow/z/app/default/safe-access-tips?token=synthetic-secret', 'PRODUCT_PAGE_UNAVAILABLE'],
        ['https://login.taobao.com/havanaone/login/login.htm?redirect=synthetic-secret', 'PRODUCT_LOGIN_REQUIRED'],
    ]) {
        const env = productEnvironment('taobao', { href, forbidBody: true });
        assert.deepEqual(env.read(), { ok: false, error });
        assert.deepEqual(env.counts, { reads: 0, bodyReads: 0, queries: 0 });
    }
});

const riskNotice = '系统检测到当前访问存在异常\n恢复正常访问方式后，商品详情页将在一段时间后自动恢复';
test('淘宝风险提示不妨碍必要商品字段完整的正常读取', () => {
    for (const bodyText of [riskNotice, '系统检测到当前访问存在异常', '商品详情页将在一段时间后自动恢复',
        '商品异常处理说明，恢复正常后使用', '图文详情暂不可用，pcResistDetail pcIdentityRisk']) {
        const out = productEnvironment('taobao', { bodyText }).read();
        assert.equal(out.ok, true);
        assert.deepEqual(out.exactSku, ['MODEL-A-01']);
        assert.equal(out.shopName, '匿名设备有限公司');
    }
});

test('淘宝独立风险标记不改变正确商品的可读性', () => {
    for (const marker of ['pcResistDetail', 'pcIdentityRisk']) {
        const env = productEnvironment('taobao', { href: `https://item.taobao.com/item.htm?id=10001&${marker}=true` });
        assert.equal(env.read().ok, true);
    }
});

test('淘宝风险提示不能掩盖验证码、缺必要字段或错误型号', () => {
    const env = productEnvironment('taobao', { challenge: true, bodyText: riskNotice });
    assert.deepEqual(env.read(), { ok: false, error: 'VISIBLE_VERIFICATION' });
    assert.deepEqual(env.counts, { reads: 0, bodyReads: 1, queries: 1 });
    for (const options of [{ sku: [] }, { titles: [] }, { duplicateShop: true }, { shopUrl: 'https://example.invalid/' },
        { titles: [], sku: [], bodyText: '发生错误，请稍后重试' }]) {
        assert.equal(productEnvironment('taobao', { bodyText: riskNotice, ...options }).read().error, 'PRODUCT_FIELDS_UNAVAILABLE');
    }
    assert.equal(productEnvironment('taobao', { bodyText: riskNotice, sku: ['MODEL-A-010'] }).read().error, 'PRODUCT_MODEL_UNCONFIRMED');
    assert.equal(productEnvironment('taobao', { bodyText: riskNotice }).read({ itemId: '10002', model: 'MODEL-A-01' }).error, 'PRODUCT_IDENTITY');
});

test('淘宝错商品/未知页及无法核页面正文保持失败，不读取错页或秘密', () => {
    for (const href of ['https://item.taobao.com/item.htm?id=10002&token=synthetic-secret', 'https://example.invalid/item.htm?id=10001']) {
        const env = productEnvironment('taobao', { href, forbidBody: true });
        assert.deepEqual(env.read(), { ok: false, error: 'PRODUCT_IDENTITY' });
        assert.deepEqual(env.counts, { reads: 0, bodyReads: 0, queries: 0 });
    }
    for (const options of [{ bodyMissing: true }, { bodyText: ' \n\t' }]) {
        const env = productEnvironment('taobao', options);
        assert.deepEqual(env.read(), { ok: false, error: 'PRODUCT_PAGE_UNCONFIRMED' });
        assert.equal(env.counts.reads, 0);
        assert.equal(env.counts.queries, 0);
    }
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

test('1688独立SKU表按唯一型号列读取同行规格，保留原文并兼容分离表头滚动栏', () => {
    const result = productEnvironment('1688', { sku: [], tables: [{}] }).read();
    assert.equal(result.ok, true); assert.deepEqual(result.exactSku, ['MODEL-A-01']);
    assert.deepEqual(result.skuRows, [[{ label: '型号', value: 'MODEL-A-01' }, { label: '极数', value: '3P' }, { label: '辅助触点形式', value: '1NO1NC' }, { label: '线圈额定电压', value: 'DC24V' }, { label: '额定电流', value: '9A' }]]);
    const reordered = productEnvironment('1688', { sku: [], tables: [{ headers: ['额定电流', '型号', '线圈额定电压'], rows: [['9', 'MODEL-A-01', '24']] }] }).read();
    assert.equal(reordered.ok, true); assert.deepEqual(reordered.skuRows[0], [{ label: '额定电流', value: '9' }, { label: '型号', value: 'MODEL-A-01' }, { label: '线圈额定电压', value: '24' }]);
});

test('1688 SKU表拒绝其他列/描述/较长后缀命中及旧独立选项冲突', () => {
    for (const table of [
        { headers: ['型号', '描述'], rows: [['MODEL-B-01', '兼容MODEL-A-01']] },
        { headers: ['描述', '型号'], rows: [['MODEL-A-01', 'MODEL-A-010']] },
        { headers: ['型号'], rows: [['MODEL-A-01 后缀']] },
    ]) {
        assert.equal(productEnvironment('1688', { sku: [], rows: ['描述 MODEL-A-01'], tables: [table] }).read().error, 'PRODUCT_MODEL_UNCONFIRMED');
    }
    assert.equal(productEnvironment('1688', { sku: ['MODEL-B-01'], tables: [{}] }).read().error, 'PRODUCT_MODEL_UNCONFIRMED');
    assert.equal(productEnvironment('1688', { sku: ['MODEL-A-01'], tables: [{ rows: [['MODEL-B-01', '3P', '无', 'DC24V', '9A']] }] }).read().error, 'PRODUCT_MODEL_UNCONFIRMED');
});

test('1688 SKU表拒绝多区域/容器/型号列与合并列歧义，隐藏节点不提供核验', () => {
    for (const tables of [
        [{}, {}], [{ duplicateContainer: true }], [{ headers: ['型号', '型号'], rows: [['MODEL-A-01', 'MODEL-A-01']] }],
        [{ headerSpans: { 0: { colSpan: 2 } } }], [{ cellSpans: { 0: { rowSpan: 2 } } }],
        [{ hiddenContainer: true }], [{ hiddenHeader: 0 }], [{ hiddenHeaderRow: true }], [{ hiddenCell: 0 }], [{ hiddenCell: 3 }],
    ]) assert.equal(productEnvironment('1688', { sku: [], tables }).read().error, 'PRODUCT_FIELDS_UNAVAILABLE');
    for (const table of [{ hiddenWrapper: true }, { hiddenRow: 0 }]) assert.equal(productEnvironment('1688', { sku: [], tables: [table] }).read().error, 'PRODUCT_FIELDS_UNAVAILABLE');
});

test('1688带布局的aria隐藏/测量SKU行和祖先仍不提供型号证据', () => {
    for (const table of [{ ariaHiddenRow: 0 }, { measureRow: 0 }, { ariaHiddenWrapper: true }, { ariaHiddenContainer: true }, { ariaHiddenHeader: 0 }, { ariaHiddenCell: 0 }, { ariaHiddenCell: 3 }]) {
        assert.equal(productEnvironment('1688', { sku: [], tables: [table] }).read().error, 'PRODUCT_FIELDS_UNAVAILABLE');
    }
    const result = productEnvironment('1688', { sku: [], tables: [{ measureRow: 0, rows: [['WRONG', '3P', '无', '24', '9'], ['MODEL-A-01', '3P', '无', 'DC24V', '9A']] }] }).read();
    assert.equal(result.ok, true); assert.equal(result.skuRows.length, 1); assert.equal(result.skuRows[0][0].value, 'MODEL-A-01');
});

test('1688模块外同类SKU表不算商品型号，商品模块不可见或歧义保持拒绝', () => {
    for (const options of [{ tableOutsideModule: true }, { hiddenSkuModule: true }, { ariaHiddenSkuModule: true }, { duplicateSkuModule: true }]) {
        assert.equal(productEnvironment('1688', { sku: [], tables: [{}], ...options }).read().error, 'PRODUCT_FIELDS_UNAVAILABLE');
    }
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
