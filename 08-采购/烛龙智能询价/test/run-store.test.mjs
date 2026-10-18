import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const testDir = dirname(fileURLToPath(import.meta.url));
const now = () => new Date().toISOString();
const facts = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['schemaVersion', 'runId', 'skillVersion', 'revision', 'eventSeq', 'createdAt', 'updatedAt'].includes(key)));
function fixture(t) {
    const root = mkdtempSync(join(testDir, '.run-store-test-')), home = join(root, 'home'), skill = join(root, 'skill');
    mkdirSync(home); mkdirSync(skill);
    cpSync(join(source, 'scripts'), join(skill, 'scripts'), { recursive: true });
    for (const name of ['SKILL.md', 'settings.json']) copyFileSync(join(source, name), join(skill, name));
    const env = { ...process.env, HOME: home, USERPROFILE: home }, script = join(skill, 'scripts', 'records.mjs');
    assert.equal(resolve(spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { env, encoding: 'utf8' }).stdout), resolve(home));
    const data = join(home, '.zhul-trade-sourcing'), runs = join(data, 'runs'), pending = join(data, '.records-pending.json');
    const lock = join(home, '.zhul-trade-sourcing.lifecycle.lock');
    const cli = (args, injection = '') => spawnSync(process.execPath, [...(injection ? ['--import', 'data:text/javascript,' + encodeURIComponent(injection)] : []), script, ...args], { env, encoding: 'utf8', timeout: 15000 });
    const ok = (...args) => { const p = cli(args); assert.equal(p.status, 0, p.stderr || p.error?.message); return p.stdout; };
    const json = (...args) => JSON.parse(ok(...args));
    let serial = 0;
    const input = value => { const path = join(root, `input-${++serial}.json`); writeFileSync(path, JSON.stringify(value)); return path; };
    const read = dir => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    const timeline = () => readdirSync(runs).filter(n => /^timeline-\d{8}\.log$/.test(n)).sort().flatMap(n => readFileSync(join(runs, n), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
    const open = task => json('open-run', task);
    const request = (dir, event, extra = {}) => ({ runId: read(dir).runId, eventId: `event-${++serial}`, actor: 'main', event, ...extra });
    const event = (dir, value, extra = {}) => { const req = request(dir, value, extra); const path = input(req); return { req, path, result: json('event', dir, path) }; };
    const bind = (task = 'IQ-OBS') => {
        const { runDir: dir } = open(task), run = read(dir);
        const snapshot = { ...facts(run), taskId: 123, items: [{ itemId: 11, model: 'MODEL-A', quantity: 2 }, { itemId: 22, model: 'MODEL-B' }], platforms: ['淘宝', '1688'] };
        const req = request(dir, { eventType: 'task.read', phase: 'task' }, { scope: 'run', expectedRevision: 0, snapshot });
        json('checkpoint', dir, input(req)); return dir;
    };
    const platformInput = (dir, platform, extra = {}) => request(dir, { eventType: 'shop.selected', phase: 'selection', itemIds: [11], shop: '匿名测试店' }, {
        actor: platform, scope: 'platform', platform, expectedRevision: 0,
        snapshot: { platform, status: 'running', shops: [], noStock: [], stages: {}, ...extra },
    });
    const background = (args, injection = '') => {
        const child = spawn(process.execPath, [...(injection ? ['--import', 'data:text/javascript,' + encodeURIComponent(injection)] : []), script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
        const done = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', status => resolveExit({ status, stdout, stderr })); });
        t.after(() => { if (child.exitCode === null && !child.killed) child.kill(); });
        return { child, done, get stdout() { return stdout; }, get stderr() { return stderr; } };
    };
    t.after(() => {
        assert.equal(dirname(resolve(root)), resolve(testDir)); assert.ok(basename(root).startsWith('.run-store-test-'));
        rmSync(root, { recursive: true, force: true });
    });
    json('init');
    return { root, home, skill, script, env, data, runs, pending, lock, cli, ok, json, input, read, timeline, open, request, event, bind, platformInput, background };
}
const hook = body => `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; ${body}; syncBuiltinESMExports();`;

test('managed creation uses actual version, semantic event binding and metadata ownership', t => {
    const f = fixture(t), dir = f.bind(), run = f.read(dir), rows = f.timeline();
    assert.equal(run.skillVersion, readFileSync(join(f.skill, 'SKILL.md'), 'utf8').match(/^version: (.+)$/m)[1].trim());
    assert.equal(run.schemaVersion, 1); assert.equal(run.revision, 1); assert.equal(run.eventSeq, 2);
    assert.deepEqual(rows.map(r => r.eventType), ['run.created', 'task.read']);
    assert.deepEqual(rows[1].itemIds, [11, 22]); assert.deepEqual(rows[1].models, ['MODEL-A', 'MODEL-B']);
    assert.equal(rows[1].taskId, 123); assert.equal(rows[1].skillVersion, run.skillVersion);
    assert.equal(rows[1].actor, 'main'); assert.equal(rows[1].platform, null);
    const req = f.request(dir, { eventType: 'run.resumed', phase: 'recovery' }, { scope: 'run', expectedRevision: 1, snapshot: { ...run, runId: 'forged' } });
    assert.match(f.cli(['checkpoint', dir, f.input(req)]).stderr, /RUN_METADATA/);
    assert.deepEqual(f.read(dir), run);
});

test('same eventId replay is stable, changed payload rejects, event cannot mutate business state', t => {
    const f = fixture(t), dir = f.bind(), before = facts(f.read(dir));
    const { path, result } = f.event(dir, { eventType: 'run.resumed', phase: 'recovery', outcome: 'reconciled' });
    assert.equal(f.json('event', dir, path).replayed, true);
    assert.equal(f.timeline().filter(r => r.eventId === result.eventId).length, 1);
    const changed = JSON.parse(readFileSync(path)); changed.event.outcome = 'different'; writeFileSync(path, JSON.stringify(changed));
    assert.match(f.cli(['event', dir, path]).stderr, /EVENT_CONFLICT/);
    f.event(dir, { eventType: 'erp.verify', phase: 'erp', correlationId: 'payload-one', outcome: 'submitted' });
    assert.deepEqual(facts(f.read(dir)), before); assert.equal(f.read(dir).submitted, false);
});

test('two platforms and main write concurrently without lost timeline or unrelated revision conflicts', async t => {
    const f = fixture(t), dir = f.bind();
    const requests = ['淘宝', '1688'].map(p => f.platformInput(dir, p));
    requests.push(f.request(dir, { eventType: 'run.resumed', phase: 'recovery' }));
    const children = requests.map((req, i) => f.background([i < 2 ? 'checkpoint' : 'event', dir, f.input(req)]));
    for (const p of await Promise.all(children.map(p => p.done))) assert.equal(p.status, 0, p.stderr);
    assert.equal(f.read(dir).revision, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'run-淘宝.json'))).revision, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'run-1688.json'))).revision, 1);
    const rows = f.timeline(); assert.deepEqual(rows.map(r => r.seq), [1, 2, 3, 4, 5]);
    assert.equal(new Set(rows.map(r => r.eventId)).size, 5);
});

test('same-scope CAS rejects stale snapshot; merge invalidates stale main and protects platform aggregates', async t => {
    const f = fixture(t), dir = f.bind(), initial = f.read(dir);
    const a = f.request(dir, { eventType: 'run.resumed', phase: 'recovery' }, { scope: 'run', expectedRevision: 1, snapshot: { ...facts(initial), stopAfterTask: true } });
    const b = { ...a, eventId: 'competing-event' };
    const outcomes = await Promise.all([a, b].map(req => f.background(['checkpoint', dir, f.input(req)]).done));
    assert.equal(outcomes.filter(p => p.status === 0).length, 1); assert.match(outcomes.find(p => p.status !== 0).stderr, /REVISION_CONFLICT/);
    const stale = f.read(dir);
    const p = f.platformInput(dir, '淘宝', { status: 'completed', stages: { repliesDone: now() }, shops: [{ shop: '匿名店', itemIds: [11], status: '未回复', quotes: [] }] });
    f.json('checkpoint', dir, f.input(p)); f.ok('merge', dir, '--partial', '淘宝');
    const req = f.request(dir, { eventType: 'run.resumed', phase: 'recovery' }, { scope: 'run', expectedRevision: stale.revision, snapshot: facts(stale) });
    assert.match(f.cli(['checkpoint', dir, f.input(req)]).stderr, /REVISION_CONFLICT/);
    req.expectedRevision = f.read(dir).revision;
    assert.match(f.cli(['checkpoint', dir, f.input(req)]).stderr, /CHECKPOINT_OWNER/);
    assert.equal(f.read(dir).shops.length, 1);
});

test('event schema rejects wrong model, actor/platform, timing and fabricated signal receipt', t => {
    const f = fixture(t), dir = f.bind(), count = f.timeline().length;
    const cases = [
        [{ eventType: 'shop.selected', phase: 'selection', itemIds: [99], shop: '店' }, { actor: '淘宝' }],
        [{ eventType: 'erp.submit', phase: 'erp', correlationId: 'p', outcome: 'sent' }, { actor: '淘宝' }],
        [{ eventType: 'shop.selected', phase: 'selection', itemIds: [11], shop: '店', platform: '1688' }, { actor: '淘宝' }],
        [{ eventType: 'message.intent', phase: 'messaging', itemIds: [11], shop: '店' }, { actor: '淘宝' }],
        [{ eventType: 'stage.measured', phase: 'timing', elapsedMs: -1 }, {}],
        [{ eventType: 'stage.measured', phase: 'timing', elapsedMs: 1, correlationId: 'nav', stage: 'unknown' }, {}],
        [{ eventType: 'control.signal', phase: 'control', signal: { id: 's1', name: 'stop', from: 'main', to: '淘宝', status: 'received' } }, {}],
        [{ eventType: 'human.verified', phase: 'human' }, {}],
        [{ eventType: 'message.intent', phase: 'messaging', platform: '淘宝', itemIds: [11], shop: '店', messageId: 'm', text: 'chat raw' }, {}],
    ];
    for (const [event, extra] of cases) assert.notEqual(f.cli(['event', dir, f.input(f.request(dir, event, extra))]).status, 0);
    assert.equal(f.timeline().length, count);
    for (const [actor, status] of [['main', 'sent'], ['淘宝', 'received'], ['淘宝', 'applied']]) f.event(dir, { eventType: 'control.signal', phase: 'control', signal: { id: 's1', name: 'stop', from: 'main', to: '淘宝', status } }, { actor });
    f.event(dir, { eventType: 'stage.measured', phase: 'timing', stage: 'navigation', correlationId: 'nav', elapsedMs: 120, toolCalls: 1 });
    assert.equal(f.read(dir).stopAfterTask, undefined);
});

for (const stage of ['before-pending', 'after-pending', 'after-run', 'after-timeline', 'before-delete']) test(`exception recovery is atomic and idempotent: ${stage}`, t => {
    const f = fixture(t), dir = f.bind(), before = f.read(dir);
    const req = f.request(dir, { eventType: 'run.resumed', phase: 'recovery', outcome: stage });
    const path = f.input(req);
    let body;
    if (stage === 'before-delete') body = `const old=fs.unlinkSync; fs.unlinkSync=(p,...a)=>{if(String(p)===${JSON.stringify(f.pending)})throw new Error('injected-stop'); return old(p,...a)}`;
    else body = `const old=fs.renameSync; fs.renameSync=(a,b)=>{const p=String(b); if(${stage === 'before-pending' ? `p===${JSON.stringify(f.pending)}` : 'false'})throw new Error('injected-stop'); const result=old(a,b); if(${stage === 'after-pending' ? `p===${JSON.stringify(f.pending)}` : stage === 'after-run' ? `p===${JSON.stringify(join(dir, 'run.json'))}` : `p.includes("timeline-") && p.endsWith(".log")`})throw new Error('injected-stop'); return result}`;
    const p = f.cli(['event', dir, path], hook(body)); assert.notEqual(p.status, 0); assert.match(p.stderr, /injected-stop/);
    if (stage === 'before-pending') { assert.equal(existsSync(f.pending), false); assert.deepEqual(f.read(dir), before); }
    else {
        assert.equal(existsSync(f.pending), true);
        const bytes = readFileSync(f.pending, 'utf8'); assert.match(f.cli(['erp-items', join(dir, 'run.json'), '--draft']).stderr, /RUN_RECOVERY_REQUIRED/); assert.equal(readFileSync(f.pending, 'utf8'), bytes);
    }
    const result = f.json('event', dir, path); assert.equal(result.replayed, stage !== 'before-pending');
    assert.equal(existsSync(f.pending), false); assert.equal(f.timeline().filter(r => r.eventId === req.eventId).length, 1);
    assert.equal(f.read(dir).eventSeq, before.eventSeq + 1); assert.deepEqual(facts(f.read(dir)), facts(before));
});

test('third-state conflict is detected across all targets before any recovery mutation', t => {
    const f = fixture(t), dir = f.bind(), before = readFileSync(join(dir, 'run.json'), 'utf8');
    const req = f.request(dir, { eventType: 'run.resumed', phase: 'recovery' });
    const injection = hook(`const old=fs.renameSync; fs.renameSync=(a,b)=>{const r=old(a,b);if(String(b)===${JSON.stringify(f.pending)})throw new Error('injected-stop');return r}`);
    assert.notEqual(f.cli(['event', dir, f.input(req)], injection).status, 0);
    const tx = JSON.parse(readFileSync(f.pending)), last = tx.targets.at(-1); writeFileSync(join(f.data, last.path), 'external-change\n');
    assert.match(f.cli(['open-run', 'IQ-OBS']).stderr, /RUN_CONFLICT/);
    assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before); assert.equal(existsSync(f.pending), true); assert.equal(readFileSync(join(f.data, last.path), 'utf8'), 'external-change\n');
});

test('real killed process leaves lock and committed pending; proven-dead isolated owner can be recovered once', async t => {
    const f = fixture(t), dir = f.bind(), ready = join(f.root, 'kill-ready');
    const req = f.request(dir, { eventType: 'run.interrupted', phase: 'recovery', reason: 'controlled process termination' }), path = f.input(req);
    const injection = hook(`const old=fs.renameSync;fs.renameSync=(a,b)=>{const r=old(a,b);if(String(b)===${JSON.stringify(f.pending)}){fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300000)}return r}`);
    const p = f.background(['event', dir, path], injection), until = Date.now() + 15000;
    while (!existsSync(ready) && p.child.exitCode === null && Date.now() < until) await new Promise(r => setTimeout(r, 20));
    assert.equal(existsSync(ready), true); assert.equal(Number(readFileSync(ready, 'utf8')), p.child.pid);
    p.child.kill('SIGKILL'); await p.done;
    assert.equal(existsSync(f.lock), true); assert.equal(existsSync(f.pending), true);
    assert.match(f.cli(['init']).stderr, /DATA_BUSY/);
    // 只清本测试已确认退出的自建进程锁；生产环境不得自动删除未知锁。
    assert.ok(p.child.exitCode !== null || p.child.signalCode !== null); unlinkSync(f.lock);
    assert.equal(f.json('event', dir, path).replayed, true); assert.equal(f.json('event', dir, path).replayed, true);
    assert.equal(f.timeline().filter(r => r.eventId === req.eventId).length, 1); assert.equal(existsSync(f.pending), false);
});

test('finish business hash ignores metadata events and pending repairs all archive outputs without duplicate rows', t => {
    const f = fixture(t), dir = f.bind(), run = f.read(dir);
    const p = f.platformInput(dir, '淘宝', { status: 'completed', stages: { repliesDone: now() }, shops: [{ shop: '匿名店', itemIds: [11], sentAt: now(), status: '已回复', quotes: [{ itemId: 11, price: 100 }] }] });
    f.json('checkpoint', dir, f.input(p)); f.ok('merge', dir, '--partial', '淘宝');
    const injection = hook(`const old=fs.renameSync; fs.renameSync=(a,b)=>{const r=old(a,b);if(String(b)===${JSON.stringify(join(f.data, 'records.jsonl'))})throw new Error('archive-stop');return r}`);
    assert.notEqual(f.cli(['finish', join(dir, 'run.json')], injection).status, 0);
    f.ok('finish', join(dir, 'run.json')); f.event(dir, { eventType: 'run.resumed', phase: 'recovery' });
    f.ok('finish', relative(process.cwd(), join(dir, 'run.json')));
    f.ok('finish', join(dir, 'run.json').replaceAll('\\', '/'));
    for (const name of ['records.jsonl', 'processed-tasks.jsonl']) assert.equal(readFileSync(join(f.data, name), 'utf8').trim().split('\n').length, 1);
    assert.equal(f.timeline().filter(r => r.eventType === 'run.archived').length, 1);
    assert.equal(f.read(dir).runId, run.runId);
});

test('upgrade rebuilds run/timeline/pending, stale copied writer and stale same-version runId reject', t => {
    const f = fixture(t), dir = f.bind(), prior = f.read(dir), oldSkill = join(f.root, 'old-skill'); cpSync(f.skill, oldSkill, { recursive: true });
    const path = f.input(f.request(dir, { eventType: 'run.resumed', phase: 'recovery' }));
    const skillFile = join(f.skill, 'SKILL.md'); writeFileSync(skillFile, readFileSync(skillFile, 'utf8').replace(/^version: .+$/m, 'version: 999.0.0'));
    assert.equal(f.json('init').dataRebuilt, true); assert.equal(existsSync(dir), false); assert.equal(f.timeline().length, 0);
    const next = f.open('IQ-OBS'); assert.notEqual(next.runId, prior.runId); assert.equal(next.skillVersion, '999.0.0');
    const stale = spawnSync(process.execPath, [join(oldSkill, 'scripts', 'records.mjs'), 'event', dir, path], { env: f.env, encoding: 'utf8', timeout: 15000 });
    assert.match(stale.stderr, /DATA_NEWER_VERSION/); assert.equal(existsSync(dir), false);
    assert.match(f.cli(['event', next.runDir, path]).stderr, /RUN_ID/);
    assert.equal(f.timeline().length, 1);
});

test('skip/manual without a run preserve known task facts without inventing a business run', t => {
    const f = fixture(t); f.ok('skip', 'IQ-CANCEL', '已取消'); f.ok('manual', 'IQ-MANUAL', '需人工确认');
    const rows = f.timeline(); assert.deepEqual(rows.map(r => r.eventType), ['task.skipped', 'task.manual']);
    for (const row of rows) { assert.equal(row.runId, null); assert.equal(row.seq, null); assert.equal(row.taskId, null); assert.deepEqual(row.itemIds, []); }
    assert.deepEqual(readdirSync(f.runs).filter(n => !n.startsWith('timeline-')), []);
});

test('empty directory from pre-pending new-run failure does not block a fresh run', t => {
    const f = fixture(t);
    const injection = hook(`const old=fs.renameSync;fs.renameSync=(a,b)=>{if(String(b)===${JSON.stringify(f.pending)})throw new Error('pre-commit-stop');return old(a,b)}`);
    assert.notEqual(f.cli(['open-run', 'IQ-EMPTY'], injection).status, 0); assert.equal(existsSync(f.pending), false);
    assert.equal(f.open('IQ-EMPTY').resumed, false);
});

test('pending path and identity corruption rejects before writes and preserves outside sentinel', t => {
    const f = fixture(t), dir = f.bind(), before = readFileSync(join(dir, 'run.json'), 'utf8');
    const injection = hook(`const old=fs.renameSync;fs.renameSync=(a,b)=>{const r=old(a,b);if(String(b)===${JSON.stringify(f.pending)})throw new Error('stop');return r}`);
    f.cli(['event', dir, f.input(f.request(dir, { eventType: 'run.resumed', phase: 'recovery' }))], injection);
    const original = JSON.parse(readFileSync(f.pending)), outside = join(f.home, 'outside.txt'); writeFileSync(outside, 'keep');
    const variants = [
        tx => { tx.targets.at(-1).path = '../outside.txt'; },
        tx => { tx.targets.push(tx.targets[0]); },
        tx => { tx.targets[0].newHash = 'bad'; },
        tx => { tx.runId = 'wrong'; },
        tx => { tx.skillVersion = '0.0.1'; },
        tx => { const target = { ...tx.targets[0], path: 'runs/OTHER/run.json', beforeHash: null }; tx.targets.push(target); },
    ];
    for (const mutate of variants) {
        const tx = structuredClone(original); mutate(tx); writeFileSync(f.pending, JSON.stringify(tx));
        assert.notEqual(f.cli(['open-run', 'IQ-OBS']).status, 0); assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before); assert.equal(readFileSync(outside, 'utf8'), 'keep');
    }
    writeFileSync(f.pending, JSON.stringify(original)); f.open('IQ-OBS'); assert.equal(existsSync(f.pending), false);
});

test('draft receipt unknown blocks both payload paths; confirmed requires exact verification evidence', t => {
    const f = fixture(t), dir = f.bind();
    const payload = { taskId: 123, items: [{ itemId: 11, quotes: [] }], skipItemIds: [] };
    const base = { at: now(), payload, expectedSnapshot: { taskId: 123, items: [{ itemId: 11 }] } };
    const save = receipt => {
        const run = f.read(dir), snapshot = { ...facts(run), draftReceipt: receipt };
        return f.cli(['checkpoint', dir, f.input(f.request(dir, { eventType: 'erp.draft', phase: 'erp', correlationId: 'draft-payload', outcome: receipt.state }, { scope: 'run', expectedRevision: run.revision, snapshot }))]);
    };
    for (const state of ['pending', 'unknown', 'failed']) {
        assert.equal(save({ ...base, state }).status, 0);
        for (const suffix of [[], ['--draft']]) assert.match(f.cli(['erp-items', join(dir, 'run.json'), ...suffix]).stderr, /草稿写入已发或结果未确认/);
    }
    assert.notEqual(save({ ...base, state: 'not_sent' }).status, 0);
    assert.equal(save({ ...base, state: 'not_sent', writeAttempted: false }).status, 0);
    assert.equal(f.cli(['erp-items', join(dir, 'run.json'), '--draft']).status, 0);
    assert.notEqual(save({ ...base, state: 'confirmed' }).status, 0);
    assert.equal(save({ ...base, state: 'confirmed', verifiedAt: now(), verify: { ok: true, mismatches: [] }, verifiedItemIds: [11], snapshot: { taskId: 123, items: [{ itemId: 11 }] } }).status, 0);
    assert.equal(f.cli(['erp-items', join(dir, 'run.json'), '--draft']).status, 0);
});

test('message checkpoint links stable ID and kind while main incidents preserve platform events', t => {
    const f = fixture(t), dir = f.bind();
    const req = f.platformInput(dir, '淘宝', { incidents: [{ time: now(), type: 'technical', detail: 'platform interruption' }], shops: [{ shop: '匿名店', itemIds: [11], status: '未回复', quotes: [], pendingMessage: { messageId: 'message-one', kind: 'initial', text: '测试询价', preparedAt: now(), state: 'pending' } }] });
    req.event = { eventType: 'message.intent', phase: 'messaging', itemIds: [11], shop: '匿名店', messageId: 'wrong', messageKind: 'initial' };
    assert.match(f.cli(['checkpoint', dir, f.input(req)]).stderr, /EVENT_MESSAGE/);
    req.event.messageId = 'message-one'; assert.equal(f.cli(['checkpoint', dir, f.input(req)]).status, 0);
    const row = f.timeline().at(-1); assert.equal(row.messageId, 'message-one'); assert.equal(row.messageKind, 'initial'); assert.equal('text' in row, false);
    f.ok('merge', dir, '--partial', '淘宝');
    const run = f.read(dir), incidents = [...run.incidents, { time: now(), type: 'ERP', detail: 'main observation' }];
    const main = f.request(dir, { eventType: 'error', phase: 'recovery', reason: 'ERP unavailable' }, { scope: 'run', expectedRevision: run.revision, snapshot: { ...facts(run), incidents } });
    assert.equal(f.cli(['checkpoint', dir, f.input(main)]).status, 0);
    main.eventId = 'erase-platform'; main.expectedRevision = f.read(dir).revision; main.snapshot.incidents = incidents.filter(i => !i.platform);
    assert.match(f.cli(['checkpoint', dir, f.input(main)]).stderr, /CHECKPOINT_OWNER/);
    assert.equal(f.read(dir).incidents.length, 2);
});

test('bound task deadlines cannot be replaced or omitted and Windows forward-slash run paths work', t => {
    const f = fixture(t), dir = f.bind(), run = f.read(dir);
    const snapshot = { ...facts(run), deadline: '2026-11-01T10:00:00.000Z', quoteDeadline: '2026-11-01' };
    const request = f.request(dir, { eventType: 'run.resumed', phase: 'recovery' }, { scope: 'run', expectedRevision: run.revision, snapshot });
    f.json('checkpoint', dir, f.input(request));
    const before = readFileSync(join(dir, 'run.json'), 'utf8');
    for (const patch of [{ deadline: '2026-12-01T10:00:00.000Z' }, { deadline: undefined }, { quoteDeadline: undefined }]) {
        const req = { ...request, eventId: JSON.stringify(patch), expectedRevision: f.read(dir).revision, snapshot: { ...snapshot, ...patch } };
        assert.match(f.cli(['checkpoint', dir, f.input(req)]).stderr, /RUN_DEADLINE/);
        assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
    }
    assert.equal(f.cli(['erp-items', join(dir, 'run.json').replaceAll('\\', '/'), '--draft']).status, 0);
});

test('wrong-recipient correction uses an incident, keeps original intent and guards pending completion/submission', t => {
    const f = fixture(t), dir = f.bind();
    const original = { messageId: 'original-intent', kind: 'initial', text: '测试询价', preparedAt: now(), state: 'pending' };
    const correction = { type: 'message.correction', targetShop: '非候选误收店', itemIds: [11], detail: 'mis-send-one',
        pendingMessage: { messageId: 'correction-one', kind: 'correction', text: '不好意思，发错了。', preparedAt: now(), state: 'pending' } };
    const snapshot = { platform: '淘宝', status: 'running', stages: {}, noStock: [], incidents: [correction], shops: [
        { shop: '原目标店', itemIds: [11], status: '未回复', quotes: [], pendingMessage: original },
        { shop: '真实报价店', itemIds: [11], sentAt: now(), status: '已回复', quotes: [{ itemId: 11, price: 100 }] },
    ] };
    const save = (eventType, shop = correction.targetShop, message = correction.pendingMessage) => {
        const partPath = join(dir, 'run-淘宝.json'), revision = existsSync(partPath) ? JSON.parse(readFileSync(partPath)).revision : 0;
        return f.cli(['checkpoint', dir, f.input(f.request(dir, { eventType, phase: 'messaging', itemIds: [11], shop, messageId: message.messageId, messageKind: message.kind, correlationId: 'mis-send-one' }, {
            scope: 'platform', platform: '淘宝', actor: '淘宝', expectedRevision: revision, snapshot,
        }))]);
    };
    assert.equal(save('message.intent').status, 0);
    assert.equal(save('message.unknown').status, 0);
    snapshot.status = 'completed'; snapshot.stages = { repliesDone: now() };
    assert.notEqual(save('message.unknown').status, 0);
    snapshot.status = 'running'; snapshot.stages = {};
    f.ok('merge', dir, '--partial', '淘宝');
    assert.equal(f.cli(['erp-items', join(dir, 'run.json'), '--draft']).status, 0);
    assert.match(f.cli(['erp-items', join(dir, 'run.json')]).stderr, /未确认更正/);
    correction.pendingMessage.state = 'confirmed'; correction.pendingMessage.confirmedAt = now();
    assert.equal(save('message.confirmed').status, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'run-淘宝.json'))).shops[0].pendingMessage.state, 'pending');
    original.state = 'cancelled'; assert.equal(save('message.cancelled', '原目标店', original).status, 0);
    snapshot.status = 'completed'; snapshot.stages = { repliesDone: now() };
    assert.equal(save('message.confirmed').status, 0);
    const other = f.platformInput(dir, '1688', { status: 'completed', skipped: '用户本次不用', stages: {} });
    other.event = { eventType: 'platform.completed', phase: 'platform' }; f.json('checkpoint', dir, f.input(other));
    f.ok('merge', dir); assert.equal(f.cli(['erp-items', join(dir, 'run.json')]).status, 0);
    f.ok('finish', join(dir, 'run.json'));
    const archived = readFileSync(join(f.data, 'records.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(archived.map(row => row.shop), ['真实报价店']);
    assert.equal(f.timeline().filter(row => row.messageId === 'correction-one').every(row => row.shop === '非候选误收店'), true);
    // 已明确取消的另一条更正也可合法收尾，不以删除未知意图代表取消。
    correction.pendingMessage = { messageId: 'correction-cancelled', kind: 'correction', text: '不好意思，发错了。', preparedAt: now(), state: 'cancelled' };
    assert.equal(save('message.cancelled').status, 0);
});

const waitFile = async (path, child) => {
    const until = Date.now() + 15000;
    while (!existsSync(path) && child.exitCode === null && Date.now() < until) await new Promise(r => setTimeout(r, 10));
    assert.equal(existsSync(path), true, `handshake not reached: ${path}`);
};
const waitRelease = path => `const until=Date.now()+10000;while(!fs.existsSync(${JSON.stringify(path)})){if(Date.now()>until)throw new Error('handshake timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}`;

test('background watch takes a short complete read lock and never reports partial transaction completion', async t => {
    const f = fixture(t), dir = f.bind();
    const taobao = f.platformInput(dir, '淘宝'), other = f.platformInput(dir, '1688', { status: 'completed', skipped: '用户不用', stages: {} });
    f.json('checkpoint', dir, f.input(taobao)); f.json('checkpoint', dir, f.input(other));
    const ready = join(f.root, 'reader-ready'), release = join(f.root, 'reader-release');
    const writerReady = join(f.root, 'writer-ready'), writerRelease = join(f.root, 'writer-release');
    const readerHook = hook(`const interval=globalThis.setInterval;globalThis.setInterval=(fn)=>interval(fn,30);const old=fs.readFileSync;let held=false;fs.readFileSync=(p,...a)=>{if(!held&&String(p)===${JSON.stringify(join(dir, 'run-淘宝.json'))}){held=true;fs.writeFileSync(${JSON.stringify(ready)},'ready');${waitRelease(release)}}return old(p,...a)}`);
    const reader = f.background(['watch', dir], readerHook); await waitFile(ready, reader.child);
    taobao.expectedRevision = 1; taobao.eventId = 'platform-completing'; taobao.event = { eventType: 'platform.completed', phase: 'platform' }; taobao.snapshot.status = 'completed'; taobao.snapshot.stages = { repliesDone: now() };
    const writerHook = hook(`const old=fs.renameSync;fs.renameSync=(a,b)=>{const r=old(a,b);if(String(b)===${JSON.stringify(join(dir, 'run-淘宝.json'))}){fs.writeFileSync(${JSON.stringify(writerReady)},'ready');${waitRelease(writerRelease)}}return r}`);
    const writer = f.background(['checkpoint', dir, f.input(taobao)], writerHook);
    await new Promise(r => setTimeout(r, 120)); assert.equal(existsSync(writerReady), false); assert.equal(existsSync(f.pending), false);
    writeFileSync(release, 'release'); await waitFile(writerReady, writer.child);
    assert.equal(existsSync(f.pending), true); assert.equal(reader.stdout, '');
    writeFileSync(writerRelease, 'release'); const [w, r] = await Promise.all([writer.done, reader.done]);
    assert.equal(w.status, 0, w.stderr); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).result, 'finished');
});

test('next reads processed history and run scan under one lock, and uninitialized lookup creates no data', async t => {
    const f = fixture(t), dir = f.bind(), processed = join(f.data, 'processed-tasks.jsonl'); writeFileSync(processed, '');
    const ready = join(f.root, 'next-reader'), release = join(f.root, 'next-release'), writerReady = join(f.root, 'next-writer');
    const readerHook = hook(`const old=fs.readFileSync;let held=false;fs.readFileSync=(p,...a)=>{if(!held&&String(p)===${JSON.stringify(processed)}){held=true;fs.writeFileSync(${JSON.stringify(ready)},'ready');${waitRelease(release)}}return old(p,...a)}`);
    const reader = f.background(['next', 'IQ-OBS', 'IQ-NEXT'], readerHook); await waitFile(ready, reader.child);
    const writerHook = hook(`const old=fs.renameSync;fs.renameSync=(a,b)=>{const r=old(a,b);if(String(b)===${JSON.stringify(f.pending)})fs.writeFileSync(${JSON.stringify(writerReady)},'ready');return r}`);
    const writer = f.background(['skip', 'IQ-OBS', '用户取消'], writerHook);
    await new Promise(r => setTimeout(r, 120)); assert.equal(existsSync(writerReady), false);
    writeFileSync(release, 'release'); const [r, w] = await Promise.all([reader.done, writer.done]);
    assert.equal(r.status, 0, r.stderr); assert.equal(w.status, 0, w.stderr); assert.equal(JSON.parse(r.stdout).next, 'IQ-OBS');
    assert.equal(f.json('next', 'IQ-OBS', 'IQ-NEXT').next, 'IQ-NEXT');
    assert.equal(f.read(dir).task, 'IQ-OBS');
    const newHome = join(f.root, 'no-init-home'); mkdirSync(newHome);
    const p = spawnSync(process.execPath, [f.script, 'next', 'IQ-UNINITIALIZED'], { env: { ...f.env, HOME: newHome, USERPROFILE: newHome }, encoding: 'utf8', timeout: 15000 });
    assert.equal(p.status, 0, p.stderr); assert.equal(JSON.parse(p.stdout).next, 'IQ-UNINITIALIZED'); assert.deepEqual(readdirSync(newHome), []);
});

test('background watch reports current stopAfterTask and exits clearly when a pending transaction appears', async t => {
    const f = fixture(t), dir = f.bind();
    for (const p of ['淘宝', '1688']) f.json('checkpoint', dir, f.input(f.platformInput(dir, p, { status: 'completed', skipped: '用户不用', stages: {} })));
    const preload = hook(`const interval=globalThis.setInterval;globalThis.setInterval=(fn)=>interval(()=>{const p=${JSON.stringify(join(dir, 'run.json'))};const v=JSON.parse(fs.readFileSync(p));v.stopAfterTask=true;fs.writeFileSync(p,JSON.stringify(v));fn()},30)`);
    const watch = await f.background(['watch', dir], preload).done;
    assert.equal(watch.status, 0, watch.stderr); assert.equal(JSON.parse(watch.stdout).stopAfterTask, true);
    const pendingHook = hook(`const interval=globalThis.setInterval;globalThis.setInterval=(fn)=>interval(()=>{fs.writeFileSync(${JSON.stringify(f.pending)},'controlled-pending');fn()},30)`);
    const blocked = await f.background(['watch', dir], pendingHook).done;
    assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /RUN_RECOVERY_REQUIRED/); assert.equal(blocked.stdout, '');
});
