// 受控本地 checkpoint 与每日 JSONL 时间线；pending 只用于跨文件崩溃恢复。
import { existsSync, lstatSync, realpathSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.mjs';
import { currentVersion, compatibleVersion, VERSION_FILE } from './data-lifecycle.mjs';

export const RUNS = join(DATA_DIR, 'runs');
export const PENDING = join(DATA_DIR, '.records-pending.json');
export const META = ['schemaVersion', 'runId', 'skillVersion', 'executionVersion', 'revision', 'eventSeq', 'createdAt', 'updatedAt'];
export const EVENT_PHASES = {
    'task.read': 'task', 'item.selected': 'selection', 'link.processed': 'selection', 'shop.checked': 'selection', 'shop.selected': 'selection', 'shop.skipped': 'selection',
    'inquiry.planned': 'selection',
    'message.intent': 'messaging', 'message.confirmed': 'messaging', 'message.unknown': 'messaging', 'message.cancelled': 'messaging',
    'reply.received': 'messaging', 'quote.recorded': 'messaging', 'shop.ended': 'messaging',
    'human.requested': 'human', 'human.returned': 'human', 'human.verified': 'human',
    'slider.observed': 'human', 'slider.attempted': 'human', 'slider.verified': 'human',
    'control.signal': 'control', 'erp.draft': 'erp', 'erp.submit': 'erp', 'erp.verify': 'erp',
    'platform.completed': 'platform', 'platform.interrupted': 'platform',
    'run.resumed': 'recovery', 'run.interrupted': 'recovery', 'error': 'recovery', 'stage.measured': 'timing',
};
const AUTO_PHASES = { 'run.created': 'task', 'run.opened': 'task', 'task.manual': 'task', 'task.skipped': 'task', 'heartbeat': 'platform', 'platform.merged': 'platform', 'run.archived': 'archive' };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && !!v.trim();
const validTime = v => text(v) && !Number.isNaN(Date.parse(v));
const fail = (code, message) => { throw new Error(`${code}: ${message}`); };
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = path => existsSync(path) ? readFileSync(path, 'utf8') : null;
const canonical = p => process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
export const stable = value => JSON.stringify(value, (_, v) => object(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const business = value => Object.fromEntries(Object.entries(value).filter(([key]) => !META.includes(key)));

function safe(path) {
    let p = resolve(path);
    for (;;) {
        if (existsSync(p)) {
            const s = lstatSync(p);
            if (s.isSymbolicLink() || canonical(realpathSync(p)) !== canonical(p) || (!s.isDirectory() && !s.isFile())) fail('RUN_PATH', `拒绝链接或特殊路径：${p}`);
        }
        if (canonical(p) === canonical(DATA_DIR)) break;
        const parent = dirname(p);
        if (parent === p) fail('RUN_PATH', '路径必须在当前数据目录内');
        p = parent;
    }
}
export function runDirectory(value) {
    const dir = resolve(value);
    if (canonical(dirname(dir)) !== canonical(RUNS) || !basename(dir) || /^timeline-/.test(basename(dir))) fail('RUN_PATH', 'run 必须位于当前个人目录 runs 的独立子目录');
    safe(dir);
    return dir;
}
function versionFields(value) {
    // 创建版本为 2.9/2.10 的旧格式可缺 executionVersion；较新创建版本必须提供。
    return compatibleVersion(value.skillVersion) && (value.executionVersion === undefined
        ? /^2\.(9|10)\./.test(value.skillVersion)
        : compatibleVersion(value.executionVersion) && compatibleVersion(value.skillVersion, value.executionVersion));
}
function checkMeta(run, platform = false) {
    if (!object(run) || run.schemaVersion !== 1 || !text(run.runId) || !versionFields(run)
        || !Number.isSafeInteger(run.revision) || run.revision < 0 || !validTime(run.createdAt) || !validTime(run.updatedAt)
        || !platform && (!Number.isSafeInteger(run.eventSeq) || run.eventSeq < 1)) fail('RUN_VERSION', 'run 身份、版本或记录格式无效；不得把旧 run 洗成当前版本');
    const marker = JSON.parse(readFileSync(VERSION_FILE, 'utf8'));
    if (!compatibleVersion(marker.skillVersion)) fail('RUN_VERSION', '个人目录版本不兼容，请先初始化当前版本');
}
export function readManaged(runDir) {
    const dir = runDirectory(runDir);
    const path = join(dir, 'run.json'); safe(path);
    const run = JSON.parse(readFileSync(path, 'utf8'));
    checkMeta(run);
    return run;
}
export function readPart(runDir, platform, run = readManaged(runDir)) {
    if (!run.platforms?.includes(platform)) fail('RUN_PLATFORM', '平台不在本次任务中');
    const path = join(runDirectory(runDir), `run-${platform}.json`); safe(path);
    if (!existsSync(path)) return null;
    const part = JSON.parse(readFileSync(path, 'utf8')); checkMeta(part, true);
    if (part.runId !== run.runId || part.skillVersion !== run.skillVersion || part.platform !== platform) fail('RUN_ID', '平台快照不属于当前 run');
    return part;
}
export function noPending() {
    if (existsSync(PENDING)) fail('RUN_RECOVERY_REQUIRED', '存在未完成本地事务；停止外部动作，用 records 写入口恢复后重新读取');
}
function targetPath(relative) {
    const path = resolve(DATA_DIR, relative);
    const file = basename(path);
    const allowed = ['records.jsonl', 'processed-tasks.jsonl'].includes(relative)
        || canonical(dirname(path)) === canonical(RUNS) && /^timeline-\d{8}\.log$/.test(file)
        || canonical(dirname(dirname(path))) === canonical(RUNS) && /^(run(?:-(?:淘宝|1688))?\.json|heartbeat-(?:淘宝|1688)\.jsonl)$/.test(file);
    if (!allowed) fail('RUN_TRANSACTION', '事务目标不属于受控记录');
    safe(path); return path;
}
const relative = path => resolve(path).slice(resolve(DATA_DIR).length + 1).replaceAll('\\', '/');
function atomic(path, content) {
    safe(path);
    const temp = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
    try {
        writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
        renameSync(temp, path);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
}
function applyPending(tx) {
    if (!object(tx) || tx.schemaVersion !== 1 || !versionFields(tx) || !(tx.runId === null || text(tx.runId)) || !text(tx.eventId) || !Array.isArray(tx.targets) || !tx.targets.length) fail('RUN_TRANSACTION', 'pending 无法识别，保留现场');
    const targets = tx.targets.map(row => {
        if (!object(row) || !text(row.path) || typeof row.content !== 'string' || row.newHash !== hash(row.content)) fail('RUN_TRANSACTION', 'pending 内容损坏，保留现场');
        const path = targetPath(row.path), current = bytes(path), actual = current === null ? null : hash(current);
        if (actual !== row.beforeHash && actual !== row.newHash) fail('RUN_CONFLICT', '事务目标已被其他写者改变，保留 pending 并停止');
        return { ...row, path, actual };
    });
    if (new Set(targets.map(row => canonical(row.path))).size !== targets.length) fail('RUN_TRANSACTION', 'pending 目标重复');
    const runTargets = targets.filter(row => basename(row.path) === 'run.json'), runTarget = runTargets[0];
    if (tx.runId !== null) {
        if (runTargets.length !== 1) fail('RUN_TRANSACTION', 'pending 必须恰好有一个 run 快照');
        const run = JSON.parse(runTarget.content); checkMeta(run);
        if (run.runId !== tx.runId || run.skillVersion !== tx.skillVersion || (run.executionVersion ?? run.skillVersion) !== (tx.executionVersion ?? tx.skillVersion)) fail('RUN_ID', 'pending 与 run 身份不符');
        for (const row of targets.filter(row => /^(run-|heartbeat-)/.test(basename(row.path)))) if (dirname(row.path) !== dirname(runTarget.path)) fail('RUN_ID', '业务投影不属于当前run目录');
        for (const row of targets.filter(row => /^run-.+\.json$/.test(basename(row.path)))) {
            const part = JSON.parse(row.content); checkMeta(part, true);
            if (part.runId !== run.runId || part.skillVersion !== run.skillVersion || (part.executionVersion ?? part.skillVersion) !== (tx.executionVersion ?? tx.skillVersion) || basename(row.path) !== `run-${part.platform}.json` || !run.platforms.includes(part.platform)) fail('RUN_ID', 'pending 平台身份不符');
        }
    } else if (runTarget || targets.some(row => /^(run-|heartbeat-)/.test(basename(row.path)))) fail('RUN_TRANSACTION', '无run事件不得写业务快照');
    const timelines = targets.filter(row => /^timeline-/.test(basename(row.path)));
    if (timelines.length !== 1) fail('RUN_TRANSACTION', 'pending 必须恰好包含当日日志');
    const last = JSON.parse(timelines[0].content.trim().split('\n').at(-1));
    if (last.eventId !== tx.eventId || last.runId !== tx.runId || last.skillVersion !== tx.skillVersion || (last.executionVersion ?? last.skillVersion) !== (tx.executionVersion ?? tx.skillVersion)) fail('RUN_TRANSACTION', 'pending 事件身份不符');
    for (const row of targets) if (row.actual !== row.newHash) atomic(row.path, row.content);
    unlinkSync(PENDING);
}
export function recoverPending() {
    if (existsSync(PENDING)) { safe(PENDING); applyPending(JSON.parse(readFileSync(PENDING, 'utf8'))); }
}
function events() {
    if (!existsSync(RUNS)) return [];
    return readdirSync(RUNS).filter(name => /^timeline-\d{8}\.log$/.test(name)).sort().flatMap(name => {
        const path = join(RUNS, name); safe(path);
        return readFileSync(path, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    });
}
export function previousEvent(run, eventId, request) {
    const prior = events().find(row => row.runId === run.runId && row.eventId === eventId);
    if (!prior) return null;
    if (prior.requestHash !== hash(stable(request))) fail('EVENT_CONFLICT', 'eventId 已使用且内容不同，不得重放');
    return { runId: run.runId, revision: prior.revision, seq: prior.seq, eventId, replayed: true };
}
export function eventFields(run, actor, event, automatic = false) {
    if (!['main', ...(run.platforms ?? [])].includes(actor)) fail('EVENT_ACTOR', 'actor 必须为 main 或本次平台');
    const phases = automatic ? { ...EVENT_PHASES, ...AUTO_PHASES } : EVENT_PHASES;
    if (!object(event) || !Object.hasOwn(phases, event.eventType) || event.phase !== phases[event.eventType]) fail('EVENT_TYPE', 'eventType/phase 不在允许组合中');
    if ((event.eventType === 'task.read' || event.eventType === 'inquiry.planned' || /^erp\.|^run\./.test(event.eventType)) && actor !== 'main') fail('EVENT_ACTOR', '任务、ERP、询价计划和run事件仅主执行者记录');
    const allowed = ['eventType', 'phase', 'platform', 'occurredAt', 'itemIds', 'outcome', 'reason', 'requestId', 'messageId', 'messageKind', 'correlationId', 'elapsedMs', 'toolCalls', 'stage', 'signal', 'shop'];
    if (Object.keys(event).some(k => !allowed.includes(k))) fail('EVENT_FIELDS', '事件只允许简短结构字段，不接收聊天原文或凭据');
    const platform = event.platform ?? (actor === 'main' ? null : actor);
    if (platform != null && !run.platforms?.includes(platform) || actor !== 'main' && platform !== actor) fail('EVENT_PLATFORM', '事件平台必须属于本次任务且不能冒用别的平台');
    if (/^erp\./.test(event.eventType) && platform !== null) fail('EVENT_PLATFORM', 'ERP事件不属于电商平台');
    if (/^(link\.|shop\.|message\.|reply\.|quote\.|platform\.)/.test(event.eventType) && event.eventType !== 'platform.merged' && platform === null) fail('EVENT_PLATFORM', '平台业务事件必须指定platform');
    if (event.occurredAt != null && !validTime(event.occurredAt)) fail('EVENT_TIME', 'occurredAt 必须为实际有效时间');
    for (const key of ['outcome', 'reason', 'requestId', 'messageId', 'correlationId', 'shop']) if (event[key] != null && (!text(event[key]) || event[key].length > (key === 'reason' ? 500 : 200))) fail('EVENT_FIELDS', `${key} 必须为短字符串`);
    for (const key of ['elapsedMs', 'toolCalls']) if (event[key] != null && (!Number.isFinite(event[key]) || event[key] < 0 || key === 'toolCalls' && !Number.isSafeInteger(event[key]))) fail('EVENT_MEASUREMENT', `${key} 必须为非负实测值`);
    if (!Array.isArray(event.itemIds ?? []) || new Set((event.itemIds ?? []).map(String)).size !== (event.itemIds ?? []).length) fail('EVENT_ITEMS', 'itemIds 必须为无重复数组');
    const ids = event.itemIds ?? (['task.read', 'run.opened', 'run.archived'].includes(event.eventType) ? (run.items ?? []).map(i => i.itemId) : []);
    const selected = ids.map(id => {
        const item = run.items?.find(i => String(i.itemId) === String(id));
        if (!item) fail('EVENT_ITEMS', `itemId ${id} 不属于当前任务`);
        return { itemId: item.itemId, model: item.model };
    });
    if (/^(item\.|link\.|shop\.|message\.|reply\.|quote\.)/.test(event.eventType) && !selected.length) fail('EVENT_ITEMS', '型号、链接、店铺和消息事件必须指定 itemIds');
    if (/^(shop\.|message\.|reply\.|quote\.)/.test(event.eventType) && !text(event.shop)) fail('EVENT_SHOP', '店铺及会话事件必须有shop');
    if (event.eventType === 'shop.checked' && (!text(event.outcome) || event.outcome === 'excluded' && !text(event.reason))) fail('EVENT_SHOP', '候选核验需要outcome，排除时必须有reason');
    if (['shop.skipped', 'shop.ended'].includes(event.eventType) && !text(event.reason)) fail('EVENT_SHOP', '跳过和结束店铺必须有reason');
    if (event.eventType === 'link.processed' && (!text(event.correlationId) || !text(event.outcome))) fail('EVENT_LINK', '链接处理须关联correlationId及outcome');
    if (/^message\./.test(event.eventType) && !text(event.messageId)) fail('EVENT_MESSAGE', '消息事件必须关联稳定 messageId');
    if (/^message\./.test(event.eventType) && !['initial', 'followUp', 'reply', 'thankYou', 'correction'].includes(event.messageKind)) fail('EVENT_MESSAGE', '消息事件必须记录messageKind');
    if (event.messageKind != null && !/^message\./.test(event.eventType)) fail('EVENT_MESSAGE', 'messageKind仅用于消息事件');
    if (/^human\./.test(event.eventType) && !text(event.correlationId)) fail('EVENT_HUMAN', '人助事件必须关联稳定 correlationId；工具未返回requestId可缺省');
    if (/^slider\./.test(event.eventType) && (!text(event.correlationId) || !text(event.outcome))) fail('EVENT_SLIDER', '滑块事件必须记录 correlationId 和实际 outcome');
    if (/^erp\./.test(event.eventType) && (!text(event.correlationId) || !text(event.outcome))) fail('EVENT_ERP', 'ERP 事件必须关联 payload 的 correlationId 和实际 outcome');
    if (['platform.interrupted', 'run.interrupted', 'error'].includes(event.eventType) && !text(event.reason)) fail('EVENT_REASON', '中断或错误事件必须记录 reason');
    if (event.eventType === 'stage.measured' && event.elapsedMs == null) fail('EVENT_MEASUREMENT', '阶段计时必须有实际 elapsedMs');
    if (event.eventType === 'stage.measured' && (!text(event.correlationId) || !['navigation', 'readiness', 'extraction', 'verification', 'selection', 'sending', 'waiting', 'reply', 'erp', 'recovery'].includes(event.stage))) fail('EVENT_MEASUREMENT', '阶段计时需要明确stage和correlationId');
    if (event.stage != null && event.eventType !== 'stage.measured') fail('EVENT_MEASUREMENT', 'stage仅用于stage.measured');
    if (event.eventType === 'control.signal') {
        const signal = event.signal;
        if (!object(signal) || Object.keys(signal).sort().join(',') !== 'from,id,name,status,to'
            || !['id', 'name', 'from', 'to'].every(k => text(signal[k]) && signal[k].length <= 200)
            || !['sent', 'received', 'applied'].includes(signal.status)) fail('EVENT_SIGNAL', '控制信号需要 id/name/from/to/status(sent/received/applied)');
        if ((signal.status === 'sent' ? signal.from : signal.to) !== actor) fail('EVENT_SIGNAL', '信号状态必须由实际发送者或接收者记录');
    } else if (event.signal != null) fail('EVENT_SIGNAL', 'signal 仅用于 control.signal');
    return { ...event, platform, itemIds: selected.map(i => i.itemId), models: selected.map(i => i.model) };
}

export function commit(runDir, nextRun, { event, actor = 'main', eventId = randomUUID(), writes = [], request = null, create = false } = {}) {
    const dir = runDirectory(runDir), path = join(dir, 'run.json');
    const old = create ? null : readManaged(dir), at = new Date().toISOString();
    if (!text(eventId) || eventId.length > 200) fail('EVENT_ID', 'eventId 必须为稳定短字符串');
    const run = { ...nextRun, schemaVersion: 1, runId: old?.runId ?? nextRun.runId, skillVersion: old?.skillVersion ?? currentVersion(), executionVersion: currentVersion(),
        createdAt: old?.createdAt ?? at, updatedAt: at, eventSeq: (old?.eventSeq ?? 0) + 1 };
    checkMeta(run);
    const fields = eventFields(run, actor, event, true);
    const row = { schemaVersion: 1, runId: run.runId, skillVersion: run.skillVersion, executionVersion: run.executionVersion, task: run.task, taskId: run.taskId ?? null,
        seq: run.eventSeq, eventId, occurredAt: fields.occurredAt ?? at, recordedAt: at, actor, platform: actor === 'main' ? null : actor,
        ...fields, revision: writes.find(w => /^run-.+\.json$/.test(basename(w.path)))?.revision ?? run.revision,
        requestHash: request === null ? null : hash(stable(request)) };
    const timeline = join(RUNS, `timeline-${at.slice(0, 10).replaceAll('-', '')}.log`);
    // ponytail: 每日日志整文件原子替换；日志达到数十 MB 后再评估分段追加。
    const outputs = [{ path, content: JSON.stringify(run, null, 2) + '\n' }, ...writes,
        { path: timeline, content: (bytes(timeline) ?? '') + JSON.stringify(row) + '\n' }];
    const tx = { schemaVersion: 1, skillVersion: run.skillVersion, executionVersion: run.executionVersion, runId: run.runId, eventId, targets: outputs.map(target => {
        const p = targetPath(relative(target.path)), before = bytes(p);
        return { path: relative(p), beforeHash: before === null ? null : hash(before), newHash: hash(target.content), content: target.content };
    }) };
    noPending(); atomic(PENDING, JSON.stringify(tx) + '\n'); applyPending(tx);
    return { runId: run.runId, revision: row.revision, seq: row.seq, eventId, replayed: false };
}
export function queueEvent(task, result, reason, historyPath, historyContent) {
    mkdirSync(RUNS, { recursive: true });
    const at = new Date().toISOString(), eventId = randomUUID(), version = currentVersion();
    const timeline = join(RUNS, `timeline-${at.slice(0, 10).replaceAll('-', '')}.log`);
    const event = { schemaVersion: 1, skillVersion: version, executionVersion: version, runId: null, task, taskId: null, seq: null, revision: null,
        eventId, recordedAt: at, occurredAt: at, actor: 'main', platform: null, itemIds: [], models: [],
        eventType: result === 'manual' ? 'task.manual' : 'task.skipped', phase: 'task', reason, outcome: result };
    const tx = { schemaVersion: 1, skillVersion: version, executionVersion: version, runId: null, eventId, targets: [
        { path: historyPath, content: historyContent }, { path: timeline, content: (bytes(timeline) ?? '') + JSON.stringify(event) + '\n' },
    ].map(row => { const path = targetPath(relative(row.path)), before = bytes(path); return { path: relative(path), content: row.content, beforeHash: before === null ? null : hash(before), newHash: hash(row.content) }; }) };
    noPending(); atomic(PENDING, JSON.stringify(tx) + '\n'); applyPending(tx);
}
export function createRun(runDir, task) {
    mkdirSync(runDir, { recursive: true });
    const run = { task, taskId: null, status: 'running', items: [], platforms: [], submitted: false, revision: 0, runId: randomUUID() };
    commit(runDir, run, { create: true, event: { eventType: 'run.created', phase: 'task' } });
    return readManaged(runDir);
}
