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
const shop = (extra = {}) => ({ platform: '淘宝', shop: '测试店', itemIds: [11], sentAt: ago(1), status: '已回复', quotes: [quote()], ...extra });
const run = (extra = {}) => ({ task: 'IQ-TEST', taskId: 1, items: [{ itemId: 11, model: 'MODEL-A' }, { itemId: 22, model: 'MODEL-B' }], platforms: ['淘宝', '1688'], platformStates: { '淘宝': 'completed', '1688': 'completed' }, shops: [], noStock: [], submitted: false, ...extra });
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

test('recent and watch read shared personal overrides without changing ERP config or creating runtime folders', (t) => {
    const f = fixture(t);
    const dataDir = join(f.home, '.zhul-trade-sourcing');
    mkdirSync(dataDir);
    const personalPath = join(dataDir, 'settings.json');
    writeFileSync(personalPath, JSON.stringify({ dedupeDays: 0, subagents: { stallMinutes: 10 } }));
    const erpPath = join(dataDir, 'config.json');
    writeFileSync(erpPath, '{"erpUrl":"https://example.invalid"}\n');
    writeFileSync(join(dataDir, 'records.jsonl'), JSON.stringify({ model: 'MODEL-A', time: ago(60), shop: '旧店' }) + '\n');
    assert.deepEqual(f.json('recent', 'MODEL-A'), []);
    assert.equal(f.json('recent', 'MODEL-A', '1').length, 1);
    f.write('heartbeat-淘宝.jsonl', JSON.stringify({ at: ago(5), paused: false, doing: '挑店' }) + '\n');
    f.write('heartbeat-1688.jsonl', JSON.stringify({ at: ago(5), paused: false, doing: '挑店' }) + '\n');
    const out = f.json('watch', f.dir, '--once');
    assert.equal(out.stallMinutes, 10);
    assert.equal(out.result, 'running');
    assert.equal(out.running.length, 2);
    assert.equal(readFileSync(erpPath, 'utf8'), '{"erpUrl":"https://example.invalid"}\n');
    assert.deepEqual(JSON.parse(readFileSync(personalPath, 'utf8')), { dedupeDays: 0, subagents: { stallMinutes: 10 } });
    for (const name of ['runs', 'learnings', 'reports']) assert.equal(existsSync(join(dataDir, name)), false);
    writeFileSync(personalPath, '{"dedupeDays":-1}');
    const result = f.cli('recent', 'MODEL-A');
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(personalPath));
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

test('same-round manual candidates exclude A, while a new round resumes A and preserves stop flags', (t) => {
    const f = fixture(t);
    const a = f.json('open-run', 'IQ-A').runDir;
    writeFileSync(join(a, 'run.json'), JSON.stringify(run({ task: 'IQ-A' })));
    f.ok('manual', 'IQ-A', '业务内容需人工核对');
    f.ok('finish', join(a, 'run.json'));
    const pending = ['IQ-A', 'IQ-B'];
    const closedManual = new Set(['IQ-A']);
    assert.equal(f.json('next', ...pending.filter((task) => !closedManual.has(task))).next, 'IQ-B');
    const nextRound = f.json('next', ...pending);
    assert.equal(nextRound.next, 'IQ-A');
    assert.equal(nextRound.resumeRun, a);
    assert.equal(nextRound.stopAfterTask, false);
    writeFileSync(join(a, 'run.json'), JSON.stringify(run({ task: 'IQ-A', stopAfterTask: true })));
    assert.equal(f.json('next', ...pending).stopAfterTask, true);
    assert.equal(f.json('open-run', 'IQ-A').stopAfterTask, true);
    assert.notEqual(f.cli('erp-items', join(a, 'run.json')).status, 0);
    assert.equal(f.lines('processed-tasks.jsonl').some((r) => r.result === 'skipped'), false);
});

test('installed ecommerce helpers retain caller-owned page signatures and matching metadata', (t) => {
    const f = fixture(t);
    const helpersDir = join(f.root, 'isolated-helpers');
    mkdirSync(helpersDir);
    const install = spawnSync(process.execPath, [script, 'install-helpers'], {
        env: { ...process.env, HOME: f.home, USERPROFILE: f.home, BROWSEROS_HELPERS_DIR: helpersDir }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(install.status, 0, install.stderr);
    const result = JSON.parse(install.stdout);
    assert.equal(result.installed.length, 6);
    assert.deepEqual(result.kept, []);
    const skillDir = resolve(script, '../..');
    for (const helper of result.installed) {
        const installed = readFileSync(join(helpersDir, `${helper}.md`), 'utf8');
        assert.equal(installed, readFileSync(join(skillDir, 'helpers', `${helper}.md`), 'utf8'));
        assert.match(installed, /^opensPage: false$/m);
        assert.match(installed, /async \(browser, pageId, \w+\) =>/);
        assert.match(installed, /const page = browser\.page\(pageId\)/);
    }
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

test('interrupted snapshot preserves finished shops, draft quotes and other running platforms', (t) => {
    const sentAt = ago(20);
    const finishedAt = ago(10);
    const f = fixture(t, run({ platformStates: {} }));
    const shops = [shop({ sentAt, endedAt: finishedAt, endReason: '已确认报价', followUps: 1, followUpAt: ago(15), answeredTopics: ['用途'], thankYou: { sentAt: finishedAt } }), shop({ shop: '尚未回复店', status: '未回复', quotes: [], itemIds: [22], sentAt })];
    const interrupted = part('淘宝', { status: 'interrupted', stages: { inquiryDone: ago(19) }, interruption: { reason: '登录失效' }, shops });
    f.write('run-淘宝.json', interrupted);
    f.write('run-1688.json', part('1688', { status: 'running', stages: {} }));
    f.ok('check', f.dir, '淘宝', '--partial');
    assert.notEqual(f.cli('check', f.dir, '淘宝').status, 0);
    f.ok('merge', f.dir, '--partial', '淘宝');
    const first = JSON.parse(readFileSync(f.path, 'utf8'));
    assert.equal(first.stopAfterTask, true);
    assert.equal(first.platformStates['淘宝'], 'interrupted');
    assert.deepEqual(first.shops, shops);
    assert.equal(f.json('watch', f.dir, '--once').result, 'running');
    f.write('run-1688.json', part('1688', { status: 'completed', shops: [shop({ platform: '1688', shop: '1688报价店', itemIds: [22], quotes: [quote(22, { price: 200 })] })] }));
    f.ok('merge', f.dir, '--partial', '1688');
    const draft = f.json('erp-items', f.path, '--draft');
    assert.deepEqual(draft.items.map((i) => [i.itemId, i.quotes[0].unitPrice]), [[11, 100], [22, 200]]);
    assert.notEqual(f.cli('erp-items', f.path).status, 0);
    const before = readFileSync(f.path, 'utf8');
    assert.notEqual(f.cli('merge', f.dir).status, 0);
    assert.equal(readFileSync(f.path, 'utf8'), before);
    const watched = f.json('watch', f.dir, '--once');
    assert.equal(watched.result, 'interrupted');
    assert.equal(watched.finished.length, 1);
    assert.equal(watched.interrupted.length, 1);
    assert.equal(watched.stopAfterTask, true);
    f.ok('finish', f.path);
    assert.equal(f.lines('records.jsonl').find((r) => r.shop === '测试店').followUps, 1);
});

test('partial merge selects only named persisted files and does not infer noStock', (t) => {
    const f = fixture(t, run({ platformStates: {} }));
    f.write('run-淘宝.json', part('淘宝', { status: 'running', stages: {}, shops: [shop()], noStock: [{ itemId: 22, note: '当前询到无货' }] }));
    f.write('run-1688.json', '{broken-other-platform');
    assert.notEqual(f.cli('merge', f.dir, '--partial').status, 0);
    f.ok('merge', f.dir, '--partial', '淘宝');
    const draft = f.json('erp-items', f.path, '--draft');
    assert.deepEqual(draft.items.map((i) => i.itemId), [11]);
    assert.deepEqual(draft.skipItemIds, [22]);
    assert.notEqual(f.cli('erp-items', f.path).status, 0);
});

test('platform interruption cannot fake completion but keeps ended shops intact', (t) => {
    const f = fixture(t);
    for (const extra of [{ stages: { repliesDone: now() } }, { endedAt: now(), stages: {} }, { stages: {}, interruption: {} }]) {
        f.write('run-淘宝.json', part('淘宝', { status: 'interrupted', interruption: { reason: '验证码' }, ...extra }));
        assert.notEqual(f.cli('check', f.dir, '淘宝', '--partial').status, 0);
    }
    f.write('run-淘宝.json', part('淘宝', { status: 'interrupted', stages: {}, interruption: { reason: '验证码' }, shops: [shop({ endedAt: now() })] }));
    f.ok('check', f.dir, '淘宝', '--partial');
});

test('pending sends survive checkpoints and require confirmation before completion', (t) => {
    const f = fixture(t, run({ platformStates: {} }));
    const pendingMessage = { kind: 'initial', text: '请报价', preparedAt: ago(1), state: 'pending' };
    f.write('run-淘宝.json', part('淘宝', { status: 'running', stages: {}, shops: [shop({ sentAt: undefined, status: '未回复', quotes: [], pendingMessage })] }));
    f.ok('check', f.dir, '淘宝', '--partial');
    f.ok('merge', f.dir, '--partial', '淘宝');
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')).shops[0].pendingMessage, pendingMessage);
    assert.notEqual(f.cli('erp-items', f.path).status, 0);
    f.write('run-淘宝.json', part('淘宝', { status: 'completed', shops: [shop({ pendingMessage })] }));
    assert.notEqual(f.cli('check', f.dir, '淘宝').status, 0);
    for (const changes of [{ kind: 'initial', sentAt: undefined }, { kind: 'followUp', followUps: 0, followUpAt: undefined }]) {
        const { kind, ...fields } = changes;
        f.write('run-淘宝.json', part('淘宝', { shops: [shop({ ...fields, pendingMessage: { ...pendingMessage, kind, state: 'confirmed', confirmedAt: now() } })] }));
        assert.notEqual(f.cli('check', f.dir, '淘宝').status, 0);
    }
    f.write('run-淘宝.json', part('淘宝', { shops: [shop({ followUps: 1, followUpAt: now(), pendingMessage: { ...pendingMessage, kind: 'followUp', state: 'confirmed', confirmedAt: now() } })] }));
    f.ok('check', f.dir, '淘宝');
    f.write('run-淘宝.json', part('淘宝', { shops: [shop({ pendingMessage: { ...pendingMessage, kind: 'correction', state: 'confirmed', confirmedAt: now() } })] }));
    f.ok('check', f.dir, '淘宝');
});

test('confirmed replies require sending evidence and retain replyAt after later intents and resume', (t) => {
    const f = fixture(t);
    const dir = f.json('open-run', 'IQ-REPLY').runDir;
    const value = run({ task: 'IQ-REPLY', platforms: ['淘宝'], platformStates: {}, deadline: ago(-60) });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(value));
    const replyAt = ago(15);
    const followUpAt = ago(20);
    const confirmedAt = ago(1);
    const record = shop({ sentAt: ago(30), followUps: 1, followUpAt, answeredTopics: ['数量'],
        pendingMessage: { kind: 'reply', text: '需要1台', preparedAt: ago(16), state: 'confirmed', confirmedAt } });
    const path = join(dir, 'run-淘宝.json');
    writeFileSync(path, JSON.stringify(part('淘宝', { status: 'interrupted', stages: {}, interruption: { reason: '会话断开' }, shops: [record] })));
    const before = readFileSync(path, 'utf8');
    assert.notEqual(f.cli('check', dir, '淘宝', '--partial').status, 0);
    const blocked = f.cli('open-run', 'IQ-REPLY');
    assert.notEqual(blocked.status, 0);
    assert.ok(blocked.stderr.includes(path));
    assert.match(blocked.stderr, /replyAt/);
    assert.equal(readFileSync(path, 'utf8'), before);
    record.replyAt = replyAt; // 原聊天证据中的发送时刻，不是本次核验时刻。
    for (const invalid of ['bad-time', 123]) {
        writeFileSync(path, JSON.stringify(part('淘宝', { shops: [{ ...record, replyAt: invalid }] })));
        assert.notEqual(f.cli('check', dir, '淘宝', '--partial').status, 0);
    }
    writeFileSync(path, JSON.stringify(part('淘宝', { shops: [{ ...record, answeredTopics: [] }] })));
    assert.notEqual(f.cli('check', dir, '淘宝').status, 0);
    writeFileSync(path, JSON.stringify(part('淘宝', { shops: [record] })));
    f.ok('check', dir, '淘宝');
    assert.equal(f.json('open-run', 'IQ-REPLY').runDir, dir);
    for (const kind of ['correction', 'thankYou']) {
        record.pendingMessage = { kind, text: kind === 'correction' ? '不好意思发错了' : '谢谢', preparedAt: ago(1), state: 'confirmed', confirmedAt: now() };
        writeFileSync(path, JSON.stringify(part('淘宝', { shops: [record] })));
        f.ok('merge', dir);
        const checkpoint = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
        assert.equal(checkpoint.shops[0].replyAt, replyAt);
        assert.equal(checkpoint.shops[0].followUps, 1);
        assert.equal(checkpoint.shops[0].followUpAt, followUpAt);
        const stored = readFileSync(join(dir, 'run.json'), 'utf8');
        f.json('open-run', 'IQ-REPLY');
        assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), stored);
    }
    f.ok('finish', join(dir, 'run.json'));
    assert.equal(f.lines('records.jsonl')[0].replyAt, replyAt);
    assert.equal(f.lines('records.jsonl')[0].followUps, 1);
});

test('finish archives a snapshot once, excludes unsent candidates and allows later revisions', (t) => {
    const f = fixture(t, run({ shops: [shop({ sentAt: undefined, shop: '仅候选', status: '未回复', quotes: [] }), shop({ sentAt: undefined, shop: '公开挂牌店', status: '挂牌价' }), shop()] }));
    f.ok('finish', f.path);
    const before = readFileSync(join(f.home, '.zhul-trade-sourcing', 'records.jsonl'), 'utf8');
    f.ok('finish', f.path);
    assert.equal(readFileSync(join(f.home, '.zhul-trade-sourcing', 'records.jsonl'), 'utf8'), before);
    assert.equal(f.lines('processed-tasks.jsonl').length, 1);
    assert.deepEqual(f.lines('records.jsonl').map((r) => r.shop), ['公开挂牌店', '测试店']);
    const value = JSON.parse(readFileSync(f.path, 'utf8'));
    value.shops[2].quotes[0].price = 105;
    f.write('run.json', value);
    f.ok('finish', f.path);
    assert.equal(f.lines('processed-tasks.jsonl').length, 2);
    value.submitted = true;
    f.write('run.json', value);
    f.ok('finish', f.path);
    f.ok('finish', f.path);
    assert.equal(f.lines('processed-tasks.jsonl').length, 3);
    assert.equal(f.json('processed', 'IQ-TEST').processed, true);
});

test('new-run resumes the same directory and open-run keeps deadline, messages and completed platforms', (t) => {
    const f = fixture(t);
    const dir = f.ok('new-run', 'IQ-RESUME').trim();
    const initial = f.json('open-run', 'IQ-RESUME');
    assert.equal(initial.runDir, dir);
    assert.equal(initial.resumed, true);
    const pendingMessage = { kind: 'thankYou', text: '谢谢', preparedAt: ago(1), state: 'pending' };
    const value = run({ task: 'IQ-RESUME', deadline: ago(-10), platformStates: {}, shops: [] });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(value));
    const taobao = part('淘宝', { status: 'completed', shops: [shop()] });
    writeFileSync(join(dir, 'run-淘宝.json'), JSON.stringify(taobao));
    writeFileSync(join(dir, 'run-1688.json'), JSON.stringify(part('1688', { status: 'interrupted', stages: {}, interruption: { reason: '登录失败' }, shops: [shop({ platform: '1688', pendingMessage })] })));
    const before = readFileSync(join(dir, 'run.json'), 'utf8');
    const result = f.json('open-run', 'IQ-RESUME');
    assert.equal(result.runDir, dir);
    assert.equal(result.resumed, true);
    assert.equal(result.needsErpReconcile, true);
    assert.equal(result.stopAfterTask, true);
    assert.deepEqual(result.completedPlatforms, ['淘宝']);
    assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'run-淘宝.json'), 'utf8')), taobao);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'run-1688.json'), 'utf8')).shops[0].pendingMessage, pendingMessage);
    f.ok('manual', 'IQ-RESUME', '登录失败');
    assert.equal(f.json('next', 'IQ-RESUME', 'IQ-OTHER').resumeRun, dir);
    assert.equal(f.json('next', 'IQ-EARLIER', 'IQ-RESUME').next, 'IQ-EARLIER');
});

test('new runs use unique names for different IQs and repeated fresh runs in the same second', (t) => {
    const f = fixture(t);
    const one = f.json('open-run', 'IQ-A');
    assert.equal(one.resumed, false);
    assert.equal(f.ok('new-run', 'IQ-A').trim(), one.runDir);
    const two = f.ok('new-run', 'IQ-B').trim();
    assert.notEqual(one.runDir, two);
    writeFileSync(join(one.runDir, 'run.json'), JSON.stringify(run({ task: 'IQ-A', simulation: true })));
    const fresh = f.json('open-run', 'IQ-A');
    assert.equal(fresh.resumed, false);
    assert.notEqual(fresh.runDir, one.runDir);
});

test('resume fails closed for ambiguous, corrupt or uninitialized missing records', (t) => {
    const f = fixture(t);
    const first = f.ok('new-run', 'IQ-AMBIGUOUS').trim();
    const second = join(dirname(first), 'IQ-AMBIGUOUS-second');
    mkdirSync(second);
    copyFileSync(join(first, 'run.json'), join(second, 'run.json'));
    assert.notEqual(f.cli('open-run', 'IQ-AMBIGUOUS').status, 0);
    assert.notEqual(f.cli('next', 'IQ-AMBIGUOUS').status, 0);
    writeFileSync(join(second, 'run.json'), '{');
    assert.notEqual(f.cli('new-run', 'IQ-AMBIGUOUS').status, 0);
    rmSync(join(second, 'run.json'));
    assert.notEqual(f.cli('new-run', 'IQ-AMBIGUOUS').status, 0);
});

test('submitted and simulated runs never become new inquiry or business archives', (t) => {
    const f = fixture(t);
    const dir = f.ok('new-run', 'IQ-SUBMITTED').trim();
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run({ task: 'IQ-SUBMITTED', submitted: true })));
    assert.notEqual(f.cli('open-run', 'IQ-SUBMITTED').status, 0);
    assert.notEqual(f.cli('new-run', 'IQ-SUBMITTED').status, 0);
    assert.equal(f.json('next', 'IQ-SUBMITTED', 'IQ-NEW').next, 'IQ-NEW');
    for (const fields of [{ simulation: true }, { simulated: true }, { dryRun: true }, { mode: 'simulation' }]) {
        f.write('run.json', run({ shops: [shop()], ...fields }));
        assert.notEqual(f.cli('finish', f.path).status, 0);
        assert.notEqual(f.cli('erp-items', f.path).status, 0);
    }
    assert.equal(existsSync(join(f.home, '.zhul-trade-sourcing', 'records.jsonl')), false);
});

for (const state of ['pending', 'unknown', 'failed', 'confirmed']) {
    test(`every recorded ${state} submission attempt prevents automatic second payload`, (t) => {
        const f = fixture(t, run({ shops: [shop()], submissionAttempt: { state, at: now() }, submissionPayload: { taskId: 1, items: [] } }));
        assert.notEqual(f.cli('erp-items', f.path).status, 0);
        assert.notEqual(f.cli('erp-items', f.path, '--draft').status, 0);
        assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')).submissionPayload, { taskId: 1, items: [] });
    });
}

test('completed normal deadline may skip incomplete items while interrupted platform blocks final payload', (t) => {
    const f = fixture(t, run({ shops: [shop()], incompleteItems: [{ itemId: 22, platform: '1688', reason: '正常截止仍未报价' }] }));
    const result = f.json('erp-items', f.path);
    assert.deepEqual(result.skipItemIds, [22]);
    assert.deepEqual(result.items.map((i) => i.itemId), [11]);
    const value = JSON.parse(readFileSync(f.path, 'utf8'));
    value.platformStates['1688'] = 'interrupted';
    f.write('run.json', value);
    assert.notEqual(f.cli('erp-items', f.path).status, 0);
    value.platformStates = { '淘宝': 'completed' };
    f.write('run.json', value);
    assert.notEqual(f.cli('erp-items', f.path).status, 0);
    value.platformStates['1688'] = 'running';
    f.write('run.json', value);
    assert.notEqual(f.cli('erp-items', f.path).status, 0);
});

test('merge cannot automatically clear a stop flag on later completed snapshots', (t) => {
    const f = fixture(t, run({ stopAfterTask: true }));
    f.write('run-淘宝.json', part());
    f.write('run-1688.json', part('1688'));
    f.ok('merge', f.dir);
    assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).stopAfterTask, true);
    assert.notEqual(f.cli('erp-items', f.path).status, 0);
});

test('checkpoint and resume commands preserve existing config, settings and unrelated business records', (t) => {
    const f = fixture(t);
    const data = join(f.home, '.zhul-trade-sourcing');
    mkdirSync(data);
    const contents = { 'config.json': '{"erpUrl":"https://existing.invalid/custom"}\n', 'settings.json': '{"dedupeDays":14}\n', 'records.jsonl': '{"task":"OTHER","model":"OLD","time":"2020-01-01T00:00:00Z"}\n', 'processed-tasks.jsonl': '{"task":"OTHER","result":"manual"}\n' };
    for (const [name, value] of Object.entries(contents)) writeFileSync(join(data, name), value);
    const created = f.json('open-run', 'IQ-SAFE');
    f.json('open-run', 'IQ-SAFE');
    f.json('next', 'IQ-SAFE');
    assert.equal(created.resumed, false);
    for (const [name, value] of Object.entries(contents)) assert.equal(readFileSync(join(data, name), 'utf8'), value);
});

test('recent uses the latest archived correction without reviving old prices or extending reused windows', (t) => {
    const f = fixture(t, run({ shops: [shop({ status: '未回复', quotes: [] })] }));
    f.ok('finish', f.path);
    assert.equal(f.json('recent', 'model-a')[0].price, '');
    const value = JSON.parse(readFileSync(f.path, 'utf8'));
    value.shops[0].status = '已回复';
    value.shops[0].quotes = [quote(11, { price: 120 })];
    f.write('run.json', value);
    f.ok('finish', f.path);
    assert.deepEqual(f.json('recent', 'MODEL-A').map((r) => r.price), ['120']);
    value.shops[0].quotes[0].price = 125;
    f.write('run.json', value);
    f.ok('finish', f.path);
    assert.deepEqual(f.json('recent', 'MODEL-A').map((r) => r.price), ['125']);
    value.shops[0].quotes = [];
    value.shops[0].status = '无货';
    f.write('run.json', value);
    f.ok('finish', f.path);
    assert.deepEqual(f.json('recent', 'MODEL-A').map((r) => r.price), ['无货']);
    value.shops[0].status = '未回复';
    value.shops[0].endReason = '前价作废待确认';
    f.write('run.json', value);
    f.ok('finish', f.path);
    assert.deepEqual(f.json('recent', 'MODEL-A').map((r) => r.price), ['']);
    value.shops[0].status = '已回复';
    value.shops[0].quotes = [quote(11, { price: 130 })];
    value.shops[0].reusedFrom = ago(60 * 24 * 10);
    f.write('run.json', value);
    f.ok('finish', f.path);
    assert.deepEqual(f.json('recent', 'MODEL-A', '1'), []);
    const historical = f.json('recent', 'MODEL-A', '30');
    assert.equal(historical.length, 1);
    assert.equal(historical[0].time, value.shops[0].reusedFrom);
    assert.equal(historical[0].price, '130');
});

test('failed atomic replacement keeps the previous checkpoint intact', (t) => {
    const f = fixture(t);
    f.write('run-淘宝.json', part('淘宝', { shops: [shop()] }));
    f.write('run-1688.json', part('1688'));
    const before = readFileSync(f.path, 'utf8');
    const injection = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; fs.renameSync = () => { throw new Error('test rename failure'); }; syncBuiltinESMExports();`;
    const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(injection), script, 'merge', f.dir], { encoding: 'utf8', timeout: 5000, env: { ...process.env, HOME: f.home, USERPROFILE: f.home } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /test rename failure/);
    assert.equal(readFileSync(f.path, 'utf8'), before);
});

test('explicit no-write confirmation can retry and rearming the intent prevents duplicate payloads', (t) => {
    const attempt = { state: 'not_sent', at: now(), writeAttempted: false };
    const value = run({ shops: [shop()], submissionAttempt: attempt });
    const f = fixture(t, value);
    assert.equal(f.json('erp-items', f.path).items[0].quotes[0].unitPrice, 100);
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')).submissionAttempt, attempt);
    value.submissionAttempt = { state: 'pending', at: now() };
    f.write('run.json', value);
    assert.notEqual(f.cli('erp-items', f.path).status, 0);
    value.submissionAttempt = { state: 'not_sent', at: now() };
    f.write('run.json', value);
    assert.notEqual(f.cli('erp-items', f.path).status, 0);
    value.submissionAttempt.writeAttempted = true;
    f.write('run.json', value);
    assert.notEqual(f.cli('erp-items', f.path).status, 0);
});

test('human help must be verified before platform completion or final ERP payload', (t) => {
    const f = fixture(t);
    const blocked = [
        { status: 'waiting' }, { status: 'pending' }, { status: 'unknown' },
        { status: 'cancelled', verified: true, verifiedAt: now() }, { status: 'timed_out' },
        { status: 'resolved' }, { status: 'resolved', verified: false, verifiedAt: now() },
        { status: 'resolved', verified: true }, { status: 'resolved', verified: true, verifiedAt: 'bad-time' },
    ];
    for (const humanHelp of blocked) {
        f.write('run-淘宝.json', part('淘宝', { shops: [shop()], humanHelp }));
        f.write('run-1688.json', part('1688'));
        assert.notEqual(f.cli('check', f.dir, '淘宝').status, 0);
        assert.notEqual(f.cli('merge', f.dir).status, 0);
        f.write('run.json', run({ shops: [shop()], humanHelp }));
        assert.notEqual(f.cli('erp-items', f.path).status, 0);
        assert.equal(f.json('erp-items', f.path, '--draft').items[0].quotes[0].unitPrice, 100);
    }
    const verified = { status: 'resolved', nativeStatus: null, requestId: null, resolutionSource: 'recovery-check', verified: true, verifiedAt: now() };
    f.write('run.json', run());
    f.write('run-淘宝.json', part('淘宝', { shops: [shop()], humanHelp: verified, humanHelpHistory: [{ status: 'cancelled', nativeStatus: null }] }));
    f.ok('check', f.dir, '淘宝');
    f.ok('merge', f.dir);
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')).platformHumanHelp['淘宝'], verified);
    assert.equal(f.json('erp-items', f.path).items[0].quotes[0].unitPrice, 100);
});

test('partial merge preserves pending human help while allowing local draft and later session recovery', (t) => {
    const f = fixture(t);
    const opened = f.json('open-run', 'IQ-SESSION');
    const dir = opened.runDir;
    const deadline = ago(-5);
    const humanHelp = { owner: 'taobao-owner', requestId: 'request-1', status: 'waiting', createdAt: ago(1), failedChecks: 0, tabId: 23, url: 'https://example.invalid/chat' };
    const pendingMessage = { kind: 'followUp', text: '请问货期？', preparedAt: ago(1), state: 'pending' };
    const value = run({ task: 'IQ-SESSION', deadline, submissionAttempt: { state: 'unknown', at: now() }, submissionPayload: { taskId: 1, items: [{ itemId: 11, quotes: [] }] } });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(value));
    writeFileSync(join(dir, 'run-淘宝.json'), JSON.stringify(part('淘宝', { status: 'interrupted', stages: {}, humanHelp, interruption: { reason: 'BrowserOS session失效' }, shops: [shop({ pendingMessage })] })));
    writeFileSync(join(dir, 'run-1688.json'), JSON.stringify(part('1688')));
    f.ok('merge', dir, '--partial', '淘宝');
    const before = readFileSync(join(dir, 'run.json'), 'utf8');
    const resumed = f.json('open-run', 'IQ-SESSION');
    assert.equal(resumed.runDir, dir);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.stopAfterTask, true);
    assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
    const current = JSON.parse(before);
    assert.deepEqual(current.platformHumanHelp['淘宝'], humanHelp);
    assert.deepEqual(current.shops[0].pendingMessage, pendingMessage);
    assert.equal(current.deadline, deadline);
    assert.deepEqual(current.submissionPayload, value.submissionPayload);
    assert.notEqual(f.cli('erp-items', join(dir, 'run.json'), '--draft').status, 0);
    delete current.submissionAttempt;
    writeFileSync(join(dir, 'run.json'), JSON.stringify(current));
    assert.equal(f.json('erp-items', join(dir, 'run.json'), '--draft').items[0].itemId, 11);
    current.stopAfterTask = false;
    current.platformStates = { '淘宝': 'completed', '1688': 'completed' };
    current.shops[0].pendingMessage.state = 'cancelled';
    writeFileSync(join(dir, 'run.json'), JSON.stringify(current));
    assert.notEqual(f.cli('erp-items', join(dir, 'run.json')).status, 0);
});

test('watch waits for the other platform after one interruption and then reports interruption', (t) => {
    const f = fixture(t);
    f.write('run-淘宝.json', part('淘宝', { status: 'interrupted', stages: {}, interruption: { reason: '等待人工恢复' } }));
    f.write('run-1688.json', part('1688', { status: 'running', stages: {} }));
    const preload = 'data:text/javascript,globalThis.setInterval%3D((original)%3D%3E(fn%2Cms)%3D%3Eoriginal(fn%2C10))(globalThis.setInterval)';
    const background = (timeout) => spawnSync(process.execPath, ['--import', preload, script, 'watch', f.dir], { encoding: 'utf8', timeout, env: { ...process.env, HOME: f.home, USERPROFILE: f.home } });
    const running = background(300);
    assert.equal(running.error?.code, 'ETIMEDOUT');
    assert.equal(running.stdout, '');
    f.write('run-1688.json', part('1688', { status: 'completed' }));
    const ended = background(3000);
    assert.equal(ended.status, 0, ended.stderr);
    assert.equal(JSON.parse(ended.stdout).result, 'interrupted');
    assert.equal(JSON.parse(ended.stdout).stopAfterTask, true);
});

test('resume refuses corrupt platform records without replacing the run', (t) => {
    const f = fixture(t);
    const dir = f.ok('new-run', 'IQ-BAD-PART').trim();
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run({ task: 'IQ-BAD-PART' })));
    writeFileSync(join(dir, 'run-淘宝.json'), '{');
    const before = readFileSync(join(dir, 'run.json'), 'utf8');
    assert.notEqual(f.cli('open-run', 'IQ-BAD-PART').status, 0);
    assert.notEqual(f.cli('next', 'IQ-BAD-PART').status, 0);
    assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
});
