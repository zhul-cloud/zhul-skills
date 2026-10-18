import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const testDir = dirname(fileURLToPath(import.meta.url));
function cleanup(path, root) {
    const separator = process.platform === 'win32' ? '\\' : '/';
    assert.equal(dirname(resolve(root)), resolve(testDir));
    assert.ok(resolve(root).startsWith(join(resolve(testDir), '.lifecycle-test-')));
    assert.ok(resolve(path) === resolve(root) || resolve(path).startsWith(resolve(root) + separator));
    assert.equal(lstatSync(root).isSymbolicLink(), false);
    rmSync(path, { recursive: true, force: true });
}
function fixture(t) {
    const root = mkdtempSync(join(testDir, '.lifecycle-test-'));
    const home = join(root, 'home'), skill = join(root, 'skill');
    mkdirSync(home); mkdirSync(skill);
    cpSync(join(source, 'scripts'), join(skill, 'scripts'), { recursive: true });
    for (const name of ['SKILL.md', 'settings.json']) copyFileSync(join(source, name), join(skill, name));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { env, encoding: 'utf8' });
    assert.equal(resolve(probe.stdout), resolve(home));
    const data = join(home, '.zhul-trade-sourcing'), marker = join(data, '.skill-version.json');
    const lock = join(home, '.zhul-trade-sourcing.lifecycle.lock');
    const run = (tool, args, extra = []) => spawnSync(process.execPath, [...extra, join(skill, 'scripts', tool + '.mjs'), ...args], { env, encoding: 'utf8', timeout: 15000 });
    const records = (...args) => run('records', args);
    const ok = (...args) => { const p = records(...args); assert.equal(p.status, 0, p.stderr || p.error?.message); return JSON.parse(p.stdout); };
    const seed = (version, names = ['settings.json', 'config.json', 'records.jsonl', 'processed-tasks.jsonl', 'contacts.json', 'runs/run.json', 'learnings/platform.md', 'reports/report.md']) => {
        mkdirSync(data, { recursive: true });
        for (const name of names) { const p = join(data, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, 'old:' + name); }
        if (version !== null) writeFileSync(marker, JSON.stringify({ schemaVersion: 1, skillVersion: version }));
    };
    const version = readFileSync(join(skill, 'SKILL.md'), 'utf8').match(/^version: (.+)$/m)[1].trim();
    t.after(() => cleanup(root, root));
    return { root, home, skill, data, marker, lock, env, run, records, ok, seed, version };
}

test('first initialization creates the current marker last; same version preserves every personal area', (t) => {
    const f = fixture(t);
    const first = f.ok('init', '--erp', 'erp.example.invalid');
    assert.equal(first.dataRebuilt, true); assert.equal(first.skillVersion, f.version);
    assert.deepEqual(JSON.parse(readFileSync(f.marker)), { schemaVersion: 1, skillVersion: f.version });
    f.seed(f.version); const before = readFileSync(f.marker, 'utf8');
    // Same-version init must not read or discard malformed personal settings.
    writeFileSync(join(f.data, 'config.json'), '{"erpUrl":"https://erp.example.invalid"}');
    assert.equal(f.ok('init').dataRebuilt, false);
    assert.equal(readFileSync(f.marker, 'utf8'), before);
    for (const file of ['settings.json', 'records.jsonl', 'processed-tasks.jsonl', 'contacts.json', 'runs/run.json', 'learnings/platform.md', 'reports/report.md']) assert.equal(readFileSync(join(f.data, file), 'utf8'), 'old:' + file);
    assert.equal(existsSync(f.lock), false);
});

for (const prior of [null, '0.1.0']) test(`legacy/unmarked and older version rebuild without parsing bad old config (${prior})`, (t) => {
    const f = fixture(t); f.seed(prior);
    const result = f.ok('init');
    assert.equal(result.erpUrl, null); assert.equal(result.dataRebuilt, true);
    assert.deepEqual(readdirSync(f.data).sort(), ['.skill-version.json', 'learnings', 'reports', 'runs']);
    assert.equal(existsSync(f.lock), false);
});

test('empty existing directory initializes without requiring legacy configuration', (t) => {
    const f = fixture(t); mkdirSync(f.data);
    assert.equal(f.ok('init').skillVersion, f.version);
});

test('newer stored version blocks older copies without flip-flop deletion', (t) => {
    const f = fixture(t); f.seed('999.0.0'); const before = readFileSync(f.marker);
    for (const args of [['init'], ['manual', 'IQ-TEST', 'test']]) {
        const result = f.records(...args); assert.notEqual(result.status, 0); assert.match(result.stderr, /DATA_NEWER_VERSION/);
        assert.deepEqual(readFileSync(f.marker), before); assert.equal(readFileSync(join(f.data, 'settings.json'), 'utf8'), 'old:settings.json');
    }
});

for (const value of ['{bad', '{}', '{"schemaVersion":2,"skillVersion":"0.1.0"}', '{"schemaVersion":1,"skillVersion":"0.1.0","extra":true}']) test(`corrupt/unknown marker is preserved (${value})`, (t) => {
    const f = fixture(t); f.seed(null); writeFileSync(f.marker, value);
    const result = f.records('init'); assert.notEqual(result.status, 0); assert.match(result.stderr, /DATA_VERSION/);
    assert.equal(readFileSync(f.marker, 'utf8'), value); assert.equal(readFileSync(join(f.data, 'config.json'), 'utf8'), 'old:config.json');
});

for (const bad of ['defaults', 'missing-default', 'typed-default', 'version', 'erp']) test(`invalid ${bad} fails before legacy deletion`, (t) => {
    const f = fixture(t); f.seed('0.1.0'); const before = readFileSync(f.marker);
    if (bad === 'defaults') writeFileSync(join(f.skill, 'settings.json'), '{bad');
    if (bad === 'missing-default' || bad === 'typed-default') {
        const defaults = JSON.parse(readFileSync(join(f.skill, 'settings.json')));
        if (bad === 'missing-default') delete defaults.dedupeDays;
        else defaults.dedupeDays = '7';
        writeFileSync(join(f.skill, 'settings.json'), JSON.stringify(defaults));
    }
    if (bad === 'version') writeFileSync(join(f.skill, 'SKILL.md'), '---\nname: test\nversion: latest\n---\n');
    const result = bad === 'erp' ? f.records('init', '--erp', 'https://user:secret@erp.invalid') : f.records('init');
    assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); assert.ok(!result.stderr.includes('secret'));
    assert.deepEqual(readFileSync(f.marker), before); assert.equal(readFileSync(join(f.data, 'settings.json'), 'utf8'), 'old:settings.json');
});

test('numeric version upgrade clears personal overrides and inherits complete new defaults', (t) => {
    const f = fixture(t);
    const skillFile = join(f.skill, 'SKILL.md');
    writeFileSync(skillFile, readFileSync(skillFile, 'utf8').replace(/^version: .+$/m, 'version: 2.9.0'));
    f.ok('init');
    const patch = join(f.root, 'patch.json'); writeFileSync(patch, '{"dedupeDays":1}');
    assert.equal(f.run('settings', ['set', patch]).status, 0);
    writeFileSync(join(f.data, 'sentinel'), 'old data');
    const defaultsFile = join(f.skill, 'settings.json');
    const defaults = JSON.parse(readFileSync(defaultsFile)); defaults.dedupeDays = 20;
    writeFileSync(defaultsFile, JSON.stringify(defaults));
    writeFileSync(skillFile, readFileSync(skillFile, 'utf8').replace(/^version: .+$/m, 'version: 2.10.0'));
    assert.equal(f.ok('init').dataRebuilt, true);
    assert.equal(existsSync(join(f.data, 'settings.json')), false);
    assert.equal(existsSync(join(f.data, 'sentinel')), false);
    assert.equal(JSON.parse(f.run('settings', ['json']).stdout).settings.dedupeDays, 20);
    writeFileSync(skillFile, readFileSync(skillFile, 'utf8').replace(/^version: .+$/m, 'version: 2.9.0'));
    assert.match(f.records('init').stderr, /DATA_NEWER_VERSION/);
    assert.equal(JSON.parse(readFileSync(f.marker)).skillVersion, '2.10.0');
});

test('concurrent different-version init is exclusive and the older copy cannot clear the winner on retry', async (t) => {
    const f = fixture(t);
    const oldSkill = join(f.root, 'old-skill'); cpSync(f.skill, oldSkill, { recursive: true });
    for (const [skill, version] of [[oldSkill, '2.9.0'], [f.skill, '2.10.0']]) {
        const file = join(skill, 'SKILL.md'); writeFileSync(file, readFileSync(file, 'utf8').replace(/^version: .+$/m, 'version: ' + version));
    }
    const ready = join(f.root, 'old-holds-lock');
    const oldEntry = join(oldSkill, 'scripts', 'records.mjs');
    const harness = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const mkdir=fs.mkdirSync; fs.mkdirSync=(p,...a)=>{if(String(p)===${JSON.stringify(join(f.data, 'runs'))}){fs.writeFileSync(${JSON.stringify(ready)},'held'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500)} return mkdir(p,...a)};syncBuiltinESMExports();process.argv=[process.execPath,${JSON.stringify(oldEntry)},'init'];await import(${JSON.stringify(pathToFileURL(oldEntry).href)});`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', harness], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', b => { stderr += b; });
    const done = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', code => resolveExit(code)); });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const deadline = Date.now() + 15000;
    while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.ok(existsSync(ready), stderr || 'older init did not reach its locked action');
    assert.match(f.records('init').stderr, /DATA_BUSY/);
    assert.equal(await done, 0, stderr);
    assert.equal(f.ok('init').skillVersion, '2.10.0');
    writeFileSync(join(f.data, 'winner'), 'preserve');
    const retry = spawnSync(process.execPath, [oldEntry, 'init'], { env: f.env, encoding: 'utf8', timeout: 15000 });
    assert.notEqual(retry.status, 0); assert.match(retry.stderr, /DATA_NEWER_VERSION/);
    assert.equal(readFileSync(join(f.data, 'winner'), 'utf8'), 'preserve');
    assert.equal(JSON.parse(readFileSync(f.marker)).skillVersion, '2.10.0'); assert.equal(existsSync(f.lock), false);
});

test('view/version/stats/lookup never initialize or clear legacy data', (t) => {
    const f = fixture(t); f.seed(null, []);
    writeFileSync(join(f.data, 'settings.json'), '{}'); writeFileSync(join(f.data, 'records.jsonl'), '');
    const request = join(f.root, 'lookup.json'); writeFileSync(request, JSON.stringify({ platform: '淘宝', account: { type: 'loginNick', value: 'anonymous', source: 'site-nav-login-info-nick' }, entryUrl: 'https://item.taobao.com/item.htm?id=123' }));
    for (const result of [f.records('version'), f.records('stats'), f.run('settings', ['json']), f.run('contacts', ['lookup', '--file', request])]) assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(f.data).sort(), ['records.jsonl', 'settings.json']); assert.equal(existsSync(f.lock), false);
});

test('other write entries require init and cannot silently rebuild', (t) => {
    const f = fixture(t); const patch = join(f.root, 'patch.json'); writeFileSync(patch, '{"dedupeDays":1}');
    const request = join(f.root, 'request.json'); writeFileSync(request, '{}');
    for (const result of [f.records('manual', 'IQ-TEST', 'test'), f.run('settings', ['set', patch]), f.run('settings', ['reset', '--all']), f.run('contacts', ['remember', '--file', request])]) {
        assert.notEqual(result.status, 0); assert.match(result.stderr || result.stdout, /DATA_INIT_REQUIRED/);
        assert.equal(existsSync(f.data), false); assert.equal(existsSync(f.lock), false);
    }
});

for (const lockName of ['.settings.lock', '.contacts.lock']) test(`business lock blocks rebuild, not removed as legacy data (${lockName})`, (t) => {
    const f = fixture(t); f.seed('0.1.0'); writeFileSync(join(f.data, lockName), 'other writer');
    const before = readFileSync(f.marker); const result = f.records('init'); assert.notEqual(result.status, 0); assert.match(result.stderr, /DATA_BUSY/);
    assert.equal(readFileSync(join(f.data, lockName), 'utf8'), 'other writer'); assert.deepEqual(readFileSync(f.marker), before); assert.equal(existsSync(f.lock), false);
});

test('outside lifecycle lock blocks both init and normal writes and is never auto-deleted', (t) => {
    const f = fixture(t); f.ok('init'); writeFileSync(f.lock, 'another owner');
    for (const args of [['init'], ['manual', 'IQ-TEST', 'test']]) { const p = f.records(...args); assert.notEqual(p.status, 0); assert.match(p.stderr, /DATA_BUSY/); assert.equal(readFileSync(f.lock, 'utf8'), 'another owner'); }
});

test('failed recursive cleanup leaves no current success marker and can be retried after the failure is removed', (t) => {
    const f = fixture(t); f.seed('0.1.0', ['a-before.txt', 'z-fail-delete.txt']);
    const hook = join(f.root, 'fail-delete.mjs');
    writeFileSync(hook, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const unlink=fs.unlinkSync; fs.unlinkSync=(p)=>{if(String(p).endsWith('z-fail-delete.txt'))throw Object.assign(new Error('controlled deletion failure'),{code:'EACCES'});return unlink(p)}; syncBuiltinESMExports();`);
    const entry = join(f.skill, 'scripts', 'records.mjs');
    const harness = `process.argv=[process.execPath,${JSON.stringify(entry)},'init']; await import(${JSON.stringify(pathToFileURL(hook).href)}); await import(${JSON.stringify(pathToFileURL(entry).href)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', harness], { env: f.env, encoding: 'utf8', timeout: 15000 });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /controlled deletion failure/); assert.equal(result.stdout, '');
    assert.equal(existsSync(f.marker), false); assert.equal(existsSync(join(f.data, 'a-before.txt')), false); assert.equal(existsSync(f.lock), false);
    assert.equal(f.ok('init').skillVersion, f.version); assert.equal(existsSync(join(f.data, 'z-fail-delete.txt')), false);
});

test('usage and validation errors release the lifecycle lock before returning', (t) => {
    const f = fixture(t); f.ok('init');
    const dir = join(f.data, 'runs', 'broken'); mkdirSync(dir); const file = join(dir, 'run.json'); writeFileSync(file, '{}');
    for (const args of [['new-run'], ['merge', dir], ['finish', file]]) {
        assert.notEqual(f.records(...args).status, 0); assert.equal(existsSync(f.lock), false);
        assert.equal(f.ok('init').dataRebuilt, false);
        assert.equal(f.records('manual', 'IQ-TEST', 'test').status, 0);
    }
});

for (const target of ['root', 'child', 'parent']) test(`links never lead recursive deletion outside isolated home (${target})`, (t) => {
    const f = fixture(t); const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'sentinel'), 'keep');
    if (target === 'root') symlinkSync(outside, f.data, process.platform === 'win32' ? 'junction' : 'dir');
    else if (target === 'child') { f.seed('0.1.0'); symlinkSync(outside, join(f.data, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    else { cleanup(f.home, f.root); symlinkSync(outside, f.home, process.platform === 'win32' ? 'junction' : 'dir'); }
    const result = f.records('init'); assert.notEqual(result.status, 0); assert.match(result.stderr, /DATA_PATH_UNSAFE/);
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'keep');
    if (target === 'child') assert.equal(readFileSync(join(f.data, 'settings.json'), 'utf8'), 'old:settings.json');
});
