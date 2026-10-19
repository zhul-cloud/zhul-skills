import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { adaptSource, compareSource, extractSource, helperSource, listHelpers, officialHashes } from '../scripts/helpers.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const script = fileURLToPath(new URL('../scripts/helpers.mjs', import.meta.url));
const erp = 'https://erp.example.invalid:8443';
const entries = listHelpers(erp);
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture(t) {
    const root = mkdtempSync(join(testDir, '.helpers-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const absentHome = join(root, 'absent-home');
    const env = { ...process.env, HOME: absentHome, USERPROFILE: absentHome, BROWSEROS_HELPERS_DIR: join(root, 'absent-browser') };
    const cli = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8', timeout: 5000 });
    return { root, cli };
}

test('list gives seven unique runtime names and only metadata, with explicit ERP hostname', (t) => {
    const f = fixture(t);
    const result = f.cli('list', '--erp', erp);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.runtimeLoaded, false);
    assert.equal(out.helpers.length, 7);
    assert.equal(new Set(out.helpers.map((entry) => entry.runtimeName)).size, 7);
    assert.equal(out.helpers.find((entry) => entry.sourceKey === '_erp/erpApi').host, 'erp.example.invalid');
    assert.ok(out.helpers.every((entry) => !('source' in entry)));
    assert.deepEqual(readdirSync(f.root), []);
});

test('source is deterministic, single-domain, and independent of personal home/config/browser directories', (t) => {
    const f = fixture(t);
    const first = f.cli('source', 's.taobao.com/searchCandidates');
    const second = f.cli('source', 's.taobao.com/searchCandidates');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, second.stdout);
    const out = JSON.parse(first.stdout);
    assert.equal(out.sourceKey, 's.taobao.com/searchCandidates');
    assert.equal(out.runtimeName, 'zhul_taobao_searchCandidates');
    assert.equal(out.originalName, 'searchCandidates');
    assert.equal(out.policy, 'preserve-local-changes');
    assert.equal(out.runtimeLoaded, false);
    assert.match(out.sha256, /^[a-f0-9]{64}$/);
    assert.match(out.source, /^async \(browser, page, inputs = \{\}\) =>/);
    assert.deepEqual(readdirSync(f.root), []);
});

test('CLI through a directory junction/symlink still executes list and source', (t) => {
    const f = fixture(t);
    const alias = join(f.root, 'installed-skill');
    symlinkSync(dirname(dirname(script)), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasedScript = join(alias, 'scripts', 'helpers.mjs');
    for (const args of [['list', '--erp', erp], ['source', '_erp/erpApi', '--erp', erp]]) {
        const result = spawnSync(process.execPath, [aliasedScript, ...args], { cwd: f.root, encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 0, result.stderr);
        const out = JSON.parse(result.stdout);
        assert.equal(out.runtimeLoaded, false);
        if (args[0] === 'list') assert.equal(out.helpers.length, 7);
        else assert.equal(out.sourceKey, '_erp/erpApi');
    }
});

for (const args of [[], ['list', 'extra'], ['source'], ['source', 'searchCandidates'],
    ['source', '../SKILL'], ['source', 's.taobao.com/searchCandidates', 'extra'],
    ['source', '_erp/erpApi'], ['list', '--erp'], ['list', '--erp', 'file:///tmp/erp'],
    ['list', '--erp', 'https://user:password@example.invalid'], ['list', '--unknown']]) {
    test(`rejects wrong/ambiguous arguments without side effects: ${args.join(' ')}`, (t) => {
        const f = fixture(t);
        const result = f.cli(...args);
        assert.equal(result.status, 2);
        assert.equal(result.stdout, '');
        assert.ok(result.stderr.trim());
        assert.deepEqual(readdirSync(f.root), []);
    });
}

test('ERP source host follows explicit URL while the function remains portable to a changed ERP host', () => {
    const first = helperSource('_erp/erpApi', erp);
    const second = helperSource('_erp/erpApi', 'http://127.0.0.1:5000');
    assert.equal(first.host, 'erp.example.invalid');
    assert.equal(second.host, '127.0.0.1');
    assert.equal(first.runtimeName, 'erpApi');
    assert.equal(first.source, second.source);
    assert.equal(first.policy, 'skill-version');
});

test('ERP keeps its published predecessor hash for migration without trusting unknown content', () => {
    const key = '_erp/erpApi';
    assert.ok(officialHashes[key].includes('e662e6634773133cd9c8cf38d4d685f9a14719b1164e593533da689ef81fd7ec'));
    assert.ok(officialHashes[key].includes('7b1ecfc8471b4b92d499c4b6bd52ba4749940fad08a5e30515d5838886002bd3'));
    assert.ok(officialHashes[key].includes('4f8b5e6bb391aefedbb78f0f01911a12136ee72518d2675fd678198f9a519484'));
    assert.equal(compareSource(key, helperSource(key, erp).source, erp).status, 'current');
    assert.equal(compareSource(key, 'unknown customized ERP', erp).status, 'unknown');
});

test('1688 unscoped preview predecessor is recognized while unknown changes remain preserved', () => {
    const key = 'air.1688.com/imPreviews';
    const current = helperSource(key).source;
    const previous = current.replace("const found = [...f.contentDocument.querySelectorAll('.conversation-item')]\n        .map((row) => row.querySelector('.content')).filter((e) => e && nameOf(e) === k.trim());",
        "const found = [...f.contentDocument.querySelectorAll('.content')].filter((e) => nameOf(e) === k.trim());");
    assert.notEqual(previous, current);
    const compared = compareSource(key, previous);
    assert.equal(compared.actualSha256, '2f42c0cea2c96af096eb68cdb3c28189337e42ab5d7f1f46c62e833584d806b7');
    assert.equal(compared.status, 'known-official-older');
    assert.equal(compared.action, 'sync');
    assert.equal(compareSource(key, current.replace('const res =', '// custom\n  const res =')).action, 'preserve');
});

test('淘宝 keeps the fixed-wait published predecessor hash when updating its reader', () => {
    const key = 'market.m.taobao.com/imOpenAndRead';
    assert.ok(officialHashes[key].includes('57c0d5b74e6da0ec7e5b1cc8f90d9602e0434fee1642106f25c6a967f1776897'));
    assert.equal(compareSource(key, helperSource(key).source).status, 'current');
    assert.equal(compareSource(key, helperSource(key).source.replace('const contact =', '// local change\n  const contact =')).action, 'preserve');
});

test('search evidence upgrades retain both published legacy hashes and preserve unknown custom helpers', () => {
    for (const [key, previous] of [
        ['s.taobao.com/searchCandidates', 'f7f4a7f7b772523cef0734398245fcafb014c35de02bd8b083d5f45ccc7f45a1'],
        ['s.1688.com/searchCandidates', 'caf4e50921472230841d302f543f44db1a6735da93f4cca31ee70f807ed6bf98'],
    ]) {
        assert.ok(officialHashes[key].includes(previous));
        const current = helperSource(key);
        assert.notEqual(current.sha256, previous);
        assert.equal(compareSource(key, current.source).status, 'current');
        assert.equal(compareSource(key, current.source.replace('const detailed =', '// local change\n  const detailed =')).action, 'preserve');
    }
});

test('extraction accepts CRLF and fails closed on missing/duplicate blocks or changed signature', () => {
    const source = 'async (browser, pageId, req) => { return req; }';
    assert.equal(extractSource(`before\r\n\`\`\`js\r\n${source}\r\n\`\`\`\r\nafter`), source);
    assert.throws(() => extractSource('no block'), /只有一个/);
    assert.throws(() => extractSource(`\`\`\`js\n${source}\n\`\`\`\n\`\`\`js\n${source}\n\`\`\``), /只有一个/);
    assert.throws(() => extractSource('```js\nasync (browser, page, req) => {}\n```'), /签名/);
    assert.throws(() => extractSource('```js\nasync (browser, pageId, req) => { invalid JS }\n```'), SyntaxError);
});

for (const entry of entries) {
    for (const handle of [false, true]) {
        test(`${entry.sourceKey} preserves original input, output and calls with ${handle ? 'Page' : 'numeric pageId'}`, async () => {
            const md = readFileSync(new URL(`../helpers/${entry.sourceKey}.md`, import.meta.url), 'utf8');
            const context = () => ({ Date: { now: () => 1 }, Math: Object.assign(Object.create(Math), { random: () => 0.5 }), setTimeout, clearTimeout });
            const original = runInNewContext(`(${extractSource(md)})`, context());
            const adapted = runInNewContext(`(${helperSource(entry.sourceKey, erp).source})`, context());
            const input = entry.originalName === 'erpApi' ? { op: 'ping' }
                : entry.originalName === 'imPreviews' ? ['SHOP-A', 'SHOP-B']
                    : entry.originalName === 'searchCandidates' ? 'MODEL-A' : 'SHOP-A';
            const exercise = async (fn, pageArg) => {
                const calls = [];
                const page = {
                    id: 42,
                    evaluate: async (callback, arg) => {
                        calls.push({ op: 'evaluate', source: String(callback), arg });
                        if (entry.originalName === 'erpApi') {
                            // Simulate no-token login: actual helper handles the failure and performs no HTTP.
                            return arg?.method ? { login: true, reason: 'no-token' } : true;
                        }
                        if (entry.originalName === 'searchCandidates') return { value: [[1, 'anonymous-product', 10, 0, 1, 0, 0]] };
                        return { value: { test: entry.sourceKey, input: arg } };
                    },
                    waitForTime: async (ms) => { calls.push({ op: 'waitForTime', ms }); },
                };
                const browser = { page: (id) => { assert.equal(id, 42); calls.push({ op: 'page', id }); return page; } };
                const output = await fn(browser, pageArg, input);
                return plain({ output, calls });
            };
            const expected = await exercise(original, 42);
            const actual = await exercise(adapted, handle ? { id: 42 } : 42);
            assert.deepEqual(actual, expected);
            if (entry.originalName === 'erpApi') {
                assert.equal(actual.output.error, 'ERP_LOGIN');
                const request = actual.calls.find((call) => call.arg?.method);
                assert.equal(request.arg.method, 'GET');
                assert.equal(request.arg.url, '/api/v1/inquiry/my-tasks?done=false');
            } else if (entry.originalName === 'imOpenAndRead') {
                assert.equal(actual.output.input.contact, input);
                assert.equal(actual.output.input.headerName, input);
                assert.equal(actual.output.input.mode, 'legacy');
            } else if (entry.originalName === 'searchCandidates') {
                const request = actual.calls.find((call) => call.op === 'evaluate');
                assert.equal(request.arg.model, input);
                assert.equal(request.arg.detailed, false);
                assert.deepEqual(actual.output, [[1, 'anonymous-product', 10, 0, 1, 0, 0]]);
            } else {
                assert.deepEqual(actual.output.input, input);
            }
        });
    }
}

test('page argument validation rejects invalid IDs before touching the browser', async () => {
    const fn = runInNewContext(`(${adaptSource('async (browser, pageId, value) => browser.page(pageId)', 'test/test')})`);
    const browser = { page: () => { assert.fail('must not touch the browser'); } };
    for (const page of [undefined, null, {}, '42', -1, 1.1, NaN, Infinity, { id: '42' }]) {
        await assert.rejects(fn(browser, page, {}), /SKILL_INPUT/);
    }
});

test('ERP fails before page communication when the helper sandbox has no timers', async () => {
    const fn = runInNewContext(`(${helperSource('_erp/erpApi', erp).source})`);
    let calls = 0;
    const browser = { page: () => ({ evaluate: async () => { calls++; throw new Error('must not evaluate'); } }) };
    const result = await fn(browser, 42, { op: 'ping' });
    assert.equal(result.error, 'ERP_HTTP');
    assert.match(result.message, /计时器/);
    assert.equal(calls, 0);
});

const oldPreviewSource = String.raw`async (browser, pageId, keys) => {
  // 只读：返回会话列表中名称包含 keys 的会话预览（名称 / 时间 / 最后一条 / 未读数），不点开、不读其他会话
  const page = browser.page(pageId);
  const res = await page.evaluate((keys) => {
    const d = document.querySelector('iframe').contentDocument; const o = {};
    for (const e of d.querySelectorAll('.conversation-item')) {
      const n = (e.querySelector('.name')?.textContent || '').trim();
      const k = keys.find(k => n.includes(k)); if (k) o[k] = e.innerText.replace(/\n+/g, ' / ').slice(0, 120);
    }
    return o;
  }, keys);
  return res && res.value !== undefined ? res.value : res;
}`;
const previewKey = 'market.m.taobao.com/imPreviews';

test('registered content distinguishes current, known older official, and customized functions per sourceKey', () => {
    const current = helperSource(previewKey);
    assert.equal(compareSource(previewKey, current.source).status, 'current');
    assert.equal(compareSource(previewKey, `---\nname: saved\n---\n\n\`\`\`js\n${current.source}\n\`\`\``).status, 'current');
    const original = extractSource(readFileSync(new URL(`../helpers/${previewKey}.md`, import.meta.url), 'utf8'));
    assert.equal(compareSource(previewKey, original).status, 'current');
    for (const saved of [oldPreviewSource, `\`\`\`js\n${oldPreviewSource}\n\`\`\``, adaptSource(oldPreviewSource, previewKey).replace(/\n/g, '\r\n'),
        `---\nname: saved\n---\n\n\`\`\`js\n${adaptSource(oldPreviewSource, previewKey)}\n\`\`\``]) {
        const result = compareSource(previewKey, saved);
        assert.equal(result.status, 'known-official-older');
        assert.equal(result.action, 'sync');
    }
    const customized = current.source.replace('const res =', '// local improvement\n  const res =');
    assert.equal(compareSource(previewKey, customized).status, 'unknown');
    assert.equal(compareSource(previewKey, customized).action, 'preserve');
    assert.equal(compareSource('air.1688.com/imPreviews', oldPreviewSource).status, 'unknown');
    assert.equal(compareSource(previewKey, '```js\ninvalid\n```').status, 'unknown');
    assert.throws(() => compareSource(previewKey, '```js\ninvalid\n```\n```js\ninvalid\n```'));
    assert.equal(compareSource('_erp/erpApi', 'unknown older ERP', erp).action, 'sync');
    assert.ok(officialHashes['_erp/erpApi'].includes('f51329c2401ac59366a36abafed957acb7a144c3e97c8b70e2bc7f11187b5776'));
    assert.ok(officialHashes['_erp/erpApi'].includes('3d2739343e2bb000225f224b2c73aa60803075d629c0c2e65cd2442c49e8a66b'));
    const erpCurrent = helperSource('_erp/erpApi', erp);
    assert.match(erpCurrent.source, /普通滑块按 references\/execution\.md 一次规则/);
    assert.equal(compareSource('_erp/erpApi', erpCurrent.source, erp).status, 'current');
});

test('the previously registered official 1688 header reader is recognized for automatic DOM-fix update', () => {
    const key = 'air.1688.com/imOpenAndRead';
    assert.ok(officialHashes[key].includes('98a65c0ae0d57d2a2e5c74fd0a45e86016f9008bfb11ce8a069f04bfb1e10b51'));
    assert.ok(officialHashes[key].includes('09a535d8cb57b7d8993771173cdb70e41a9d3958714bc4c136b73f7eb01ba89f'));
    const current = helperSource(key).source;
    assert.equal(compareSource(key, current).status, 'current');
    assert.equal(compareSource(key, current.replace('const contact =', '// local change\n  const contact =')).action, 'preserve');
});

test('compare CLI checks each ordinary/prefixed registration without writing or trusting a name marker', (t) => {
    const f = fixture(t);
    const ordinary = join(f.root, 'ordinary.js');
    const prefixed = join(f.root, 'prefixed.js');
    writeFileSync(ordinary, oldPreviewSource);
    writeFileSync(prefixed, helperSource(previewKey).source.replace('const res =', '// local improvement\n  const res ='));
    const old = JSON.parse(f.cli('compare', previewKey, '--file', ordinary).stdout);
    const local = JSON.parse(f.cli('compare', previewKey, '--file', prefixed).stdout);
    assert.equal(old.action, 'sync');
    assert.equal(local.action, 'preserve');
    assert.equal(readFileSync(ordinary, 'utf8'), oldPreviewSource);
    assert.deepEqual(readdirSync(f.root).sort(), ['ordinary.js', 'prefixed.js']);
    for (const args of [['compare', previewKey], ['compare', previewKey, '--file'], ['compare', previewKey, '--file', join(f.root, 'missing')],
        ['source', previewKey, '--file', ordinary], ['compare', '../SKILL', '--file', ordinary]]) {
        assert.equal(f.cli(...args).status, 2);
    }
});

test('a new CLI process through an installed link reads changed source, and only the following run loads its new registration', async (t) => {
    const f = fixture(t);
    const copy = join(f.root, 'skill-source');
    mkdirSync(join(copy, 'scripts'), { recursive: true });
    cpSync(script, join(copy, 'scripts', 'helpers.mjs'));
    cpSync(new URL('../helpers/', import.meta.url), join(copy, 'helpers'), { recursive: true });
    const alias = join(f.root, 'installed-skill');
    symlinkSync(copy, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedScript = join(alias, 'scripts', 'helpers.mjs');
    const sourceFile = join(copy, 'helpers', `${previewKey}.md`);
    const markdown = readFileSync(sourceFile, 'utf8');
    const source = () => {
        const result = spawnSync(process.execPath, [linkedScript, 'source', previewKey], { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
    };
    writeFileSync(sourceFile, markdown.replace(/```js\r?\n[\s\S]*?\r?\n```/, `\`\`\`js\n${oldPreviewSource}\n\`\`\``));
    const previous = source();
    // 纯fixture变更：副作用自由的函数返回值证明实际执行了新业务内容，不能只检查名称/清单。
    writeFileSync(sourceFile, markdown.replace(/```js\r?\n[\s\S]*?\r?\n```/, '```js\nasync (browser, pageId, keys) => { return { revision: "fixture-v2", keys }; }\n```'));
    const latest = source();
    assert.notEqual(latest.sha256, previous.sha256);
    assert.match(latest.source, /fixture-v2/);
    const saved = join(f.root, 'saved.js');
    writeFileSync(saved, previous.source);
    const oldCompared = spawnSync(process.execPath, [linkedScript, 'compare', previewKey, '--file', saved], { encoding: 'utf8', timeout: 5000 });
    assert.equal(oldCompared.status, 0, oldCompared.stderr);
    assert.equal(JSON.parse(oldCompared.stdout).status, 'known-official-older');
    assert.equal(JSON.parse(oldCompared.stdout).action, 'sync');
    const registry = new Map([[latest.runtimeName, previous.source]]);
    const startRun = () => new Map([...registry].map(([name, code]) => [name, runInNewContext(`(${code})`)]));
    const firstRun = startRun();
    registry.set(latest.runtimeName, latest.source);
    assert.notEqual(String(firstRun.get(latest.runtimeName)), latest.source);
    const followingRun = startRun();
    const result = await followingRun.get(latest.runtimeName)({}, 42, ['target']);
    assert.deepEqual(plain(result), { revision: 'fixture-v2', keys: ['target'] });
    assert.equal(compareSource(previewKey, previous.source).status, 'known-official-older');
    // 源码已更新的CLI读回hash一致才证明同步；旧run快照不被save动作热替换。
    writeFileSync(saved, registry.get(latest.runtimeName));
    const compared = spawnSync(process.execPath, [linkedScript, 'compare', previewKey, '--file', saved], { encoding: 'utf8', timeout: 5000 });
    assert.equal(compared.status, 0, compared.stderr);
    assert.equal(JSON.parse(compared.stdout).status, 'current');
});
