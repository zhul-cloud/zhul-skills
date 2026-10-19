import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planCoverage, coverageProblems, coverageTransitionProblems } from '../scripts/search-coverage.mjs';

const at = '2026-10-19T10:00:00.000Z';
const items = [{ itemId: 11, model: 'MODEL-A-01', quantity: 1, unit: '台' }, { itemId: 12, model: 'MODEL-A-01', quantity: 5, unit: '台' }, { itemId: 22, model: 'SERIES-B-99', quantity: 2, unit: '只' }];
const run = () => ({ runId: 'coverage-run', platforms: ['淘宝', '1688'], items: structuredClone(items) });
const part = (products = [], platform = '淘宝', range = { min: 2, max: 2 }) => ({ platform, shops: [], searchCoverage: { runId: 'coverage-run', platform, shopsPerItem: range, products } });
function product(id, merchant, ids = [11, 12, 22], platform = '淘宝', extra = {}) {
    return { productId: String(id), productUrl: platform === '淘宝' ? `https://item.taobao.com/item.htm?id=${id}` : `https://detail.1688.com/offer/${id}.html`,
        skuState: 'selected-SKU', verifiedAt: at, eligible: true,
        merchant: { id: merchant, idKind: 'sellerId', name: '商家' + merchant, sourceUrl: platform === '淘宝' ? 'https://shop.taobao.com/shop/view_shop.htm' : 'https://seller.1688.com/page/index.htm', verifiedAt: at },
        matches: ids.map(id => ({ ...items.find(i => i.itemId === id), skuState: 'selected-SKU', exactModel: true, suffix: true, specifications: true, verifiedAt: at })), ...extra };
}

test('one shared product can cover all distinct ERP items including same model with different quantity, then stops at two merchants', () => {
    const p = part([product(1, 'a'), product(2, 'b'), product(3, 'c')]);
    const result = planCoverage(run(), p);
    assert.equal(result.stopSearch, true); assert.deepEqual(result.uncoveredItemIds, []);
    assert.deepEqual(result.shops.map(s => [s.merchantKey, s.itemIds]), [['id:sellerId:a', [11, 12, 22]], ['id:sellerId:b', [11, 12, 22]]]);
    assert.ok(result.coverage.every(i => i.count === 2));
    assert.ok(result.shops.every(s => s.canSendInitial));
    assert.equal(Object.hasOwn(p, 'sentAt'), false);
});

test('duplicate URLs/products/verified merchant aliases count once', () => {
    const alias = product(2, 'a'); alias.merchant.name = '已核客服别名';
    const result = planCoverage(run(), part([product(1, 'a'), alias]));
    assert.ok(result.coverage.every(i => i.count === 1)); assert.equal(result.stopSearch, false);
    assert.equal(result.shops.length, 1); assert.deepEqual(result.shops[0].productUrls.length, 2);
    assert.throws(() => planCoverage(run(), part([product(1, 'a'), product(1, 'a')])), /每个 productId/);
});

test('candidate hints and per-item missing suffix/specification never count, even if another item shares the model', () => {
    const p = product(1, 'a'); p.matches[0].suffix = false; p.matches[1].specifications = false;
    const snapshot = part([p]); snapshot.searchCoverage.candidateSnapshots = [{ candidates: [{ matchItemIds: [11, 12, 22] }] }];
    const result = planCoverage(run(), snapshot);
    assert.deepEqual(result.coverage.map(i => i.count), [0, 0, 1]);
    assert.deepEqual(result.uncoveredItemIds, [11, 12, 22]);
});

test('model/suffix/spec verification and SKU state are bound separately for every item', () => {
    const p = product(1, 'a'); p.skuState = 'changed-SKU';
    assert.ok(planCoverage(run(), part([p])).coverage.every(i => i.count === 0));
    p.matches[0].skuState = 'changed-SKU';
    assert.deepEqual(planCoverage(run(), part([p])).shops[0].itemIds, [11]);
    p.matches[1].quantity = 1;
    assert.throws(() => planCoverage(run(), part([p])), /原 itemId/);
});

for (const fact of [{ sentAt: at }, { pendingMessage: { state: 'pending' } }, { reusedFrom: at }, { endedAt: at }]) {
    test(`existing ${Object.keys(fact)[0]} keeps original itemIds, blocks new first messages and cannot gain another item`, () => {
        const p = part([product(1, 'a'), product(2, 'b')]);
        p.shops = [{ shop: '商家a', merchantKey: 'id:sellerId:a', itemIds: [11], ...fact }];
        const result = planCoverage(run(), p);
        assert.deepEqual(result.shops.find(s => s.merchantKey === 'id:sellerId:a').itemIds, [11]);
        assert.equal(result.shops[0].canSendInitial, false);
        assert.deepEqual(result.coverage.map(i => i.count), [2, 1, 1]);
        assert.deepEqual(result.uncoveredItemIds, [12, 22]);
    });
}

test('existing progress above a new maximum is preserved without selecting or sending additional shops', () => {
    const p = part([product(1, 'a'), product(2, 'b'), product(3, 'c'), product(4, 'd')]);
    p.shops = ['a', 'b', 'c'].map(id => ({ shop: '商家' + id, merchantKey: 'id:sellerId:' + id, itemIds: [11, 12, 22], sentAt: at }));
    const result = planCoverage(run(), p);
    assert.deepEqual(result.coverage.map(i => i.count), [3, 3, 3]);
    assert.equal(result.shops.length, 3); assert.equal(result.stopSearch, true);
    assert.ok(result.shops.every(s => !s.canSendInitial));
});

test('max is the target and min is a shortage threshold; exhausted evidence is never a no-stock conclusion', () => {
    const result = planCoverage(run(), part([product(1, 'a')], '淘宝', { min: 2, max: 3 }));
    assert.ok(result.coverage.every(i => i.belowMinimum && i.missing === 2 && i.target === 3));
    assert.equal(result.stopSearch, false); assert.equal(Object.hasOwn(result, 'noStock'), false);
    const two = planCoverage(run(), part([product(1, 'a'), product(2, 'b')], '淘宝', { min: 2, max: 3 }));
    assert.ok(two.coverage.every(i => !i.belowMinimum && i.missing === 1)); assert.equal(two.stopSearch, false);
});

test('unique verified full-name fallback joins a stable ID, but ambiguous same-name identities fail closed', () => {
    const fallback = product(2, 'a'); delete fallback.merchant.id; fallback.merchant.nameUnique = true;
    assert.equal(planCoverage(run(), part([product(1, 'a'), fallback])).coverage[0].count, 1);
    const duplicateName = product(3, 'b'); duplicateName.merchant.name = '商家a';
    assert.throws(() => planCoverage(run(), part([product(1, 'a'), duplicateName, fallback])), /多个 ID/);
    delete fallback.merchant.nameUnique;
    assert.throws(() => planCoverage(run(), part([fallback])), /全称唯一/);
});

test('platform/run/config bindings reject cross-platform evidence and unrelated identities', () => {
    assert.throws(() => planCoverage(run(), part([product(1, 'a', [11], '1688')])), /本平台/);
    const p = part([product(1, 'a', [11], '1688')], '1688');
    assert.deepEqual(planCoverage(run(), p).coverage.map(i => i.count), [1, 0, 0]);
    p.searchCoverage.runId = 'other-run'; assert.throws(() => planCoverage(run(), p), /run\/平台/);
    assert.throws(() => planCoverage(run(), part(), { shopsPerItem: { min: 1, max: 1 } }), /本次配置/);
});

test('checkpoint validator accepts progressive evidence, then requires the complete merged item plan at shopsPicked', () => {
    const p = part([product(1, 'a'), product(2, 'b')]);
    assert.deepEqual(coverageProblems(run(), p), []);
    p.stages = { shopsPicked: at };
    assert.match(coverageProblems(run(), p)[0], /缺少计划/);
    p.shops = planCoverage(run(), p).shops.map(s => ({ ...s, status: '未回复', quotes: [] }));
    assert.deepEqual(coverageProblems(run(), p), []);
    p.shops[0].itemIds = [11]; assert.match(coverageProblems(run(), p)[0], /缺少计划/);
    assert.deepEqual(coverageProblems(run(), { platform: '淘宝' }), [], 'old runs remain compatible');
});


test('retained old sent shops use original typed identity without reopening their product page; unresolved old shops remain blocked and uncounted', () => {
    const p = part([product(2, 'b')]);
    p.shops = [{ shop: '历史店', itemIds: [11], sentAt: at, identity: { businessIdentity: { type: 'sellerId', value: 'a', observedAt: at } } },
        { shop: '未核历史店', itemIds: [12], sentAt: at }];
    const result = planCoverage(run(), p);
    assert.deepEqual(result.coverage.map(i => i.count), [2, 1, 1]);
    assert.deepEqual(result.shops.find(s => s.shop === '历史店').itemIds, [11]);
    const unknown = result.shops.find(s => s.shop === '未核历史店');
    assert.equal(unknown.identityUnresolved, true); assert.equal(unknown.canSendInitial, false);
    assert.deepEqual(coverageProblems(run(), p), []);
});

test('conflicting old/new SKU product snapshots and wrong merchant ID kind cannot bypass invalidation or deduplication', () => {
    const next = product(1, 'a'); next.skuState = 'new-SKU';
    assert.throws(() => planCoverage(run(), part([product(1, 'a'), next])), /每个 productId/);
    next.merchant.idKind = 'shopId';
    assert.throws(() => planCoverage(run(), part([next])), /不能混用/);
});

test('two unsent rows for one merchant fail checkpoint even if their union covers the plan', () => {
    const p = part([product(1, 'a')]);
    p.shops = [{ shop: '商家a', merchantKey: 'id:sellerId:a', itemIds: [11] }, { shop: '商家a', merchantKey: 'id:sellerId:a', itemIds: [12, 22] }];
    assert.match(coverageProblems(run(), p)[0], /必须合并/);
});


test('changed original specification description invalidates cached per-item proof', () => {
    const current = run(); current.items[0].description = '24V DC';
    assert.throws(() => planCoverage(current, part([product(1, 'a')])), /description/);
});


test('coverage checkpoint transition preserves original sent or pending itemIds and their no-resend facts', () => {
    const previous = part(); previous.shops = [{ shop: '原店', itemIds: [11, 12], sentAt: at }];
    for (const shops of [[], [{ shop: '原店', itemIds: [11], sentAt: at }], [{ shop: '原店', itemIds: [11, 12, 22], sentAt: at }], [{ shop: '原店', itemIds: [11, 12] }]]) {
        assert.match(coverageTransitionProblems(previous, { ...previous, shops })[0], /完整原 itemIds/);
    }
    assert.deepEqual(coverageTransitionProblems(previous, structuredClone(previous)), []);
});


test('mixed fixed and unsent merchant rows are refused in either order', () => {
    const p = part([product(1, 'a')]);
    const fresh = { shop: '商家a', merchantKey: 'id:sellerId:a', itemIds: [11] };
    const sent = { ...fresh, itemIds: [12], sentAt: at };
    for (const shops of [[fresh, sent], [sent, fresh]]) {
        p.shops = shops; assert.match(coverageProblems(run(), p)[0], /必须合并|未经逐项/);
    }
});

test('explicit cancellation of an unconfirmed unsent intent is retained without counting coverage or erasing sent facts', () => {
    const previous = part();
    previous.shops = [{ shop: '原店', itemIds: [11], pendingMessage: { messageId: 'one', kind: 'initial', text: '原文', preparedAt: at, state: 'pending' } }];
    const next = structuredClone(previous); next.shops[0].pendingMessage.state = 'cancelled';
    assert.deepEqual(coverageTransitionProblems(previous, next), []);
    assert.deepEqual(coverageProblems(run(), next), []);
    assert.equal(planCoverage(run(), next).coverage[0].count, 0);
    next.shops[0].pendingMessage.messageId = 'another'; assert.match(coverageTransitionProblems(previous, next)[0], /必须保留/);
    previous.shops[0].sentAt = at; delete next.shops[0].sentAt;
    assert.match(coverageTransitionProblems(previous, next)[0], /必须保留/);
});


test('coverage CLI requires effective settings and returns a merged read-only plan without changing input files', t => {
    const root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.coverage-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const values = [run(), part([product(1, 'a'), product(2, 'b')]), { settings: { shopsPerItem: { min: 2, max: 2 } } }];
    const paths = values.map((v, i) => { const path = join(root, String(i) + '.json'); writeFileSync(path, JSON.stringify(v)); return path; });
    const before = paths.map(p => readFileSync(p, 'utf8'));
    const script = fileURLToPath(new URL('../scripts/search-coverage.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, ...paths], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout); assert.equal(plan.stopSearch, true);
    assert.deepEqual(plan.shops.map(s => s.itemIds), [[11, 12, 22], [11, 12, 22]]);
    assert.deepEqual(paths.map(p => readFileSync(p, 'utf8')), before);
    assert.equal(spawnSync(process.execPath, [script, ...paths.slice(0, 2)], { encoding: 'utf8' }).status, 2);
});


test('a previously unique-name merchant binding can gain a verified sellerId without duplicate counting or reopening a sent shop', () => {
    const p = part([product(1, 'a')]);
    p.shops = [{ shop: '商家a', merchantKey: 'name:商家a', itemIds: [11], sentAt: at }];
    const result = planCoverage(run(), p);
    assert.deepEqual(result.shops.map(s => [s.merchantKey, s.itemIds, s.canSendInitial]), [['id:sellerId:a', [11], false]]);
    assert.deepEqual(result.coverage.map(i => i.count), [1, 0, 0]);
    assert.deepEqual(coverageProblems(run(), p), []);
});


test('an enabled coverage record cannot be removed to bypass verification; historical runs remain compatible', () => {
    assert.match(coverageTransitionProblems(part(), { platform: '淘宝', shops: [] })[0], /不能删除/);
    assert.deepEqual(coverageTransitionProblems({ shops: [] }, { shops: [] }), []);
});

test('ERP read-only lockedItems stay in the original record and never become search targets', () => {
    const value = run(); value.lockedItems = [{ itemId: 33, model: 'READ-ONLY', reason: '已报给客户' }];
    const before = JSON.stringify(value);
    assert.deepEqual(planCoverage(value, part()).coverage.map(i => i.itemId), [11, 12, 22]);
    assert.equal(JSON.stringify(value), before);
});


test('same full name with distinct explicit sellerIds validates by identity and preserves the correct original itemIds', () => {
    const a = product(1, 'a', [11]), b = product(2, 'b', [22]); a.merchant.name = b.merchant.name = '同名店';
    const p = part([a, b]);
    p.shops = [{ shop: '同名店', merchantKey: 'id:sellerId:a', itemIds: [11], sentAt: at },
        { shop: '同名店', merchantKey: 'id:sellerId:b', itemIds: [22], sentAt: at }];
    assert.deepEqual(planCoverage(run(), p).shops.map(s => [s.merchantKey, s.itemIds]), [['id:sellerId:a', [11]], ['id:sellerId:b', [22]]]);
    assert.deepEqual(coverageProblems(run(), p), []);
    assert.deepEqual(coverageTransitionProblems(p, structuredClone(p)), []);
    const swapped = structuredClone(p); swapped.shops.reverse();
    assert.deepEqual(coverageProblems(run(), swapped), []);
    assert.deepEqual(coverageTransitionProblems(p, swapped), []);
});


test('retained typed sellerId wins over a name binding and conflicting fresh same-name evidence is refused', () => {
    const p = part([product(1, 'b', [11])]); p.searchCoverage.products[0].merchant.name = '原店';
    const old = { shop: '原店', merchantKey: 'name:原店', itemIds: [11], sentAt: at,
        identity: { businessIdentity: { type: 'sellerId', value: 'a', observedAt: at } } };
    p.shops = [old];
    assert.throws(() => planCoverage(run(), p), /原已核商家身份.*冲突/);
    p.shops[0].merchantKey = 'id:sellerId:b';
    assert.throws(() => planCoverage(run(), p), /sellerId.*merchantKey.*冲突/);
    p.shops[0].merchantKey = 'name:原店'; p.searchCoverage.products[0].merchant.id = 'a';
    assert.equal(planCoverage(run(), p).shops[0].merchantKey, 'id:sellerId:a');
    const after = structuredClone(p); after.shops[0].identity.businessIdentity.value = 'b'; after.shops[0].merchantKey = 'id:sellerId:b';
    assert.match(coverageTransitionProblems(p, after)[0], /必须保留/);
});


test('distinct sellerIds with the same full name cannot both enter new selection, so another merchant fills the gap', () => {
    const a = product(1, 'a'), b = product(2, 'b'), c = product(3, 'c'); a.merchant.name = b.merchant.name = '同名店';
    const result = planCoverage(run(), part([a, b, c]));
    assert.deepEqual(result.shops.map(s => s.merchantKey), ['id:sellerId:a', 'id:sellerId:c']);
    assert.ok(result.coverage.every(i => i.count === 2)); assert.equal(result.stopSearch, true);
    assert.deepEqual(result.merchantNameConflicts, []);
});

test('historical sent same-name overlapping items retain facts, count only one ERP-distinguishable merchant and block completion for review', () => {
    const a = product(1, 'a', [11]), b = product(2, 'b', [11]); a.merchant.name = b.merchant.name = '同名店';
    const p = part([a, b]);
    p.shops = ['a', 'b'].map(id => ({ merchantKey: 'id:sellerId:' + id, shop: '同名店', itemIds: [11], sentAt: at }));
    const result = planCoverage(run(), p);
    assert.equal(result.coverage[0].count, 1); assert.equal(result.shops.length, 2); assert.equal(result.merchantNameConflicts.length, 1);
    assert.deepEqual(coverageProblems(run(), p), []);
    p.status = 'completed'; assert.match(coverageProblems(run(), p)[0], /旧历史键区分/);
});


test('same full-name different sellerIds are excluded across different items too, before legacy history could conflate them', () => {
    const a = product(1, 'a', [11]), b = product(2, 'b', [22]), c = product(3, 'c', [22]); a.merchant.name = b.merchant.name = '同名店';
    const result = planCoverage(run(), part([a, b, c]));
    assert.deepEqual(result.shops.map(s => [s.merchantKey, s.itemIds]), [['id:sellerId:a', [11]], ['id:sellerId:c', [22]]]);
});


test('full-name comparison trims whitespace consistently with ERP and local history', () => {
    const a = product(1, 'a'), b = product(2, 'b'); a.merchant.name = '同名店'; b.merchant.name = ' 同名店 ';
    assert.equal(planCoverage(run(), part([a, b])).shops.length, 1);
});
