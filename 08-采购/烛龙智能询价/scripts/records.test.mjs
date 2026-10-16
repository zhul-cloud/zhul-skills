import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./records.mjs', import.meta.url));
const now = () => new Date().toISOString();
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const quote = (itemId = 11, extra = {}) => ({ itemId, price: 100, taxIncluded: false, ...extra });
const shop = (extra = {}) => ({ platform: '淘宝', shop: '测试店', itemIds: [11], status: '已回复', quotes: [quote()], ...extra });
const run = (extra = {}) => ({ task: 'IQ-TEST', taskId: 1, items: [{ itemId: 11, model: 'MODEL-A' }, { itemId: 22, model: 'MODEL-B' }], platforms: ['淘宝', '1688'], shops: [], noStock: [], submitted: false, ...extra });
const part = (platform = '淘宝', extra = {}) => ({ platform, shops: [], noStock: [], stages: { repliesDone: now() }, ...extra });

function fixture(t, value = run()) {
    const root = mkdtempSync(join(dirname(script), '.records-test-'));
    const home = join(root, 'home');
    const dir = join(root, 'run');
    mkdirSync(home);
    mkdirSync(dir);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    // Fail before invoking records if the runtime does not honor the isolated home.
    const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { env, encoding: 'utf8' });
    assert.equal(probe.status, 0);
    assert.equal(resolve(probe.stdout), resolve(home));
    const write = (name, value) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
    write('run.json', value);
    const cli = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 5000 });
    const ok = (...args) => {
        const result = cli(...args);
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        return result.stdout;
    };
    const json = (...args) => JSON.parse(ok(...args));
    const lines = (name) => readFileSync(join(home, '.zhul-trade-sourcing', name), 'utf8').trim().split('\n').map(JSON.parse);
    return { root, home, dir, path: join(dir, 'run.json'), write, cli, ok, json, lines };
}

test('version reads the actual skill version and absolute directory without creating data', (t) => {
    const f = fixture(t);
    const skillDir = resolve(script, '../..');
    const source = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    const result = f.json('version');
    assert.deepEqual(result, {
        name: '烛龙智能询价',
        version: source.match(/^version: (.+)$/m)[1].trim(),
        skillDir,
    });
    assert.equal(existsSync(join(f.home, '.zhul-trade-sourcing')), false);
});

test('version follows a copied script in a path with spaces and needs no settings', (t) => {
    const f = fixture(t);
    const skillDir = join(f.root, 'copied skill with spaces');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    const copiedScript = join(skillDir, 'scripts', 'records.mjs');
    copyFileSync(script, copiedScript);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\r\nname: "复制技能"\r\nversion: "9.8.7"\r\n---\r\n');
    writeFileSync(join(skillDir, 'settings.json'), '{invalid defaults');
    mkdirSync(join(f.home, '.zhul-trade-sourcing'));
    const personalPath = join(f.home, '.zhul-trade-sourcing', 'settings.json');
    writeFileSync(personalPath, '{invalid personal');
    const result = spawnSync(process.execPath, [copiedScript, 'version'], {
        env: { ...process.env, HOME: f.home, USERPROFILE: f.home }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { name: '复制技能', version: '9.8.7', skillDir });
    assert.equal(readFileSync(personalPath, 'utf8'), '{invalid personal');
});

for (const [name, value, message] of [
    ['missing', '', /必须有且只有一个 version/],
    ['invalid', 'version: latest\n', /version 非法/],
    ['duplicate', 'version: 1.2.0\nversion: 2.0.0\n', /必须有且只有一个 version/],
]) {
    test(`version rejects ${name} version without creating data`, (t) => {
        const f = fixture(t);
        const skillDir = join(f.root, 'skill');
        mkdirSync(join(skillDir, 'scripts'), { recursive: true });
        const copiedScript = join(skillDir, 'scripts', 'records.mjs');
        copyFileSync(script, copiedScript);
        writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: 测试\n${value}---\n`);
        const result = spawnSync(process.execPath, [copiedScript, 'version'], {
            env: { ...process.env, HOME: f.home, USERPROFILE: f.home }, encoding: 'utf8', timeout: 5000,
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, message);
        assert.equal(result.stdout, '');
        assert.equal(existsSync(join(f.home, '.zhul-trade-sourcing')), false);
    });
}

test('manual/skip/finish preserve queue and submission history', (t) => {
    const f = fixture(t, run({ shops: [shop()] }));
    f.ok('manual', 'IQ-TEST', '需核对');
    f.ok('finish', f.path);
    f.ok('skip', 'IQ-CANCEL', '已取消');
    assert.equal(f.json('processed', 'IQ-TEST').processed, false);
    const next = f.json('next', 'IQ-TEST', 'IQ-CANCEL', 'IQ-NEW');
    assert.equal(next.next, 'IQ-NEW');
    assert.match(next.skipped[0].reason, /人工/);
    f.write('run.json', run({ shops: [shop()], submitted: true }));
    f.ok('finish', f.path);
    assert.equal(f.json('processed', 'IQ-TEST').processed, true);
    assert.match(f.json('next', 'IQ-TEST').skipped[0].reason, /已提交/);
});

test('finish keeps unsubmitted prices, freeShipping and original reuse time', (t) => {
    const time = ago(60);
    const f = fixture(t, run({ shops: [shop({ reusedFrom: time, quotes: [quote(11, { freeShipping: false })] }), shop({ shop: '默认包邮店', itemIds: [22], quotes: [quote(22)] })] }));
    f.ok('finish', f.path);
    const rows = f.lines('records.jsonl');
    assert.equal(rows[0].time, time);
    assert.equal(rows[0].price, '100');
    assert.equal(rows[0].freeShipping, false);
    assert.equal(rows[1].freeShipping, true);
    assert.equal(f.lines('processed-tasks.jsonl')[0].result, 'not-submitted');
    const recent = f.json('recent', 'model-a');
    assert.equal(recent[0].freeShipping, false);
    f.write('run.json', run({ shops: [shop({ reusedFrom: recent[0].time, quotes: [quote(11, { price: recent[0].price, freeShipping: recent[0].freeShipping })] })] }));
    assert.equal(f.json('erp-items', f.path).items[0].quotes[0].freeShipping, false);
});

test('finish records unanswered and no-stock shops only for their itemIds', (t) => {
    const f = fixture(t, run({ shops: [shop({ itemIds: [22], status: '未回复', quotes: [] }), shop({ shop: '无货店', status: '无货', quotes: [] })] }));
    f.ok('finish', f.path);
    assert.deepEqual(f.lines('records.jsonl').map((r) => [r.model, r.price]), [['MODEL-B', ''], ['MODEL-A', '无货']]);
});

test('finish retains unquoted items at a shared shop and quote notes for reuse', (t) => {
    const f = fixture(t, run({ shops: [shop({ itemIds: [11, 22], quotes: [quote(11, { freeShipping: false, note: '运费另计20元' })] })] }));
    f.ok('finish', f.path);
    const rows = f.lines('records.jsonl');
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.model === 'MODEL-A').note, '运费另计20元');
    assert.equal(rows.find((r) => r.model === 'MODEL-B').price, '');
    assert.equal(f.json('recent', 'MODEL-B').length, 1);
});

for (const [name, changes] of [
    ['foreign shop itemIds', { shops: [shop({ itemIds: [99], quotes: [] })] }],
    ['quote belonging to another item in the same task', { shops: [shop({ quotes: [quote(22)] })] }],
    ['missing task itemId', { items: [{ model: 'MODEL-A' }], shops: [shop({ itemIds: [undefined], quotes: [{ price: 100 }] })] }],
    ['duplicate task itemId', { items: [{ itemId: 11, model: 'MODEL-A' }, { itemId: 11, model: 'MODEL-B' }], shops: [shop()] }],
]) {
    test(`check and finish reject ${name} without writes`, (t) => {
        const value = run(changes);
        const f = fixture(t, value);
        f.write('run-淘宝.json', part('淘宝', { shops: value.shops }));
        assert.notEqual(f.cli('check', f.dir, '淘宝').status, 0);
        assert.notEqual(f.cli('finish', f.path).status, 0);
        assert.throws(() => f.lines('records.jsonl'), /ENOENT/);
    });
}

for (const [name, contents] of [
    ['missing', undefined], ['malformed JSON', '{'], ['foreign quote itemId', part('淘宝', { shops: [shop({ quotes: [quote(99)] })] })],
    ['foreign noStock itemId', part('淘宝', { noStock: [{ itemId: 99, note: '无货' }] })],
    ['foreign incomplete itemId', part('淘宝', { incompleteItems: [{ itemId: 99, reason: '子代理卡住' }] })],
    ['wrong platform', part('1688')],
]) {
    test(`check rejects ${name} platform file`, (t) => {
        const f = fixture(t);
        if (contents !== undefined) f.write('run-淘宝.json', contents);
        assert.notEqual(f.cli('check', f.dir, '淘宝').status, 0);
    });
}

test('skipped platform still validates supplied shops and noStock', (t) => {
    const f = fixture(t);
    f.write('run-淘宝.json', part('淘宝', { skipped: '卡住', noStock: [{ itemId: 99 }] }));
    assert.notEqual(f.cli('check', f.dir, '淘宝').status, 0);
});

for (const [name, parts] of [
    ['missing platform', { 'run-淘宝.json': part() }],
    ['malformed platform', { 'run-淘宝.json': '{', 'run-1688.json': part('1688') }],
    ['invalid noStock', { 'run-淘宝.json': part('淘宝', { noStock: [{ itemId: 99 }] }), 'run-1688.json': part('1688') }],
    ['misnamed platform', { 'run-other.json': part('淘宝'), 'run-1688.json': part('1688') }],
    ['unexpected platform', { 'run-淘宝.json': part('淘宝'), 'run-1688.json': part('1688'), 'run-闲鱼.json': part('闲鱼', { shops: [shop()] }) }],
    ['unfinished platform', { 'run-淘宝.json': part('淘宝', { stages: {} }), 'run-1688.json': part('1688') }],
]) {
    test(`merge rejects ${name} without changing run.json`, (t) => {
        const f = fixture(t);
        const before = readFileSync(f.path, 'utf8');
        for (const [file, value] of Object.entries(parts)) f.write(file, value);
        assert.notEqual(f.cli('merge', f.dir).status, 0);
        assert.equal(readFileSync(f.path, 'utf8'), before);
    });
}

test('merge preserves shared-shop quotes, replaces a platform and is idempotent', (t) => {
    const f = fixture(t, run({ shops: [shop({ shop: '旧店' })] }));
    f.write('run-淘宝.json', part('淘宝', { shops: [shop({ itemIds: [11, 22], quotes: [quote(11, { freeShipping: false }), quote(22, { price: 200 })] })] }));
    f.write('run-1688.json', part('1688', { skipped: '用户本次不用该平台' }));
    f.ok('check', f.dir, '淘宝');
    f.ok('check', f.dir, '1688');
    f.ok('merge', f.dir);
    const first = readFileSync(f.path, 'utf8');
    f.ok('merge', f.dir);
    assert.equal(readFileSync(f.path, 'utf8'), first);
    const result = f.json('erp-items', f.path);
    assert.deepEqual(result.items.map((i) => [i.itemId, i.quotes[0].unitPrice, i.quotes[0].freeShipping]), [[11, 100, false], [22, 200, true]]);
});

test('partial failed platform does not turn another platform noStock into total noStock', (t) => {
    const f = fixture(t, run({ shops: [shop()], noStock: [{ itemId: 22, platform: '淘宝', note: '淘宝无货' }], skippedPlatforms: [{ platform: '1688', reason: '子代理卡住' }], incompleteItems: [{ itemId: 22, platform: '1688', reason: '子代理卡住' }] }));
    const items = f.json('erp-items', f.path).items;
    assert.deepEqual(items.map((i) => i.itemId), [11]);
    assert.equal(items[0].quotes[0].unitPrice, 100);
});

test('merge replaces incomplete items by platform and ERP retains known prices', (t) => {
    const f = fixture(t);
    f.write('run-淘宝.json', part('淘宝', { shops: [shop()], noStock: [{ itemId: 22, note: '淘宝无货' }] }));
    f.write('run-1688.json', part('1688', { skipped: '记录损坏', incompleteItems: [{ itemId: 11, reason: '记录损坏' }, { itemId: 22, reason: '记录损坏' }] }));
    f.ok('check', f.dir, '1688');
    f.ok('merge', f.dir);
    let value = JSON.parse(readFileSync(f.path, 'utf8'));
    assert.deepEqual(value.incompleteItems.map((i) => i.platform), ['1688', '1688']);
    assert.deepEqual(f.json('erp-items', f.path).items.map((i) => i.itemId), [11]);
    f.write('run-1688.json', part('1688', { skipped: '用户本次不用该平台' }));
    f.ok('merge', f.dir);
    value = JSON.parse(readFileSync(f.path, 'utf8'));
    assert.deepEqual(value.incompleteItems, []);
    assert.equal(f.json('erp-items', f.path).items.find((i) => i.itemId === 22).noStock, true);
});

test('full noStock is emitted and a known quote takes precedence', (t) => {
    const f = fixture(t, run({ shops: [shop()], noStock: [{ itemId: 11, note: '无货' }, { itemId: 22, note: '两平台均无货' }] }));
    const items = f.json('erp-items', f.path).items;
    assert.equal(items[0].noStock, undefined);
    assert.equal(items[1].noStock, true);
});

for (const price of ['100元', '   ', 'NaN', 'Infinity', '1e309', true, [], {}]) {
    test(`check and erp-items reject invalid price ${JSON.stringify(price)}`, (t) => {
        const shops = [shop({ quotes: [quote(11, { price })] })];
        const f = fixture(t, run({ shops }));
        f.write('run-淘宝.json', part('淘宝', { shops }));
        const checked = f.cli('check', f.dir, '淘宝');
        const generated = f.cli('erp-items', f.path);
        assert.deepEqual([checked.status !== 0, generated.status !== 0], [true, true]);
        assert.equal(generated.stdout, '');
    });
}

test('check and erp-items reject JSON numeric overflow', (t) => {
    const shops = [shop()];
    const f = fixture(t);
    f.write('run.json', JSON.stringify(run({ shops })).replace('"price":100', '"price":1e309'));
    f.write('run-淘宝.json', JSON.stringify(part('淘宝', { shops })).replace('"price":100', '"price":1e309'));
    assert.notEqual(f.cli('check', f.dir, '淘宝').status, 0);
    assert.notEqual(f.cli('erp-items', f.path).status, 0);
});

test('prices accept finite numbers and numeric strings including zero, while missing prices stay absent', (t) => {
    const f = fixture(t);
    for (const price of [100, '100.25', 0, '0', ' 10.5 ', null, undefined, '']) {
        const shops = [shop({ quotes: [quote(11, { price })] })];
        f.write('run.json', run({ shops }));
        f.write('run-淘宝.json', part('淘宝', { shops }));
        f.ok('check', f.dir, '淘宝');
        const result = f.json('erp-items', f.path);
        if (price == null || price === '') assert.deepEqual(result.items, []);
        else assert.equal(result.items[0].quotes[0].unitPrice, Number(price));
    }
});

test('erp-items skipItemIds only contains incomplete models without valid quotes', (t) => {
    const f = fixture(t, run({ shops: [shop()], incompleteItems: [{ itemId: 11, reason: '淘宝失败', platform: '淘宝' }, { itemId: 22, reason: '1688失败', platform: '1688' }, { itemId: 22, reason: '淘宝失败', platform: '淘宝' }] }));
    let result = f.json('erp-items', f.path);
    assert.deepEqual(result.skipItemIds, [22]);
    assert.deepEqual(result.items.map((i) => i.itemId), [11]);
    f.write('run.json', run());
    result = f.json('erp-items', f.path);
    assert.deepEqual(result.skipItemIds, []);
});

test('beat/watch running, paused, resume, stalled, finished and completion-check boundary', (t) => {
    const f = fixture(t);
    let out = f.json('watch', f.dir, '--once');
    assert.equal(out.result, 'running');
    assert.equal(out.stallMinutes, 3);
    assert.equal(out.running.length, 2);
    f.ok('beat', f.dir, '淘宝', '--paused', '等待验证码');
    f.write('heartbeat-1688.jsonl', JSON.stringify({ at: ago(5), doing: '挑店', paused: false }) + '\n');
    out = f.json('watch', f.dir, '--once');
    assert.equal(out.result, 'stalled');
    assert.equal(out.stalled[0].platform, '1688');
    assert.equal(out.paused[0].platform, '淘宝');
    f.ok('beat', f.dir, '淘宝', '恢复询价');
    f.ok('beat', f.dir, '1688', '继续询价');
    out = f.json('watch', f.dir, '--once');
    assert.equal(out.running.length, 2);
    f.write('run-淘宝.json', part());
    f.write('run-1688.json', part('1688', { skipped: '用户本次不用该平台' }));
    out = f.json('watch', f.dir, '--once');
    assert.equal(out.result, 'finished');
    assert.equal(out.finished.length, 2);
    // A completion marker is progress only: check must still reject bad data.
    f.write('run-淘宝.json', part('淘宝', { noStock: [{ itemId: 99 }] }));
    assert.equal(f.json('watch', f.dir, '--once').result, 'finished');
    assert.notEqual(f.cli('check', f.dir, '淘宝').status, 0);
});

test('watch does not consider malformed or unfinished part files complete', (t) => {
    const f = fixture(t);
    f.write('run-淘宝.json', '{');
    f.write('run-1688.json', part('1688', { stages: {} }));
    assert.equal(f.json('watch', f.dir, '--once').running.length, 2);
});

test('watch keeps valid heartbeat history when the last append is incomplete', (t) => {
    const f = fixture(t);
    f.write('heartbeat-淘宝.jsonl', JSON.stringify({ at: ago(5), paused: true, doing: '等待登录' }) + '\n{"at":');
    f.write('heartbeat-1688.jsonl', JSON.stringify({ at: ago(5), paused: false, doing: '挑店' }) + '\n{"at":');
    const out = f.json('watch', f.dir, '--once');
    assert.equal(out.paused[0]?.platform, '淘宝');
    assert.equal(out.stalled[0]?.platform, '1688');
});

test('watch in background exits after completed platforms and waits for paused platforms', (t) => {
    const f = fixture(t);
    // Speed up only the interval; run the real CLI loop rather than the --once branch.
    const preload = 'data:text/javascript,globalThis.setInterval%3D((original)%3D%3E(fn%2Cms)%3D%3Eoriginal(fn%2C10))(globalThis.setInterval)';
    const background = (timeout) => spawnSync(process.execPath, ['--import', preload, script, 'watch', f.dir], { encoding: 'utf8', timeout, env: { ...process.env, HOME: f.home, USERPROFILE: f.home } });
    f.ok('beat', f.dir, '淘宝', '--paused', '等登录');
    f.ok('beat', f.dir, '1688', '--paused', '等确认');
    const paused = background(300);
    assert.equal(paused.error?.code, 'ETIMEDOUT');
    assert.equal(paused.stdout, '');
    f.write('run-淘宝.json', part());
    f.write('run-1688.json', part('1688'));
    const completed = background(3000);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(JSON.parse(completed.stdout).result, 'finished');
    f.write('run-淘宝.json', part('淘宝', { stages: {} }));
    f.write('heartbeat-淘宝.jsonl', JSON.stringify({ at: ago(5), paused: false, doing: '挑店' }) + '\n');
    const stalled = background(3000);
    assert.equal(stalled.status, 0, stalled.stderr);
    assert.equal(JSON.parse(stalled.stdout).result, 'stalled');
});
