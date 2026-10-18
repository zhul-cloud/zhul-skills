import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fields, writeSettings } from '../scripts/config.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const script = fileURLToPath(new URL('../scripts/settings.mjs', import.meta.url));
const source = readFileSync(new URL('../settings.json', import.meta.url), 'utf8');
const defaults = JSON.parse(source);
const get = (value, key) => key.split('.').reduce((part, name) => part?.[name], value);

function fixture(t) {
    // Windows 沙箱系统 Temp 的 rename 替换受限，夹具全部留在工作区并清理。
    const root = mkdtempSync(join(testDir, '.settings-test-'));
    const skill = join(root, '中文技能 with spaces');
    const scripts = join(skill, 'scripts');
    const home = join(root, 'isolated-home');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(home);
    for (const file of ['settings.mjs', 'config.mjs', 'data-lifecycle.mjs']) copyFileSync(join(dirname(script), file), join(scripts, file));
    const defaultsPath = join(skill, 'settings.json');
    writeFileSync(defaultsPath, source);
    copyFileSync(join(dirname(script), '..', 'SKILL.md'), join(skill, 'SKILL.md'));
    const dataDir = join(home, '.zhul-trade-sourcing');
    const path = join(dataDir, 'settings.json');
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { env, encoding: 'utf8' });
    assert.equal(resolve(probe.stdout), resolve(home));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cliAt = (entry, ...args) => spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 5000 });
    const stamp = () => { mkdirSync(dataDir, { recursive: true }); const marker = join(dataDir, '.skill-version.json'); if (!existsSync(marker)) writeFileSync(marker, JSON.stringify({ schemaVersion: 1, skillVersion: readFileSync(join(skill, 'SKILL.md'), 'utf8').match(/^version: (.+)$/m)[1].trim() })); };
    const cli = (...args) => { if (['set', 'reset'].includes(args[0])) stamp(); return cliAt(join(scripts, 'settings.mjs'), ...args); };
    const ok = (...args) => { const result = cli(...args); assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout; };
    const patch = (value) => { const input = join(root, '修改配置 patch.json'); writeFileSync(input, typeof value === 'string' ? value : JSON.stringify(value)); return input; };
    const seed = (value) => { mkdirSync(dataDir, { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
    const snapshot = () => existsSync(path) ? readFileSync(path, 'utf8') : null;
    const unchanged = (before = null) => {
        assert.equal(readFileSync(defaultsPath, 'utf8'), source);
        assert.equal(snapshot(), before);
        assert.deepEqual(readdirSync(skill).sort(), ['SKILL.md', 'scripts', 'settings.json']);
        if (before === null) { if (existsSync(dataDir)) assert.deepEqual(readdirSync(dataDir).filter(name => name !== '.skill-version.json'), []); else assert.deepEqual(readdirSync(home), []); }
        else assert.deepEqual(readdirSync(dataDir).filter(name => name !== '.skill-version.json'), ['settings.json']);
    };
    return { root, skill, scripts, home, env, path, dataDir, defaultsPath, stamp, cliAt, cli, ok, patch, seed, snapshot, unchanged,
        read: () => JSON.parse(readFileSync(path, 'utf8')), effective: () => JSON.parse(ok('json')).settings };
}

test('view/check/json inherit defaults, show absolute paths and sources without creating data', (t) => {
    const f = fixture(t);
    const output = f.ok();
    for (const path of [f.path, f.defaultsPath, f.dataDir]) assert.ok(output.includes(path));
    assert.match(output, /键名 \| 有效值 \| 来源 \| 简要说明/);
    for (const key of Object.keys(fields)) {
        const row = output.split('\n').find((line) => line.startsWith(`| ${key} |`));
        assert.ok(row?.includes(`| ${JSON.stringify(get(defaults, key))} | 默认 |`), key);
    }
    assert.match(f.ok('check'), /校验通过/);
    assert.deepEqual(JSON.parse(f.ok('json')), { dataDir: f.dataDir, defaultsPath: f.defaultsPath, userSettingsPath: f.path, settings: defaults });
    f.unchanged();
});

test('set stores only explicit nested fields, false/zero/empty strings and whole arrays, and preserves existing user choices', (t) => {
    const f = fixture(t);
    const patch = { confirmBeforeSend: false, firstHumanReplyMinutes: 0, dedupeDays: 0, thankYouMessages: ['好 | 谢谢', '收到 `谢谢`', '谢谢\n再见'], subagents: { enabled: false, codex: { model: '', effort: '' } } };
    assert.match(f.ok('set', f.patch(patch)), /已更新个人配置/);
    assert.deepEqual(f.read(), patch);
    assert.deepEqual(f.effective().subagents.claude, defaults.subagents.claude);
    f.ok('set', f.patch({ subagents: { claude: { model: 'runtime-id', effort: '' } } }));
    assert.deepEqual(f.read().subagents.codex, patch.subagents.codex);
    assert.deepEqual(f.read().subagents.claude, { model: 'runtime-id', effort: '' });
    assert.deepEqual(readdirSync(f.dataDir).filter(name => name !== '.skill-version.json'), ['settings.json']);
    assert.match(f.ok(), /&#124;/);
    assert.match(f.ok(), /&#96;/);
    assert.match(f.ok(), /subagents.codex.model \| "" \| 个人/);
    assert.equal(readFileSync(f.defaultsPath, 'utf8'), source);
});

test('same-default explicit choice creates a pin; repeating it preserves original bytes and mtime', (t) => {
    const f = fixture(t);
    const patch = { dedupeDays: defaults.dedupeDays };
    const output = f.ok('set', f.patch(patch));
    assert.match(output, /新增覆盖/);
    assert.deepEqual(f.read(), patch);
    const original = `${JSON.stringify(patch, null, 4)}\n\n`;
    f.seed(original);
    utimesSync(f.path, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    const before = statSync(f.path).mtimeMs;
    assert.match(f.ok('set', f.patch(patch)), /无变化，未重写/);
    f.unchanged(original);
    assert.equal(statSync(f.path).mtimeMs, before);
});

test('same-version copied clients share overrides; changed defaults affect only unspecified fields', (t) => {
    const f = fixture(t);
    f.ok('set', f.patch({ dedupeDays: 0, subagents: { codex: { effort: 'high' } } }));
    const otherSkill = join(f.root, 'second client');
    mkdirSync(join(otherSkill, 'scripts'), { recursive: true });
    for (const file of ['settings.mjs', 'config.mjs', 'data-lifecycle.mjs']) copyFileSync(join(f.scripts, file), join(otherSkill, 'scripts', file));
    copyFileSync(join(f.skill, 'SKILL.md'), join(otherSkill, 'SKILL.md'));
    const updated = structuredClone(defaults);
    updated.dedupeDays = 20;
    updated.subagents.codex.model = 'new-default-model';
    updated.subagents.codex.effort = 'low';
    writeFileSync(join(otherSkill, 'settings.json'), JSON.stringify(updated));
    const result = f.cliAt(join(otherSkill, 'scripts', 'settings.mjs'), 'json');
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.userSettingsPath, f.path);
    assert.equal(out.settings.dedupeDays, 0);
    assert.deepEqual(out.settings.subagents.codex, { model: 'new-default-model', effort: 'high' });
    assert.deepEqual(f.read(), { dedupeDays: 0, subagents: { codex: { effort: 'high' } } });
});

test('empty personal object is valid and does not get materialized', (t) => {
    const f = fixture(t);
    f.seed('{}\n');
    assert.deepEqual(f.effective(), defaults);
    f.unchanged('{}\n');
});

test('invalid patches reject all sibling changes without creating data or modifying defaults', (t) => {
    const f = fixture(t);
    const cases = [
        ['{', /不是有效/],
        ['\uFEFF{}', /无 BOM/],
        [[], /顶层必须是对象/],
        [{}, /不能为空/],
        [{ subagents: { codex: {} } }, /不能为空/],
        [{ typo: 1 }, /typo.*未知/],
        [{ subagents: { codex: { typo: 1 } } }, /subagents.codex.typo.*未知/],
        ['{"__proto__":{"polluted":true}}', /__proto__.*禁止/],
        ['{"subagents":{"constructor":{}}}', /constructor.*禁止/],
        ['{"subagents":{"codex":{"prototype":{}}}}', /prototype.*禁止/],
        [{ 'subagents.codex.model': 'other' }, /未知/],
        [{ subagents: null }, /subagents.*必须是对象/],
        [{ shopsPerLink: { min: 9, max: 2 } }, /shopsPerLink.*min 不能大于 max/],
        [{ pollIntervalSeconds: { min: 9, max: 2 } }, /pollIntervalSeconds.*min 不能大于 max/],
        [{ firstHumanReplyMinutes: -1 }, /firstHumanReplyMinutes.*非负/],
        [{ followUpReplyMinutes: '3' }, /followUpReplyMinutes.*数字/],
        [{ dedupeDays: null }, /dedupeDays.*数字/],
        ['{"dedupeDays":1e400}', /dedupeDays.*有限/],
        [{ confirmBeforeSend: 'true' }, /confirmBeforeSend.*boolean/],
        [{ subagents: { enabled: 0 } }, /subagents.enabled.*boolean/],
        [{ shopsPerLink: { min: 0 } }, /shopsPerLink.min.*正整数/],
        [{ shopsPerLink: { max: 3.1 } }, /shopsPerLink.max.*正整数/],
        [{ maxFollowUpsPerShop: -1 }, /maxFollowUpsPerShop.*非负整数/],
        [{ maxFollowUpsPerShop: 0.5 }, /maxFollowUpsPerShop.*非负整数/],
        [{ pollIntervalSeconds: { min: 0 } }, /pollIntervalSeconds.min.*正的/],
        [{ subagents: { stallMinutes: 0 } }, /subagents.stallMinutes.*正的/],
        [{ priceOutlierPercent: -1 }, /priceOutlierPercent.*0 到 100/],
        [{ priceOutlierPercent: 101 }, /priceOutlierPercent.*0 到 100/],
        [{ thankYouMessages: ['a', 'b'] }, /thankYouMessages.*至少 3/],
        [{ thankYouMessages: ['a', 'b', ' '] }, /thankYouMessages.*非空/],
        [{ thankYouMessages: ['a', 'b', 3] }, /thankYouMessages.*字符串/],
        [{ subagents: { codex: { model: null } } }, /subagents.codex.model.*字符串/],
        [{ subagents: { claude: { effort: 'ultra' } } }, /subagents.claude.effort/],
        [{ subagents: { codex: { effort: 'super' } } }, /subagents.codex.effort/],
    ];

    for (const [value, error] of cases) {
        const patch = typeof value === 'object' && !Array.isArray(value) && !/不能为空/.test(error.source)
            ? { confirmBeforeSend: !defaults.confirmBeforeSend, ...value } : value;
        const result = f.cli('set', f.patch(patch));
        assert.notEqual(result.status, 0, JSON.stringify(value));
        assert.match(result.stderr, error);
        assert.equal(result.stdout, '');
        f.unchanged();
    }
    const invalidUtf8 = f.patch('{}');
    writeFileSync(invalidUtf8, Buffer.from([0xff, 0xfe]));
    assert.notEqual(f.cli('set', invalidUtf8).status, 0);
    f.unchanged();
});

test('set can repair known invalid personal fields, but unrelated invalid fields still block writes', (t) => {
    const f = fixture(t);
    f.seed({ confirmBeforeSend: 'wrong', subagents: { codex: null } });
    const before = f.snapshot();
    for (const args of [[], ['check'], ['json'], ['set', f.patch({ confirmBeforeSend: false })]]) {
        assert.notEqual(f.cli(...args).status, 0);
        f.unchanged(before);
    }
    f.ok('set', f.patch({ confirmBeforeSend: false, subagents: { codex: { model: '', effort: '' } } }));
    assert.deepEqual(f.read(), { confirmBeforeSend: false, subagents: { codex: { model: '', effort: '' } } });
});

test('unknown personal keys, malformed JSON, BOM and invalid UTF8 fail with the actual personal path', (t) => {
    const f = fixture(t);
    for (const text of ['{', '\uFEFF{}', 'null', '{"subagents":{"typo":123}}', '{"confirmBeforeSend":{"__proto__":{}}}']) {
        f.seed(text);
        for (const args of [[], ['check'], ['json'], ['set', f.patch({ dedupeDays: 0 })]]) {
            const result = f.cli(...args);
            assert.notEqual(result.status, 0);
            assert.ok(result.stderr.includes(f.path), result.stderr);
            f.unchanged(text);
        }
    }
    writeFileSync(f.path, Buffer.from([0xff]));
    const result = f.cli('check');
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(f.path));
    assert.deepEqual(readFileSync(f.path), Buffer.from([0xff]));
});

test('bad defaults and command/input errors are labeled and read-only', (t) => {
    const f = fixture(t);
    for (const text of ['{', '\uFEFF{}', 'null', JSON.stringify({ ...defaults, dedupeDays: -1 })]) {
        writeFileSync(f.defaultsPath, text);
        const result = f.cli('check');
        assert.notEqual(result.status, 0);
        assert.ok(result.stderr.includes(f.defaultsPath));
        assert.deepEqual(readdirSync(f.home), []);
    }
    writeFileSync(f.defaultsPath, source);
    const input = f.patch(defaults);
    const inputText = readFileSync(input, 'utf8');
    const invalidArgs = [['set'], ['check', 'extra'], ['json', 'extra'], ['migrate'], ['migrate', input], ['unexpected']];
    for (const before of [null, '{"dedupeDays":0}\n']) {
        if (before !== null) f.seed(before);
        for (const args of invalidArgs) {
            const result = f.cli(...args);
            assert.notEqual(result.status, 0, JSON.stringify(args));
            assert.match(result.stderr, /用法/);
            assert.equal(result.stdout, '');
            assert.equal(readFileSync(input, 'utf8'), inputText);
            f.unchanged(before);
        }
    }
    const missing = join(f.root, 'missing.json');
    assert.ok(f.cli('set', missing).stderr.includes(missing));
    f.unchanged('{"dedupeDays":0}\n');
});

test('concurrent updates and lock contention preserve user files and clean temporary files', (t) => {
    const f = fixture(t);
    f.seed('{"dedupeDays":2}\n');
    const before = f.snapshot();
    assert.throws(() => writeSettings(f.path, null, { dedupeDays: 1 }), /读取后已被其他操作修改/);
    assert.throws(() => writeSettings(f.path, '{}', { dedupeDays: 1 }), /读取后已被其他操作修改/);
    assert.throws(() => writeSettings(f.path, '{}', {}), /读取后已被其他操作修改/);
    f.unchanged(before);
    const lock = join(f.dataDir, '.settings.lock');
    writeFileSync(lock, 'other writer');
    assert.throws(() => writeSettings(f.path, before, { dedupeDays: 1 }), /其他操作正在修改/);
    assert.equal(readFileSync(lock, 'utf8'), 'other writer');
    assert.equal(f.snapshot(), before);
    rmSync(lock);
    f.unchanged(before);
});

test('first creation holds the shared lock and a later stale first-create attempt cannot replace it', (t) => {
    const f = fixture(t);
    mkdirSync(f.dataDir);
    const lock = join(f.dataDir, '.settings.lock');
    writeFileSync(lock, 'first writer');
    assert.throws(() => writeSettings(f.path, null, { dedupeDays: 1 }), /其他操作正在修改/);
    assert.equal(existsSync(f.path), false);
    assert.equal(readFileSync(lock, 'utf8'), 'first writer');
    rmSync(lock);
    assert.equal(writeSettings(f.path, null, { dedupeDays: 2 }), true);
    assert.throws(() => writeSettings(f.path, null, { dedupeDays: 1 }), /读取后已被其他操作修改/);
    assert.deepEqual(f.read(), { dedupeDays: 2 });
    assert.deepEqual(readdirSync(f.dataDir).filter(name => name !== '.skill-version.json'), ['settings.json']);
});

test('commands run through junctions with Chinese names and spaces using the isolated home', (t) => {
    const f = fixture(t);
    const link = join(f.root, '技能链接 with spaces');
    symlinkSync(f.skill, link, process.platform === 'win32' ? 'junction' : 'dir');
    f.stamp();
    for (const args of [[], ['check'], ['json'], ['set', f.patch({ dedupeDays: 0 })], ['reset', 'dedupeDays']]) {
        const result = f.cliAt(join(link, 'scripts', 'settings.mjs'), ...args);
        assert.equal(result.status, 0, result.stderr);
        if (args[0] === 'json') assert.equal(JSON.parse(result.stdout).userSettingsPath, f.path);
        else assert.ok(result.stdout.includes(f.path));
    }
    assert.deepEqual(f.read(), {});
    assert.equal(readFileSync(f.defaultsPath, 'utf8'), source);
});

test('reset removes a single pin, reports before/after and returns its source to defaults', (t) => {
    const f = fixture(t);
    f.seed({ dedupeDays: 0, confirmBeforeSend: true });
    const output = f.ok('reset', 'dedupeDays');
    assert.match(output, /dedupeDays \| 0 \| 7 \| 移除覆盖，恢复默认/);
    assert.deepEqual(f.read(), { confirmBeforeSend: true });
    assert.match(f.ok(), /dedupeDays \| 7 \| 默认/);
    assert.match(f.ok(), /confirmBeforeSend \| true \| 个人/);
    f.seed({ dedupeDays: defaults.dedupeDays });
    assert.match(f.ok('reset', 'dedupeDays'), /dedupeDays \| 7 \| 7 \| 移除覆盖，恢复默认/);
    assert.deepEqual(f.read(), {});
});

test('reset nested leaves keeps siblings and other clients, pruning only emptied ancestors', (t) => {
    const f = fixture(t);
    const claude = { model: 'custom-claude', effort: 'high' };
    f.seed({ dedupeDays: 0, subagents: { enabled: false, codex: { model: 'custom-codex', effort: 'high' }, claude } });
    f.ok('reset', 'subagents.codex.model');
    assert.deepEqual(f.read(), { dedupeDays: 0, subagents: { enabled: false, codex: { effort: 'high' }, claude } });
    f.ok('reset', 'subagents.codex.effort');
    assert.deepEqual(f.read(), { dedupeDays: 0, subagents: { enabled: false, claude } });
    f.ok('reset', 'subagents');
    assert.deepEqual(f.read(), { dedupeDays: 0 });
});

test('reset supports groups and multiple overlapping keys as one batch', (t) => {
    const f = fixture(t);
    f.seed({ shopsPerLink: { min: 1, max: 5 }, pollIntervalSeconds: { min: 5, max: 50 }, subagents: { codex: { effort: 'high' }, claude: { effort: 'high' } }, dedupeDays: 0 });
    f.ok('reset', 'shopsPerLink', 'pollIntervalSeconds.min', 'pollIntervalSeconds.max', 'subagents.codex.model', 'subagents.codex', 'subagents.codex', 'dedupeDays');
    assert.deepEqual(f.read(), { subagents: { claude: { effort: 'high' } } });
    assert.deepEqual(f.effective().shopsPerLink, defaults.shopsPerLink);
    assert.deepEqual(f.effective().subagents.codex, defaults.subagents.codex);
});

test('reset missing overrides does not create files or clean unrelated empty objects', (t) => {
    const f = fixture(t);
    for (const args of [['reset', 'dedupeDays'], ['reset', 'subagents.codex'], ['reset', '--all']]) {
        assert.match(f.ok(...args), /无变化，未重写/);
        f.unchanged();
    }
    const original = '{\r\n  "subagents": { "codex": {} },\r\n  "dedupeDays": 0\r\n}\r\n';
    f.seed(original);
    utimesSync(f.path, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    const before = statSync(f.path).mtimeMs;
    f.ok('reset', 'subagents.codex.model');
    f.unchanged(original);
    assert.equal(statSync(f.path).mtimeMs, before);
    f.ok('reset', 'dedupeDays');
    assert.deepEqual(f.read(), { subagents: { codex: {} } });
    f.ok('reset', 'subagents.codex');
    assert.deepEqual(f.read(), {});
});

test('reset all writes an empty object, preserves CRLF and business files, then leaves bytes and mtime intact', (t) => {
    const f = fixture(t);
    f.seed('{\r\n  "dedupeDays": 0,\r\n  "subagents": { "enabled": false }\r\n}\r\n');
    const business = { 'config.json': '{"erp":"unchanged"}', 'records.jsonl': '{"business":"unchanged"}\n' };
    for (const [name, text] of Object.entries(business)) writeFileSync(join(f.dataDir, name), text);
    mkdirSync(join(f.dataDir, 'reports'));
    writeFileSync(join(f.dataDir, 'reports', 'existing.txt'), 'keep');
    f.ok('reset', '--all');
    assert.equal(f.snapshot(), '{}\r\n');
    assert.deepEqual(f.effective(), defaults);
    utimesSync(f.path, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    const before = statSync(f.path).mtimeMs;
    assert.match(f.ok('reset', '--all'), /无变化，未重写/);
    assert.equal(f.snapshot(), '{}\r\n');
    assert.equal(statSync(f.path).mtimeMs, before);
    for (const [name, text] of Object.entries(business)) assert.equal(readFileSync(join(f.dataDir, name), 'utf8'), text);
    assert.equal(readFileSync(join(f.dataDir, 'reports', 'existing.txt'), 'utf8'), 'keep');
    assert.deepEqual(readdirSync(f.dataDir).filter(name => name !== '.skill-version.json').sort(), ['config.json', 'records.jsonl', 'reports', 'settings.json']);
    assert.equal(readFileSync(f.defaultsPath, 'utf8'), source);
});

test('reset rejects every invalid argument before writing any valid sibling', (t) => {
    const f = fixture(t);
    f.seed({ dedupeDays: 0 });
    const before = f.snapshot();
    const invalid = ['typo', '__proto__', 'constructor', 'prototype', 'subagents.__proto__', 'subagents.codex.constructor', 'thankYouMessages.0', 'shopsPerLink.min.0', '*', 'subagents.*', '--al', '--all=true', '--help', '', '.dedupeDays', 'dedupeDays.', 'subagents..codex'];
    for (const args of [['reset'], ['reset', '--all', 'dedupeDays'], ['reset', 'dedupeDays', '--all'], ['reset', '--all', '--all'], ...invalid.map((key) => ['reset', 'dedupeDays', key])]) {
        const result = f.cli(...args);
        assert.notEqual(result.status, 0, JSON.stringify(args));
        assert.equal(result.stdout, '');
        f.unchanged(before);
    }
});

test('reset validates the combined batch, rejecting one-sided shops and polling ranges without writes', (t) => {
    const f = fixture(t);
    for (const [group, range, badEnd] of [['shopsPerLink', { min: 5, max: 6 }, 'max'], ['shopsPerLink', { min: 1, max: 2 }, 'min'], ['pollIntervalSeconds', { min: 40, max: 50 }, 'max'], ['pollIntervalSeconds', { min: 2, max: 5 }, 'min']]) {
        f.seed({ [group]: range, dedupeDays: 0 });
        const before = f.snapshot();
        const result = f.cli('reset', 'dedupeDays', `${group}.${badEnd}`);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /min 不能大于 max/);
        f.unchanged(before);
        f.ok('reset', `${group}.min`, `${group}.max`);
        assert.deepEqual(f.read(), { dedupeDays: 0 });
    }
});

test('reset repairs known bad personal leaves and groups only when all remaining values are valid', (t) => {
    const f = fixture(t);
    f.seed({ confirmBeforeSend: 'wrong', subagents: { codex: null }, dedupeDays: 0 });
    const before = f.snapshot();
    assert.notEqual(f.cli('reset', 'confirmBeforeSend').status, 0);
    f.unchanged(before);
    f.ok('reset', 'confirmBeforeSend', 'subagents.codex');
    assert.deepEqual(f.read(), { dedupeDays: 0 });
    f.seed({ thankYouMessages: 'wrong', shopsPerLink: null, subagents: false });
    f.ok('reset', '--all');
    assert.deepEqual(f.read(), {});
});

test('same-version reset repairs changed defaults and removed overrides inherit same-version client defaults', (t) => {
    const f = fixture(t);
    f.seed({ shopsPerLink: { max: 4 }, dedupeDays: 0, subagents: { codex: { model: 'pinned-model', effort: 'high' } } });
    const updated = structuredClone(defaults);
    updated.shopsPerLink = { min: 5, max: 6 };
    writeFileSync(f.defaultsPath, JSON.stringify(updated));
    assert.notEqual(f.cli('check').status, 0);
    f.ok('reset', 'shopsPerLink.max', 'subagents.codex.model');
    const remaining = f.snapshot();
    assert.deepEqual(f.read(), { dedupeDays: 0, subagents: { codex: { effort: 'high' } } });
    const otherSkill = join(f.root, 'same-version client');
    mkdirSync(join(otherSkill, 'scripts'), { recursive: true });
    for (const file of ['settings.mjs', 'config.mjs', 'data-lifecycle.mjs']) copyFileSync(join(f.scripts, file), join(otherSkill, 'scripts', file));
    updated.shopsPerLink = { min: 7, max: 8 };
    updated.subagents.codex.model = 'future-model';
    updated.subagents.codex.effort = 'low';
    updated.dedupeDays = 20;
    copyFileSync(join(f.skill, 'SKILL.md'), join(otherSkill, 'SKILL.md'));
    writeFileSync(join(otherSkill, 'settings.json'), JSON.stringify(updated));
    const result = f.cliAt(join(otherSkill, 'scripts', 'settings.mjs'), 'json');
    assert.equal(result.status, 0, result.stderr);
    const effective = JSON.parse(result.stdout).settings;
    assert.deepEqual(effective.shopsPerLink, updated.shopsPerLink);
    assert.deepEqual(effective.subagents.codex, { model: 'future-model', effort: 'high' });
    assert.equal(effective.dedupeDays, 0);
    assert.equal(f.snapshot(), remaining);
});

test('reset never repairs malformed or unknown personal data by discarding it', (t) => {
    const f = fixture(t);
    for (const text of ['{', '\uFEFF{}', 'null', '{"subagents":{"typo":1}}', '{"__proto__":{}}']) {
        f.seed(text);
        for (const args of [['reset', 'dedupeDays'], ['reset', '--all']]) {
            const result = f.cli(...args);
            assert.notEqual(result.status, 0);
            assert.ok(result.stderr.includes(f.path));
            f.unchanged(text);
        }
    }
    writeFileSync(f.path, Buffer.from([0xff]));
    assert.notEqual(f.cli('reset', '--all').status, 0);
    assert.deepEqual(readFileSync(f.path), Buffer.from([0xff]));
});

test('reset requires independently valid repository defaults, preserving personal bytes', (t) => {
    const f = fixture(t);
    f.seed({ dedupeDays: 0 });
    const before = f.snapshot();
    for (const text of ['{', '\uFEFF{}', 'null', JSON.stringify({ ...defaults, dedupeDays: -1 }), JSON.stringify({ ...defaults, shopsPerLink: { min: 9, max: 1 } })]) {
        writeFileSync(f.defaultsPath, text);
        for (const args of [['reset', 'dedupeDays'], ['reset', '--all']]) {
            const result = f.cli(...args);
            assert.notEqual(result.status, 0);
            assert.ok(result.stderr.includes(f.defaultsPath));
            assert.equal(f.snapshot(), before);
            assert.deepEqual(readdirSync(f.dataDir).filter(name => name !== '.skill-version.json'), ['settings.json']);
        }
    }
});

test('reset CLI shares the exclusive write lock and preserves a competing writer lock', (t) => {
    const f = fixture(t);
    f.seed({ dedupeDays: 0, confirmBeforeSend: true });
    const before = f.snapshot();
    const lock = join(f.dataDir, '.settings.lock');
    writeFileSync(lock, 'other writer');
    for (const args of [['reset', 'dedupeDays'], ['reset', '--all']]) {
        const result = f.cli(...args);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /其他操作正在修改/);
        assert.equal(f.snapshot(), before);
        assert.equal(readFileSync(lock, 'utf8'), 'other writer');
        assert.deepEqual(readdirSync(f.dataDir).filter(name => name !== '.skill-version.json').sort(), ['.settings.lock', 'settings.json']);
    }
    rmSync(lock);
    f.ok('reset', 'dedupeDays');
    assert.deepEqual(f.read(), { confirmBeforeSend: true });
    assert.deepEqual(readdirSync(f.dataDir).filter(name => name !== '.skill-version.json'), ['settings.json']);
});
