import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const policy = { initialShopsPerPlatform: 2, targetComparableQuotes: 3, maxShopsPerPlatform: 4 };
const now = () => new Date().toISOString();
const items = [{ itemId: 11, model: 'MODEL-A', quantity: 2, unit: '台', description: '标准规格' }, { itemId: 22, model: 'MODEL-B', quantity: 1, unit: '只' }];
function fixture(t) {
    const root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.adaptive-test-'));
    const home = join(root, 'home'), skill = join(root, 'skill'); mkdirSync(home); mkdirSync(skill);
    cpSync(join(source, 'scripts'), join(skill, 'scripts'), { recursive: true });
    for (const file of ['SKILL.md', 'settings.json']) copyFileSync(join(source, file), join(skill, file));
    const script = join(skill, 'scripts', 'records.mjs'), env = { ...process.env, HOME: home, USERPROFILE: home };
    assert.equal(resolve(spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { env, encoding: 'utf8' }).stdout), resolve(home));
    const cli = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 15000 });
    const json = (...args) => { const r = cli(...args); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
    json('init'); const dir = json('open-run', 'IQ-ADAPTIVE-FIXTURE').runDir;
    const read = () => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    let serial = 0;
    const input = value => { const p = join(root, `input-${++serial}.json`); writeFileSync(p, JSON.stringify(value)); return p; };
    const r = read();
    json('checkpoint', dir, input({ runId: r.runId, eventId: 'bind', actor: 'main', scope: 'run', expectedRevision: r.revision,
        event: { eventType: 'task.read', phase: 'task' }, snapshot: { ...r, taskId: 123, items, platforms: ['淘宝', '1688'] } }));
    const partPath = platform => join(dir, `run-${platform}.json`);
    const readPart = platform => existsSync(partPath(platform)) ? JSON.parse(readFileSync(partPath(platform), 'utf8')) : null;
    const part = (platform, shops = [], extra = {}) => ({ ...read(), eventSeq: undefined, platform, revision: 0, status: 'running', shops, noStock: [], stages: {},
        searchCoverage: { runId: read().runId, platform, inquiryStrategy: policy, products: ['1', '2', '3', '4'].map(id => product(platform, id)) }, ...extra });
    const seed = (platform, value) => writeFileSync(partPath(platform), JSON.stringify(value));
    const save = (platform, snapshot, event = { eventType: 'shop.selected', phase: 'selection', shop: 'fixture', itemIds: [11] }) => {
        const business = structuredClone(snapshot); for (const key of ['schemaVersion', 'runId', 'skillVersion', 'executionVersion', 'revision', 'eventSeq', 'createdAt', 'updatedAt']) delete business[key];
        return cli('checkpoint', dir, input({ runId: read().runId, eventId: `save-${++serial}`, actor: platform, scope: 'platform', platform,
            expectedRevision: readPart(platform)?.revision ?? 0, snapshot: business, event }));
    };
    const background = args => new Promise((resolveExit, reject) => { const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; }); child.once('error', reject); child.once('close', status => resolveExit({ status, stdout, stderr })); });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return { root, home, dir, env, script, cli, json, read, input, part, seed, save, readPart, background };
}
function product(platform, id) {
    const at = now(); return { productId: id, productUrl: platform === '淘宝' ? `https://item.taobao.com/item.htm?id=${id}` : `https://detail.1688.com/offer/${id}.html`, skuState: 'exact', verifiedAt: at, eligible: true,
        merchant: { idKind: 'sellerId', id, name: '店' + id, sourceUrl: platform === '淘宝' ? 'https://shop.taobao.com/license' : 'https://seller.1688.com/license', verifiedAt: at },
        matches: items.map(item => ({ ...item, skuState: 'exact', exactModel: true, suffix: true, specifications: true, verifiedAt: at })) };
}
const shop = (id, extra = {}) => ({ shop: '店' + id, merchantKey: 'id:sellerId:' + id, itemIds: [11, 22], status: '未回复', quotes: [], ...extra });
const ended = (id, extra = {}) => shop(id, { sentAt: now(), endedAt: now(), ...extra });
const quote = (itemId = 11) => ({ itemId, price: 100, taxIncluded: false, freeShipping: true, condition: '全新原装', leadTime: '现货',
    comparability: { source: 'merchant', item: items.find(i => i.itemId === itemId), sourceText: '所需型号数量，全新原装100元不含税包邮现货', verifiedAt: now(), requirementsMet: true, taxConfirmed: true, shippingConfirmed: true, shippingAmount: 0 } });

test('new runs require the main plan and per-item product evidence before first contact', t => {
    const f = fixture(t);
    const missing = f.part('淘宝', [shop('1')]); delete missing.searchCoverage;
    assert.match(f.save('淘宝', missing).stderr, /先由主执行者 plan-inquiry/);
    const emptyResult = { platform: '淘宝', shops: [], status: 'completed', stages: { repliesDone: now() }, noStock: [{ itemId: 11, note: '不能用空店推无货' }] };
    assert.match(f.save('淘宝', emptyResult).stderr, /先由主执行者 plan-inquiry/);
    const first = f.json('plan-inquiry', f.dir); assert.equal(first.plan.round, 1); assert.ok(first.plan.targets.every(t => t.totalShops === 2));
    const picked = f.part('淘宝', [shop('1'), shop('2')]);
    picked.stages.shopsPicked = now(); picked.searchCoverage.pickedRound = 1;
    assert.equal(f.save('淘宝', picked).status, 0);
    const intent = f.readPart('淘宝');
    intent.shops[0].pendingMessage = { messageId: 'first-intent', kind: 'initial', text: '型号数量及原询价要求', preparedAt: now(), state: 'pending' };
    const event = { eventType: 'message.intent', phase: 'messaging', shop: '店1', itemIds: [11, 22], messageId: 'first-intent', messageKind: 'initial' };
    const invalid = structuredClone(intent); invalid.searchCoverage.products[0].matches[0].suffix = false;
    assert.notEqual(f.save('淘宝', invalid, event).status, 0);
    assert.equal(f.save('淘宝', intent, event).status, 0);
    const confirmed = f.readPart('淘宝'); confirmed.shops[0].sentAt = now(); confirmed.shops[0].pendingMessage.state = 'confirmed'; confirmed.shops[0].pendingMessage.confirmedAt = now();
    assert.equal(f.save('淘宝', confirmed, { ...event, eventType: 'message.confirmed' }).status, 0);
    assert.equal(f.readPart('淘宝').shops[0].sentAt, confirmed.shops[0].sentAt);
});

test('concurrent plan requests and a platform checkpoint share one lock, reserve work and survive reopen without extra grants', async t => {
    const f = fixture(t); f.json('plan-inquiry', f.dir);
    for (const p of ['淘宝', '1688']) f.seed(p, f.part(p, [ended('1'), ended('2')]));
    const results = await Promise.all([f.background(['plan-inquiry', f.dir]), f.background(['plan-inquiry', f.dir])]);
    results.forEach(r => assert.equal(r.status, 0, r.stderr));
    assert.equal(results.map(r => JSON.parse(r.stdout)).filter(r => r.changed).length, 1);
    assert.ok(f.read().inquiryPlan.targets.every(t => t.totalShops === 3));
    const before = f.read().inquiryPlan;
    const snapshot = f.readPart('淘宝'); snapshot.shops[0].reply = '人工已读，暂无报价';
    const req = { runId: f.read().runId, eventId: 'parallel-reply', actor: '淘宝', scope: 'platform', platform: '淘宝', expectedRevision: snapshot.revision, snapshot,
        event: { eventType: 'reply.received', phase: 'messaging', shop: '店1', itemIds: [11, 22] } };
    const simultaneous = await Promise.all([f.background(['plan-inquiry', f.dir]), f.background(['checkpoint', f.dir, f.input(req)])]);
    simultaneous.forEach(r => assert.equal(r.status, 0, r.stderr));
    assert.equal(f.readPart('淘宝').shops[0].reply, snapshot.shops[0].reply);
    assert.deepEqual(f.read().inquiryPlan, before);
    assert.equal(f.json('open-run', 'IQ-ADAPTIVE-FIXTURE').resumed, true);
    assert.equal(f.json('plan-inquiry', f.dir).changed, false);
});

test('the third quote cancels only unsent item slots and a mixed candidate can be rebuilt for another missing item', t => {
    const f = fixture(t); f.json('plan-inquiry', f.dir);
    f.seed('淘宝', f.part('淘宝', [ended('1', { status: '已回复', quotes: [quote()] }), shop('2')]));
    f.seed('1688', f.part('1688', ['1', '2'].map(id => ended(id, { status: '已回复', quotes: [quote()] }))));
    const result = f.json('plan-inquiry', f.dir);
    assert.equal(result.items[0].comparableCount, 3);
    assert.equal(result.plan.targets.find(t => t.itemId === 11 && t.platform === '淘宝').totalShops, 1);
    const pending = f.readPart('淘宝'); pending.shops[1].pendingMessage = { messageId: 'late', kind: 'initial', text: '不得再发', preparedAt: now(), state: 'pending' };
    assert.match(f.save('淘宝', pending, { eventType: 'message.intent', phase: 'messaging', shop: '店2', itemIds: [11, 22], messageId: 'late', messageKind: 'initial' }).stderr, /已达有效报价目标/);
    const remaining = f.readPart('淘宝'); remaining.shops[1].itemIds = [22];
    assert.equal(f.save('淘宝', remaining).status, 0);
    const existing = f.readPart('淘宝'); existing.shops[0].reply = '已联系店的正常后续回复';
    assert.equal(f.save('淘宝', existing, { eventType: 'reply.received', phase: 'messaging', shop: '店1', itemIds: [11] }).status, 0);
});

test('old unfinished pending records can acquire a plan, migrate coverage and confirm once; completed history cannot reopen or disappear', t => {
    const f = fixture(t), r = f.read();
    r.skillVersion = '2.12.1'; writeFileSync(join(f.dir, 'run.json'), JSON.stringify(r));
    const pendingMessage = { messageId: 'old-pending', kind: 'initial', text: '旧待核原文', preparedAt: now(), state: 'pending' };
    const noPlan = f.part('淘宝', [shop('1', { pendingMessage })]); delete noPlan.searchCoverage;
    assert.match(f.save('淘宝', noPlan).stderr, /先由主执行者 plan-inquiry/);
    const old = f.part('淘宝', [shop('1', { pendingMessage })]); old.searchCoverage = { runId: r.runId, platform: '淘宝', shopsPerItem: { min: 2, max: 2 }, products: old.searchCoverage.products }; f.seed('淘宝', old);
    assert.equal(f.json('plan-inquiry', f.dir).plan.round, 1);
    const migrated = f.readPart('淘宝'); delete migrated.searchCoverage.shopsPerItem; migrated.searchCoverage.inquiryStrategy = policy;
    migrated.shops[0].sentAt = now(); migrated.shops[0].pendingMessage.state = 'confirmed'; migrated.shops[0].pendingMessage.confirmedAt = now();
    assert.equal(f.save('淘宝', migrated, { eventType: 'message.confirmed', phase: 'messaging', shop: '店1', itemIds: [11, 22], messageId: 'old-pending', messageKind: 'initial' }).status, 0);
    const complete = f.part('1688', [ended('1', { status: '已回复', quotes: [quote()] })], { status: 'completed', stages: { repliesDone: now() } }); delete complete.searchCoverage; f.seed('1688', complete);
    const deleted = structuredClone(complete); deleted.shops = [];
    assert.notEqual(f.save('1688', deleted).status, 0);
    const noPrice = structuredClone(complete); noPrice.shops[0].quotes = [];
    assert.notEqual(f.save('1688', noPrice).status, 0);
    const lostFact = structuredClone(complete); delete lostFact.shops[0].sentAt;
    assert.notEqual(f.save('1688', lostFact).status, 0);
    const lostItem = structuredClone(complete); lostItem.shops[0].itemIds = [11];
    assert.notEqual(f.save('1688', lostItem).status, 0);
    const reopened = structuredClone(complete); reopened.status = 'running'; reopened.stages = {};
    assert.notEqual(f.save('1688', reopened).status, 0);
    const corrected = structuredClone(complete); corrected.shops[0].quotes[0].price = 105;
    assert.equal(f.save('1688', corrected, { eventType: 'quote.recorded', phase: 'messaging', shop: '店1', itemIds: [11] }).status, 0);
});

test('new-mode ERP input preserves prices and requires all contacted shops explicitly no-stock before any no-stock row', t => {
    const f = fixture(t); f.json('plan-inquiry', f.dir);
    const r = f.read(); r.platformStates = { '淘宝': 'completed', '1688': 'completed' };
    r.shops = [ended('1', { platform: '淘宝', noStockItemIds: [11, 22], reply: '两个型号都无货' }), ended('2', { platform: '1688' })];
    r.noStock = [{ itemId: 11, platform: '淘宝', note: '本平台明确无货' }];
    writeFileSync(join(f.dir, 'run.json'), JSON.stringify(r));
    let result = f.json('erp-items', join(f.dir, 'run.json')); assert.deepEqual(result.items, []); assert.deepEqual(result.skipItemIds, [11, 22]);
    r.shops[1].noStockItemIds = [11]; r.shops[1].reply = '第一个型号无货';
    r.shops[1].status = '已回复'; r.shops[1].quotes = [quote(22)];
    writeFileSync(join(f.dir, 'run.json'), JSON.stringify(r));
    result = f.json('erp-items', join(f.dir, 'run.json'));
    assert.equal(result.items.find(i => i.itemId === 11).noStock, true);
    assert.equal(result.items.find(i => i.itemId === 22).quotes[0].unitPrice, 100);
    assert.equal(Object.hasOwn(result.items[1].quotes[0], 'comparability'), false);
    r.userStopped = true; writeFileSync(join(f.dir, 'run.json'), JSON.stringify(r));
    assert.match(f.cli('erp-items', join(f.dir, 'run.json')).stderr, /用户已停止/);
    assert.equal(f.cli('erp-items', join(f.dir, 'run.json'), '--draft').status, 0);
    r.userStopped = false; writeFileSync(join(f.dir, 'run.json'), JSON.stringify(r));
    assert.equal(f.cli('finish', join(f.dir, 'run.json')).status, 0);
    const rows = readFileSync(join(f.home, '.zhul-trade-sourcing', 'records.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.find(row => row.itemId === 22 && row.platform === '1688').comparability, r.shops[1].quotes[0].comparability);
});

test('a supplement can checkpoint product evidence progressively without resetting the first picked time, then merge all items before one initial', t => {
    const f = fixture(t); f.json('plan-inquiry', f.dir); const firstPicked = now();
    for (const platform of ['淘宝', '1688']) {
        const p = f.part(platform, [ended('1'), ended('2')]);
        p.stages.shopsPicked = firstPicked; p.searchCoverage.pickedRound = 1; p.searchCoverage.products = p.searchCoverage.products.slice(0, 2); f.seed(platform, p);
    }
    const plan = f.json('plan-inquiry', f.dir); assert.equal(plan.plan.round, 2);
    const evidence = f.readPart('淘宝'); evidence.searchCoverage.products.push(product('淘宝', '3'));
    assert.equal(f.save('淘宝', evidence, { eventType: 'shop.checked', phase: 'selection', shop: '店3', itemIds: [11, 22], outcome: 'eligible' }).status, 0);
    const premature = f.readPart('淘宝'); premature.shops.push(shop('3', { pendingMessage: { messageId: 'supplement-initial', kind: 'initial', text: '本轮两项合并询价', preparedAt: now(), state: 'pending' } }));
    const event = { eventType: 'message.intent', phase: 'messaging', shop: '店3', itemIds: [11, 22], messageId: 'supplement-initial', messageKind: 'initial' };
    assert.match(f.save('淘宝', premature, event).stderr, /本轮全部明细挑店结束/);
    const picked = f.readPart('淘宝'); picked.shops.push(shop('3')); picked.searchCoverage.pickedRound = 2;
    assert.equal(f.save('淘宝', picked).status, 0);
    const ready = f.readPart('淘宝'); ready.shops[2].pendingMessage = premature.shops[2].pendingMessage;
    assert.equal(f.save('淘宝', ready, event).status, 0);
    assert.equal(f.readPart('淘宝').stages.shopsPicked, firstPicked);
    assert.deepEqual(f.readPart('淘宝').shops[2].itemIds, [11, 22]);
});

test('user stop stays durable across reopen, blocks new contact, permits original intent verification and requires an explicit resume', t => {
    const f = fixture(t); f.json('plan-inquiry', f.dir);
    const p = f.part('淘宝', [shop('1'), shop('2')]); p.stages.shopsPicked = now(); p.searchCoverage.pickedRound = 1;
    assert.equal(f.save('淘宝', p).status, 0);
    const initial = f.readPart('淘宝'); initial.shops[0].pendingMessage = { messageId: 'before-stop', kind: 'initial', text: '停止前意图', preparedAt: now(), state: 'pending' };
    const event = { eventType: 'message.intent', phase: 'messaging', shop: '店1', itemIds: [11, 22], messageId: 'before-stop', messageKind: 'initial' };
    assert.equal(f.save('淘宝', initial, event).status, 0);
    const main = flag => {
        const current = f.read(); return f.json('checkpoint', f.dir, f.input({ runId: current.runId, eventId: `stop-${flag}`, actor: 'main', scope: 'run', expectedRevision: current.revision,
            event: { eventType: 'run.resumed', phase: 'recovery' }, snapshot: { ...current, userStopped: flag } }));
    };
    main(true); assert.equal(f.json('plan-inquiry', f.dir).stopped, true);
    assert.equal(f.json('open-run', 'IQ-ADAPTIVE-FIXTURE').resumed, true); assert.equal(f.read().userStopped, true);
    const another = f.readPart('淘宝'); another.shops[1].pendingMessage = { ...another.shops[0].pendingMessage, messageId: 'after-stop' };
    assert.notEqual(f.save('淘宝', another, { ...event, shop: '店2', messageId: 'after-stop' }).status, 0);
    const confirmed = f.readPart('淘宝'); confirmed.shops = confirmed.shops.slice(0, 1); confirmed.shops[0].sentAt = now();
    confirmed.shops[0].pendingMessage.state = 'confirmed'; confirmed.shops[0].pendingMessage.confirmedAt = now();
    assert.equal(f.save('淘宝', confirmed, { ...event, eventType: 'message.confirmed' }).status, 0);
    const reply = f.readPart('淘宝'); reply.shops[0].reply = '停止期间正常收到的回复';
    assert.equal(f.save('淘宝', reply, { eventType: 'reply.received', phase: 'messaging', shop: '店1', itemIds: [11, 22] }).status, 0);
    main(false); assert.equal(f.json('plan-inquiry', f.dir).stopped, false);
});

test('a damaged peer cannot block saving independent reply evidence but cannot authorize new initial contact', t => {
    const f = fixture(t); f.json('plan-inquiry', f.dir);
    const p = f.part('淘宝', [ended('1'), shop('2')]); p.stages.shopsPicked = now(); p.searchCoverage.pickedRound = 1; f.seed('淘宝', p);
    writeFileSync(join(f.dir, 'run-1688.json'), '{damaged');
    const reply = f.readPart('淘宝'); reply.shops[0].reply = '独立平台正常收到的回复';
    assert.equal(f.save('淘宝', reply, { eventType: 'reply.received', phase: 'messaging', shop: '店1', itemIds: [11, 22] }).status, 0);
    assert.equal(f.cli('merge', f.dir, '--partial', '淘宝').status, 0);
    const first = f.readPart('淘宝'); first.shops[1].pendingMessage = { messageId: 'blocked', kind: 'initial', text: '未发送', preparedAt: now(), state: 'pending' };
    assert.notEqual(f.save('淘宝', first, { eventType: 'message.intent', phase: 'messaging', shop: '店2', itemIds: [11, 22], messageId: 'blocked', messageKind: 'initial' }).status, 0);
    assert.equal(f.readPart('淘宝').shops[1].pendingMessage, undefined);
});

test('confirmed and cancelled initial intents cannot be revived with the same ID; a verified unsent replacement needs a new ID', t => {
    const f = fixture(t); f.json('plan-inquiry', f.dir);
    const p = f.part('淘宝', [shop('1'), shop('2')]); p.stages.shopsPicked = now(); p.searchCoverage.pickedRound = 1;
    assert.equal(f.save('淘宝', p).status, 0);
    const prepare = (index, id) => {
        const current = f.readPart('淘宝'); current.shops[index].pendingMessage = { messageId: id, kind: 'initial', text: '经核验的合并首次询价', preparedAt: now(), state: 'pending' };
        return { snapshot: current, event: { eventType: 'message.intent', phase: 'messaging', shop: current.shops[index].shop, itemIds: [11, 22], messageId: id, messageKind: 'initial' } };
    };
    const first = prepare(0, 'confirmed-first'); assert.equal(f.save('淘宝', first.snapshot, first.event).status, 0);
    const confirmed = f.readPart('淘宝'); confirmed.shops[0].sentAt = now(); confirmed.shops[0].pendingMessage.state = 'confirmed'; confirmed.shops[0].pendingMessage.confirmedAt = now();
    assert.equal(f.save('淘宝', confirmed, { ...first.event, eventType: 'message.confirmed' }).status, 0);
    const revived = f.readPart('淘宝'); revived.shops[0].pendingMessage.state = 'pending';
    assert.match(f.save('淘宝', revived, first.event).stderr, /不能以相同messageId复活/);
    const again = prepare(0, 'different-first'); assert.match(f.save('淘宝', again.snapshot, again.event).stderr, /已联系商家不能/);
    const second = prepare(1, 'cancelled-first'); assert.equal(f.save('淘宝', second.snapshot, second.event).status, 0);
    const cancelled = f.readPart('淘宝'); cancelled.shops[1].pendingMessage.state = 'cancelled';
    assert.equal(f.save('淘宝', cancelled, { ...second.event, eventType: 'message.cancelled' }).status, 0);
    const same = f.readPart('淘宝'); same.shops[1].pendingMessage.state = 'pending';
    assert.match(f.save('淘宝', same, second.event).stderr, /不能以相同messageId复活/);
    const replacement = prepare(1, 'replacement-first');
    const proof = replacement.snapshot.searchCoverage.products[1]; proof.verifiedAt = now(); proof.merchant.verifiedAt = now(); proof.matches.forEach(m => { m.verifiedAt = now(); });
    assert.equal(f.save('淘宝', replacement.snapshot, replacement.event).status, 0);
});
