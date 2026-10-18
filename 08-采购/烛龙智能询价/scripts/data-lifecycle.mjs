// 测试阶段个人目录版本边界。只有 records init 可重建；不迁移或备份。
import { lstatSync, realpathSync, readdirSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DATA_DIR, DEFAULTS_PATH, parseJson, readText, validateAt } from './config.mjs';

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = resolve(homedir());
export const VERSION_FILE = join(DATA_DIR, '.skill-version.json');
export const LIFECYCLE_LOCK = join(home, '.zhul-trade-sourcing.lifecycle.lock');
const fail = (code, message) => { const e = new Error(`${code}: ${message}`); e.code = code; throw e; };
const canonical = (p) => process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
function stat(p) { try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function safeNode(p) {
    const s = stat(p);
    if (!s) return null;
    if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()) || canonical(realpathSync(p)) !== canonical(p)) {
        fail('DATA_PATH_UNSAFE', `拒绝链接、特殊文件或路径重定向：${p}`);
    }
    return s;
}
function safeParents() {
    if (resolve(DATA_DIR) !== join(home, '.zhul-trade-sourcing')) fail('DATA_PATH_UNSAFE', '数据目录不是固定主目录路径');
    let p = home;
    for (;;) {
        const s = safeNode(p);
        if (!s?.isDirectory()) fail('DATA_PATH_UNSAFE', `主目录父链不可核验：${p}`);
        const next = dirname(p); if (next === p) break; p = next;
    }
    safeNode(DATA_DIR);
    safeNode(LIFECYCLE_LOCK);
}
function currentVersion() {
    const text = readText(join(skillDir, 'SKILL.md'), 'SKILL.md');
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    const rows = front?.split(/\r?\n/).filter((s) => s.startsWith('version:')) ?? [];
    const version = rows.length === 1 ? rows[0].slice(8).trim().replace(/^(['"])(.*)\1$/, '$2') : '';
    const names = front?.split(/\r?\n/).filter((s) => s.startsWith('name:')) ?? [];
    if (names.length !== 1 || !names[0].slice(5).trim().replace(/^(['"])(.*)\1$/, '$2')) fail('DATA_VERSION', '当前 SKILL name 无效');
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) fail('DATA_VERSION', '当前 SKILL version 无效');
    return version;
}
function marker() {
    const s = safeNode(VERSION_FILE);
    if (!s) return null;
    if (!s.isFile()) fail('DATA_VERSION', '版本标记必须为普通文件');
    let value;
    try { value = parseJson(readText(VERSION_FILE, VERSION_FILE), VERSION_FILE); }
    catch { fail('DATA_VERSION', '版本标记损坏，保留数据，请人工核对'); }
    if (!value || value.schemaVersion !== 1 || typeof value.skillVersion !== 'string'
        || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.skillVersion)
        || Object.keys(value).sort().join(',') !== 'schemaVersion,skillVersion') fail('DATA_VERSION', '版本标记结构未知，保留数据');
    return value;
}
const compare = (a, b) => {
    const x = a.split('.').map(BigInt), y = b.split('.').map(BigInt);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
    return 0;
};
function checkVersion(version, initialized) {
    const stored = marker();
    if (stored && compare(version, stored.skillVersion) < 0) fail('DATA_NEWER_VERSION', '数据由较新技能初始化，请使用对应新版；不自动降级清理');
    if (initialized && stored?.skillVersion !== version) fail('DATA_INIT_REQUIRED', '数据尚未按当前版本初始化；先停止执行者，再运行 records.mjs init');
    return stored;
}
// Node 没有暴露 Windows 所有 ReparsePoint 属性，删除前额外核系统属性。
function windowsPreflight() {
    if (process.platform !== 'win32') return;
    const script = `$ErrorActionPreference='Stop'; $x=ConvertFrom-Json ([Console]::In.ReadToEnd());
function Check($p) { $a=[IO.File]::GetAttributes($p); if (($a -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'DATA_PATH_UNSAFE: ReparsePoint' }; return $a }
foreach($p in $x.parents) { $null=Check $p }; if([IO.Directory]::Exists($x.data)) {
$q=[Collections.Generic.Stack[string]]::new(); $q.Push($x.data); while($q.Count) { $p=$q.Pop(); $a=Check $p; if(($a -band [IO.FileAttributes]::Directory) -ne 0) { foreach($c in [IO.Directory]::EnumerateFileSystemEntries($p)) {$q.Push($c)} } } }; 'OK'`;
    const parents = [LIFECYCLE_LOCK]; let p = home;
    for (;;) { parents.push(p); const next = dirname(p); if (next === p) break; p = next; }
    try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            input: JSON.stringify({ parents, data: DATA_DIR }), encoding: 'utf8', timeout: 10000, windowsHide: true,
        });
        if (out.trim() !== 'OK') throw new Error('属性核验未完成');
    } catch (e) { fail('DATA_PATH_UNSAFE', `Windows 重解析属性无法安全核验，未开始删除（${e.code || e.status || '失败'}）`); }
}
function removalPlan() {
    const plan = [];
    function visit(p) {
        const s = safeNode(p); if (!s) return;
        if (p !== DATA_DIR && ['.settings.lock', '.contacts.lock'].includes(p.slice(DATA_DIR.length + 1))) fail('DATA_BUSY', '保留现有写锁；不能用版本重建清锁');
        if (s.isDirectory()) for (const name of readdirSync(p)) visit(join(p, name));
        plan.push({ path: p, dev: s.dev, ino: s.ino, directory: s.isDirectory() });
    }
    visit(DATA_DIR); return plan;
}
function withLock(action) {
    safeParents();
    const token = randomUUID(); let locked = false;
    try {
        try { writeFileSync(LIFECYCLE_LOCK, token, { flag: 'wx', mode: 0o600 }); locked = true; }
        catch (e) { if (e.code === 'EEXIST') fail('DATA_BUSY', '另一初始化或写入持有生命周期锁；不自动删除锁'); throw e; }
        safeParents(); return action();
    } finally {
        if (locked) {
            const s = safeNode(LIFECYCLE_LOCK);
            if (!s?.isFile() || readFileSync(LIFECYCLE_LOCK, 'utf8') !== token) fail('DATA_BUSY', '生命周期锁已变化，保留现场');
            unlinkSync(LIFECYCLE_LOCK);
        }
    }
}
export function withCurrentData(action) {
    return withLock(() => { checkVersion(currentVersion(), true); return action(); });
}
export function initializeData(action) {
    // 只验证发布内容，不解析旧个人配置；坏默认值不能导致旧数据删除。
    const validateDefaults = () => validateAt(parseJson(readText(DEFAULTS_PATH, DEFAULTS_PATH), DEFAULTS_PATH), DEFAULTS_PATH);
    currentVersion(); validateDefaults();
    return withLock(() => {
        const version = currentVersion(); validateDefaults();
        const stored = checkVersion(version, false);
        const reset = stored?.skillVersion !== version;
        if (reset) {
            windowsPreflight();
            const plan = removalPlan(); // 完整预检后才开始逐项删除，不递归跟进链接。
            for (const row of plan) {
                safeParents(); const s = safeNode(row.path);
                if (!s || s.dev !== row.dev || s.ino !== row.ino || s.isDirectory() !== row.directory) fail('DATA_PATH_UNSAFE', '删除前目录项发生变化，停止重建');
                if (row.directory) rmdirSync(row.path); else unlinkSync(row.path);
            }
            mkdirSync(DATA_DIR);
        }
        const result = action();
        if (reset) {
            const temp = join(DATA_DIR, `.version-${randomUUID()}.tmp`);
            try {
                writeFileSync(temp, JSON.stringify({ schemaVersion: 1, skillVersion: version }) + '\n', { flag: 'wx', mode: 0o600 });
                renameSync(temp, VERSION_FILE);
            } finally { if (stat(temp)) unlinkSync(temp); }
        }
        return { ...result, skillVersion: version, dataRebuilt: reset };
    });
}
