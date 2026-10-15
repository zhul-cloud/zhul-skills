#!/usr/bin/env node
// 本地询价记录工具（零依赖，Node 18+）。数据目录固定为用户主目录下的 .zhul-trade-sourcing（Windows %USERPROFILE%\.zhul-trade-sourcing\，macOS/Linux ~/.zhul-trade-sourcing/）
//   node records.mjs init [--erp <ERP地址>]       创建数据目录；带 --erp 时保存 ERP 地址。输出当前配置
//   node records.mjs install-helpers [--force]    把技能自带的站点脚本装进 BrowserOS neo；本机已有不同内容时默认不覆盖
//   node records.mjs new-run <任务编号>           新建本次任务文件夹，输出路径
//   node records.mjs recent <型号> [天数]         查询该型号近 N 天问过的店家（防止重复询价），天数默认取 settings.json 的 dedupeDays
//   node records.mjs processed <任务编号>         查询该任务是否已在本机提交过回价
//   node records.mjs merge <本次目录>             把子代理写的各平台记录 run-<平台>.json 合并进 run.json
//   node records.mjs finish <run.json>            写入询价记录，并把任务记为已处理
//
// run.json 格式见 SKILL.md「run.json」。

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(homedir(), '.zhul-trade-sourcing');
const CONFIG = join(DATA_DIR, 'config.json');
const RECORDS = join(DATA_DIR, 'records.jsonl');
const PROCESSED = join(DATA_DIR, 'processed-tasks.jsonl');
const RUNS = join(DATA_DIR, 'runs');
const LEARNINGS = join(DATA_DIR, 'learnings');
const REPORTS = join(DATA_DIR, 'reports');
// BrowserOS neo 的站点脚本目录，按域名分文件夹。环境变量 BROWSEROS_HELPERS_DIR 可覆盖。
// Windows 路径已实测；macOS、Linux 按 Chromium 用户数据目录的惯例推定，未实测，首次在这两种系统上运行时核对。
const HELPERS_DIR = process.env.BROWSEROS_HELPERS_DIR || join(
    process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'BrowserClaw', 'User Data')
        : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'BrowserClaw')
            : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'BrowserClaw'),
    '.browseros', '.browserclaw', 'helpers');

const SETTINGS = JSON.parse(readFileSync(join(SKILL_DIR, 'settings.json'), 'utf8'));

const STATUSES = ['已回复', '无货', '挂牌价', '未回复', '自动回复'];
const normModel = (m) => String(m ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');

function readConfig() {
    return existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
}

function readJsonl(path) {
    if (!existsSync(path)) {
        return [];
    }
    return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function init(args) {
    mkdirSync(RUNS, { recursive: true });
    mkdirSync(LEARNINGS, { recursive: true });
    mkdirSync(REPORTS, { recursive: true });
    const config = readConfig();
    const i = args.indexOf('--erp');
    if (i >= 0 && args[i + 1]) {
        config.erpUrl = args[i + 1].replace(/\/+$/, '');
        writeFileSync(CONFIG, JSON.stringify(config, null, 2));
    }
    console.log(JSON.stringify({ dataDir: DATA_DIR, erpUrl: config.erpUrl ?? null }, null, 2));
}

function installHelpers(args) {
    const force = args.includes('--force');
    if (!existsSync(HELPERS_DIR)) {
        console.error(`找不到 BrowserOS neo 的站点脚本目录：${HELPERS_DIR}\n请先启动一次 BrowserOS neo；装在其他位置时，用环境变量 BROWSEROS_HELPERS_DIR 指定该目录，或联系技能维护者。`);
        process.exit(2);
    }
    const src = join(SKILL_DIR, 'helpers');
    const result = { installed: [], unchanged: [], kept: [] };
    for (const host of readdirSync(src)) {
        for (const file of readdirSync(join(src, host)).filter((f) => f.endsWith('.md'))) {
            const from = join(src, host, file);
            const to = join(HELPERS_DIR, host, file);
            const name = `${host}/${file.replace(/\.md$/, '')}`;
            if (existsSync(to) && readFileSync(to, 'utf8') === readFileSync(from, 'utf8')) {
                result.unchanged.push(name);
            } else if (existsSync(to) && !force) {
                // 本机脚本可能是运行中改进过的版本，不自动覆盖
                result.kept.push(name);
            } else {
                mkdirSync(dirname(to), { recursive: true });
                copyFileSync(from, to);
                result.installed.push(name);
            }
        }
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.kept.length) {
        console.log('kept 里的脚本本机已有不同内容，未覆盖。确认要换成技能自带版本时加 --force。');
    }
}

function newRun(taskCode) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
    const dir = join(RUNS, `${taskCode.replace(/[\\/:*?"<>|]/g, '_')}-${stamp}`);
    mkdirSync(dir, { recursive: true });
    console.log(dir);
}

function recent(model, days = SETTINGS.dedupeDays) {
    const since = Date.now() - Number(days) * 86400000;
    const key = normModel(model);
    const hits = readJsonl(RECORDS).filter((r) => normModel(r.model) === key && Date.parse(r.time) >= since);
    console.log(JSON.stringify(hits, null, 2));
}

/** 只有提交过回价才算处理过；只存了草稿的记录（draft-saved）不算 */
function processed(taskCode) {
    const history = readJsonl(PROCESSED).filter((r) => r.task === taskCode);
    console.log(JSON.stringify({ task: taskCode, processed: history.some((r) => r.result === 'submitted'), history }, null, 2));
}

function validateRun(run) {
    const problems = [];
    const ids = new Set((run.items ?? []).map((i) => String(i.itemId)));
    if (!run.task) problems.push('缺少 task（任务编号）');
    if (!ids.size) problems.push('缺少 items（每个型号的 itemId 和 model）');
    (run.shops ?? []).forEach((s, n) => {
        const at = `shops 第 ${n + 1} 家（${s.shop ?? '未命名'}）`;
        if (!String(s.shop ?? '').trim()) problems.push(`${at}：缺少店铺名称`);
        if (!String(s.platform ?? '').trim()) problems.push(`${at}：缺少 platform（平台）`);
        if (!STATUSES.includes(s.status)) problems.push(`${at}：status 只能是 ${STATUSES.join(' / ')}`);
        for (const q of s.quotes ?? []) {
            if (!ids.has(String(q.itemId))) problems.push(`${at}：itemId ${q.itemId} 不在本任务里`);
        }
        if (s.reusedFrom != null && Number.isNaN(Date.parse(s.reusedFrom))) {
            problems.push(`${at}：reusedFrom 应为原报价记录的时间`);
        }
    });
    return problems;
}

function loadRun(path) {
    const run = JSON.parse(readFileSync(path, 'utf8'));
    const problems = validateRun(run);
    if (problems.length) {
        console.error('run.json 有问题：\n- ' + problems.join('\n- '));
        process.exit(2);
    }
    return run;
}

/**
 * 把子代理写的各平台记录 run-<平台>.json 合并进本次目录的 run.json；重复执行时按平台覆盖，不会重复追加。
 * run.json 的 platforms 里每个平台都要有记录文件，否则报错退出；合并结果校验通过后才写回 run.json。
 */
function merge(runDir) {
    const runPath = join(runDir, 'run.json');
    const run = JSON.parse(readFileSync(runPath, 'utf8'));
    const files = readdirSync(runDir).filter((f) => /^run-.+\.json$/.test(f));
    if (!files.length) {
        console.error(`${runDir} 里没有 run-<平台>.json`);
        process.exit(2);
    }
    const merged = [];
    for (const f of files) {
        const part = JSON.parse(readFileSync(join(runDir, f), 'utf8'));
        const platform = String(part.platform ?? '').trim();
        if (!platform) {
            console.error(`${f}：缺少 platform（平台）`);
            process.exit(2);
        }
        const other = (x) => x.platform !== platform;
        run.shops = [...(run.shops ?? []).filter(other), ...(part.shops ?? []).map((s) => ({ ...s, platform }))];
        run.noStock = [...(run.noStock ?? []).filter(other), ...(part.noStock ?? []).map((n) => ({ ...n, platform }))];
        run.incidents = [...(run.incidents ?? []).filter(other), ...(part.incidents ?? []).map((i) => ({ ...i, platform }))];
        run.skippedPlatforms = (run.skippedPlatforms ?? []).filter(other);
        if (part.skipped) run.skippedPlatforms.push({ platform, reason: part.skipped });
        run.platformStages = { ...(run.platformStages ?? {}), [platform]: part.stages ?? {} };
        merged.push(`${platform}：${(part.shops ?? []).length} 家店`);
    }
    const covered = new Set(files.map((f) => String(JSON.parse(readFileSync(join(runDir, f), 'utf8')).platform).trim()));
    const missing = (run.platforms ?? []).filter((p) => !covered.has(p));
    const problems = [
        ...missing.map((p) => `平台「${p}」没有 run-<平台>.json：子代理还没写完，或该平台需要在记录文件里写明 skipped 原因`),
        ...validateRun(run),
    ];
    if (problems.length) {
        console.error('合并没有写入 run.json：\n- ' + problems.join('\n- '));
        process.exit(2);
    }
    writeFileSync(runPath, JSON.stringify(run, null, 2));
    console.log(`已合并到 ${runPath}\n` + merged.join('\n'));
}

function finish(runPath) {
    const run = loadRun(runPath);
    const modelOf = new Map(run.items.map((i) => [String(i.itemId), i.model]));
    const now = new Date().toISOString();
    const lines = [];
    let quoteCount = 0;
    const platforms = new Set();
    for (const s of run.shops ?? []) {
        const platform = s.platform;
        platforms.add(platform);
        // 没有报价的店（未回复、无货等）也按型号各记一行，用于防重复询价
        const quotes = s.quotes?.length ? s.quotes
            : (s.itemIds ?? run.items.map((i) => i.itemId)).map((id) => ({ itemId: id }));
        // 沿用的报价保留原记录时间，不按今天重新记，否则防重复窗口会被一直续上，旧报价被无限沿用
        const time = s.reusedFrom ?? now;
        for (const q of quotes) {
            if (q.price != null && q.price !== '') quoteCount++;
            lines.push(JSON.stringify({
                time, task: run.task, platform, reusedFrom: s.reusedFrom ?? null, model: modelOf.get(String(q.itemId)) ?? '',
                shop: s.shop, contact: s.contact ?? '', url: s.url ?? '', status: s.status, reply: s.reply ?? '',
                price: s.status === '无货' ? '无货' : String(q.price ?? ''),
                taxIncluded: !!q.taxIncluded, taxRate: q.taxRate ?? null,
                condition: q.condition ?? '', leadTime: q.leadTime ?? '', sentAt: s.sentAt ?? '',
            }));
        }
    }
    mkdirSync(DATA_DIR, { recursive: true });
    if (lines.length) {
        appendFileSync(RECORDS, lines.join('\n') + '\n');
    }
    appendFileSync(PROCESSED, JSON.stringify({
        time: now, task: run.task, taskId: run.taskId ?? null,
        result: run.submitted ? 'submitted' : 'not-submitted', quotes: quoteCount, platforms: [...platforms],
    }) + '\n');
    console.log(`已写入询价记录 ${lines.length} 条；任务 ${run.task} 记为${run.submitted ? '已提交' : '未提交'}`);
}

const [cmd, ...args] = process.argv.slice(2);
try {
    if (cmd === 'init') {
        init(args);
    } else if (cmd === 'install-helpers') {
        installHelpers(args);
    } else if (cmd === 'new-run' && args[0]) {
        newRun(args[0]);
    } else if (cmd === 'recent' && args[0]) {
        recent(args[0], args[1]);
    } else if (cmd === 'processed' && args[0]) {
        processed(args[0]);
    } else if (cmd === 'merge' && args[0]) {
        merge(args[0]);
    } else if (cmd === 'finish' && args[0]) {
        finish(args[0]);
    } else {
        console.error([
            '用法：',
            '  node records.mjs init [--erp <ERP地址>]',
            '  node records.mjs install-helpers [--force]',
            '  node records.mjs new-run <任务编号>',
            `  node records.mjs recent <型号> [天数=${SETTINGS.dedupeDays}]`,
            '  node records.mjs processed <任务编号>',
            '  node records.mjs merge <本次目录>',
            '  node records.mjs finish <run.json>',
        ].join('\n'));
        process.exit(1);
    }
} catch (e) {
    console.error('出错：' + e.message);
    process.exit(1);
}
