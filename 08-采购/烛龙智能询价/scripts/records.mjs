#!/usr/bin/env node
// 本地询价记录工具（零依赖，Node 18+）。数据目录固定为用户主目录下的 .zhul-trade-sourcing（Windows %USERPROFILE%\.zhul-trade-sourcing\，macOS/Linux ~/.zhul-trade-sourcing/）
//   node records.mjs version                    只读本脚本所属技能的名称、版本和绝对目录，不初始化数据或读取业务设置
//   node records.mjs init [--erp <ERP地址>]       创建数据目录；带 --erp 时保存 ERP 地址。输出当前配置
//   node records.mjs install-helpers [--force]    维护者可选磁盘导出；需显式 BROWSEROS_HELPERS_DIR，copied 不等于 runtimeLoaded
//   node records.mjs new-run <任务编号>           恢复唯一未提交 run；没有时新建，输出路径
//   node records.mjs open-run <任务编号>          同 new-run，输出 JSON（恢复标志、已完成平台、ERP 核对提示）
//   node records.mjs recent <型号> [天数]         查询该型号近 N 天问过的店家（防止重复询价），天数默认取有效配置的 dedupeDays
//   node records.mjs processed <任务编号>         查询该任务是否已在本机提交过回价
//   node records.mjs next <任务编号...>           按给出的顺序，返回第一个本机未提交、未跳过且可继续的任务；manual 有真实未完 run 时优先恢复
//   node records.mjs skip <任务编号> <原因>       把任务记为跳过（如询盘已取消、已回过价），next 不再选中它
//   node records.mjs manual <任务编号> <原因>     把任务记为需人工处理；next 有真实未完 run 则恢复，无断点才跳过
//   node records.mjs check <本次目录> <平台> [--partial]  校验平台记录；--partial 允许运行中或中断快照
//   node records.mjs beat <本次目录> <平台> [--paused] [在做什么]   子代理打卡，供 watch 判断有没有卡住；停下等人处理时加 --paused
//   node records.mjs watch <本次目录> [--once]    主代理盯各平台的打卡：有平台超过 subagents.stallMinutes 分钟没打卡、或全部结束时退出
//   node records.mjs merge <本次目录> [--partial <平台...>]  主代理合并平台记录；--partial 只合并指定平台快照
//   node records.mjs erp-items <run.json> [--draft] 把本地已知报价整理为 ERP 输入；正式模式要求所有平台完成
//   node records.mjs finish <run.json>            写入询价记录，并按 run.json 的 submitted 记下任务是否已提交
//   node records.mjs stats [天数]                 统计近 N 天询价的结束原因和店家提问的类型（天数默认 30）
//
// run.json 格式见 references/run-protocol.md「run.json」。

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(homedir(), '.zhul-trade-sourcing');
const CONFIG = join(DATA_DIR, 'config.json');
const RECORDS = join(DATA_DIR, 'records.jsonl');
const PROCESSED = join(DATA_DIR, 'processed-tasks.jsonl');
const RUNS = join(DATA_DIR, 'runs');
const LEARNINGS = join(DATA_DIR, 'learnings');
const REPORTS = join(DATA_DIR, 'reports');
// 仅维护者显式选择的导出目录；普通运行用 page.saveHelper 注册，不推定 BrowserOS 磁盘位置。
const HELPERS_DIR = process.env.BROWSEROS_HELPERS_DIR;

const [cmd, ...args] = process.argv.slice(2);
let SETTINGS;

const STATUSES = ['已回复', '无货', '挂牌价', '未回复', '自动回复'];
// 因店家提问停止聊天的结束原因，这两种要在 stopQuestion 里记下问题类型，供 stats 统计
const STOP_REASONS = ['店家提问超出范围', '店家重复提问'];
const normModel = (m) => String(m ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
// watch 每隔多久看一次打卡（毫秒）
const WATCH_INTERVAL_MS = 15000;
const platformFile = (runDir, platform) => join(runDir, `run-${platform}.json`);
const beatFile = (runDir, platform) => join(runDir, `heartbeat-${platform}.jsonl`);

function version() {
    const path = join(SKILL_DIR, 'SKILL.md');
    const frontmatter = readFileSync(path, 'utf8').match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (frontmatter == null) throw new Error(`${path} 缺少有效的 frontmatter`);
    const field = (key) => {
        const rows = frontmatter.split(/\r?\n/).filter((line) => line.startsWith(`${key}:`));
        if (rows.length !== 1) throw new Error(`${path} 必须有且只有一个 ${key}`);
        const value = rows[0].slice(key.length + 1).trim();
        return value.replace(/^(['"])(.*)\1$/, '$2');
    };
    const name = field('name');
    const value = field('version');
    if (!name) throw new Error(`${path} 的 name 不能为空`);
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
        throw new Error(`${path} 的 version 非法，应为 主版本.次版本.修订号（如 1.2.0）`);
    }
    console.log(JSON.stringify({ name, version: value, skillDir: SKILL_DIR }, null, 2));
}

function readConfig() {
    return existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
}

/** 读一个 JSON 文件；读不出来时报出是哪个文件、什么问题 */
function readJsonFile(path) {
    if (!existsSync(path)) {
        throw new Error(`找不到 ${path}`);
    }
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
        throw new Error(`${path} 读不出来，不是有效的 JSON（${e.message}）`);
    }
}

function readJsonl(path) {
    if (!existsSync(path)) {
        return [];
    }
    return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function normalizeErpUrl(value) {
    const invalid = () => { throw new Error('ERP 地址无效：请输入域名、localhost 或 IP，可带端口；未填协议默认 http://，完整地址支持 HTTP(S)，不允许凭据、内部空白、反斜线或其他协议'); };
    if (typeof value !== 'string') invalid();
    const input = value.trim();
    if (!input || /[\s\u0000-\u001f\u007f\\]/u.test(input)) invalid();
    // 缺协议默认 HTTP，完整地址保留原协议；不猜补端口或降级 HTTPS。
    const protocol = input.match(/^(https?):\/\//i)?.[1].toLowerCase() ?? 'http';
    const authority = input.replace(/^https?:\/\//i, '').split(/[/?#]/, 1)[0];
    const address = authority.startsWith('[')
        ? authority.match(/^\[([^\]]+)\](?::(\d+))?$/)
        : authority.match(/^([^:@%]+)(?::(\d+))?$/);
    if (!address || (authority.startsWith('[') && isIP(address[1]) !== 6)) invalid();
    let url;
    try { url = new URL(`${protocol}://${authority}`); } catch { invalid(); }
    if (!authority.startsWith('[')) {
        // 保留内网单标签/下划线主机；拒绝空标签、主机特殊符号及缩写/进制 IPv4 误解析。
        const host = url.hostname.replace(/\.$/, '');
        if (!/^[a-z\d_-]+(?:\.[a-z\d_-]+)*$/i.test(host) || host.length > 253
            || host.split('.').some((label) => label.length > 63)
            || (isIP(host) === 4 && isIP(address[1]) !== 4)) invalid();
    }
    return url.origin;
}

function init(args) {
    let erpUrl;
    if (args.length) {
        if (args.length !== 2 || args[0] !== '--erp' || !args[1] || args[1].startsWith('--')) {
            throw new Error('用法：init [--erp <ERP地址>]；--erp 可填域名或 IP（可带端口），未填协议默认 http://，完整地址保留 HTTP(S)');
        }
        erpUrl = normalizeErpUrl(args[1]);
    }
    const config = readConfig();
    const effectiveUrl = erpUrl ?? (config.erpUrl == null || config.erpUrl === '' ? null : normalizeErpUrl(config.erpUrl));
    // 地址校验完成后才允许创建目录或写配置；无参只返回有效 origin，不迁移旧配置。
    mkdirSync(RUNS, { recursive: true });
    mkdirSync(LEARNINGS, { recursive: true });
    mkdirSync(REPORTS, { recursive: true });
    if (erpUrl !== undefined) {
        config.erpUrl = erpUrl;
        writeFileSync(CONFIG, JSON.stringify(config, null, 2));
    }
    console.log(JSON.stringify({ dataDir: DATA_DIR, erpUrl: effectiveUrl }, null, 2));
}

function installHelpers(args) {
    if (args.some((arg) => arg !== '--force')) throw new Error('install-helpers 仅支持可选 --force；它只是磁盘导出，不注册运行时 helper');
    const force = args.includes('--force');
    if (!HELPERS_DIR || !existsSync(HELPERS_DIR)) {
        throw new Error('install-helpers 仅供维护者导出文件，需要显式 BROWSEROS_HELPERS_DIR 指向已有目录。copied 不等于 runtimeLoaded；正式准备请按 references/browseros-setup.md 使用 page.saveHelper 注册并在下一次 run 验证。');
    }
    const configuredUrl = readConfig().erpUrl;
    const erpUrl = configuredUrl == null || configuredUrl === '' ? null : normalizeErpUrl(configuredUrl);
    const src = join(SKILL_DIR, 'helpers');
    const result = { copied: [], unchanged: [], kept: [], runtimeLoaded: false,
        note: '仅导出 Markdown 文件；copied 不等于 runtimeLoaded。须按 browseros-setup.md 生成适配源码、page.saveHelper 注册并在下一次 run 验证。' };
    for (const host of readdirSync(src).filter((h) => !h.startsWith('_'))) {
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
                result.copied.push(name);
            }
        }
    }
    // ERP 接口脚本：ERP 地址每台电脑不同，按 config.json 的 erpUrl 装进对应域名；接口约定以技能版本为准，总是覆盖
    if (!erpUrl) {
        result.erp = '未配置 ERP 地址，本次仅导出电商文件；ERP 运行时注册按 browseros-setup.md 使用已有 erpUrl';
    } else {
        const host = new URL(erpUrl).hostname;
        const erpSrc = join(src, '_erp');
        for (const file of readdirSync(erpSrc).filter((f) => f.endsWith('.md'))) {
            const text = readFileSync(join(erpSrc, file), 'utf8').replace(/^host: ".*"$/m, `host: "${host}"`);
            const to = join(HELPERS_DIR, host, file);
            const name = `${host}/${file.replace(/\.md$/, '')}`;
            if (existsSync(to) && readFileSync(to, 'utf8') === text) {
                result.unchanged.push(name);
            } else {
                mkdirSync(dirname(to), { recursive: true });
                writeFileSync(to, text);
                result.copied.push(name);
            }
        }
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.kept.length) {
        console.error('kept 里的导出文件已有不同内容，未覆盖。维护者先比对、保留本地改进，明确选择替换后才加 --force；磁盘导出不代表运行时更新。');
    }
}

const CHANNELS = ['淘宝', '1688'];

/**
 * 把 run.json 里要填进 ERP 的报价整理成 erpApi 的 save / verify 输入（文字取值，由 erpApi 按 ERP 字典换成码值）。
 * 只取已回复、挂牌价且有单价的店；没有任何价格、记了无货的型号标无货。
 */
function erpItems(runPath, args = []) {
    const run = loadRun(runPath);
    const draft = args.includes('--draft');
    if (simulated(run)) throw new Error('模拟 run 不得生成 ERP 报价');
    if (run.submitted) throw new Error('任务已提交，先核对 ERP 状态，不得重复提交');
    if (run.submissionAttempt != null && run.submissionAttempt.state !== 'not_sent') throw new Error('已有提交尝试，只能用原 payload 核对 ERP 状态，不得自动重新提交');
    if (!draft) {
        const problems = finalProblems(run);
        if (problems.length) throw new Error('不能生成正式提交报价：\n- ' + problems.join('\n- '));
    }
    if (!run.taskId) {
        console.error('run.json 缺少 taskId（ERP 任务 ID），请用 erpApi 的 task 结果写入');
        process.exit(2);
    }
    const ids = new Set(run.items.map((i) => String(i.itemId)));
    const byItem = new Map();
    const problems = [];
    for (const s of run.shops ?? []) {
        if (!['已回复', '挂牌价'].includes(s.status)) continue;
        if (!CHANNELS.includes(s.platform)) {
            problems.push(`${s.shop}：平台「${s.platform}」不是 ${CHANNELS.join(' / ')}`);
            continue;
        }
        for (const q of s.quotes ?? []) {
            if (q.price == null || q.price === '' || q.price === '无货') continue;
            const key = String(q.itemId);
            if (!ids.has(key)) continue;
            const list = byItem.get(key) ?? [];
            if (list.some((x) => x.channel === s.platform && x.shopName === s.shop)) {
                problems.push(`${s.shop}：同一型号（itemId ${q.itemId}）在 ${s.platform} 有两条报价`);
                continue;
            }
            list.push({
                channel: s.platform, shopName: s.shop, unitPrice: Number(q.price), taxIncluded: !!q.taxIncluded,
                taxRate: q.taxIncluded ? Number(q.taxRate) : null, condition: q.condition || '待确认',
                leadTime: q.leadTime || '', freeShipping: q.freeShipping !== false, note: String(q.note ?? '').slice(0, 300),
            });
            byItem.set(key, list);
        }
    }
    if (problems.length) {
        console.error('报价整理有问题：\n- ' + problems.join('\n- '));
        process.exit(2);
    }
    const items = [];
    const skipItemIds = [];
    for (const i of run.items) {
        const quotes = byItem.get(String(i.itemId)) ?? [];
        if (quotes.length) {
            items.push({ itemId: Number(i.itemId), quotes });
            continue;
        }
        if (draft) {
            skipItemIds.push(Number(i.itemId));
            continue;
        }
        const incomplete = (run.incompleteItems ?? []).filter((n) => String(n.itemId) === String(i.itemId));
        if (incomplete.length) {
            skipItemIds.push(Number(i.itemId));
            console.error(`型号 ${i.model}（itemId ${i.itemId}）询价未完成，需人工处理：${incomplete.map((n) => `${n.platform ?? ''} ${n.reason ?? ''}`.trim()).join('；')}`);
            continue;
        }
        const ns = (run.noStock ?? []).filter((n) => String(n.itemId) === String(i.itemId));
        if (ns.length) {
            items.push({ itemId: Number(i.itemId), noStock: true, noStockNote: ns.map((n) => n.note).filter(Boolean).join('；').slice(0, 300), quotes: [] });
        }
    }
    console.log(JSON.stringify({ taskId: Number(run.taskId), items, skipItemIds }));
}

const safeTask = (task) => task.replace(/[\\/:*?"<>|]/g, '_');
const simulated = (run) => run.simulation === true || run.simulated === true || run.dryRun === true || run.mode === 'simulation';

function resumableRun(taskCode) {
    const candidates = [];
    let submitted = readJsonl(PROCESSED).some((r) => r.task === taskCode && r.result === 'submitted');
    if (existsSync(RUNS)) for (const name of readdirSync(RUNS, { withFileTypes: true })) {
        if (!name.isDirectory() || !name.name.startsWith(`${safeTask(taskCode)}-`)) continue;
        const dir = join(RUNS, name.name);
        const run = readJsonFile(join(dir, 'run.json'));
        if (run.task !== taskCode) continue;
        if (simulated(run)) continue;
        const problems = run.items?.length ? validateRun(run) : run.status === 'running' && Array.isArray(run.items) && Array.isArray(run.platforms) ? [] : ['缺少有效任务记录'];
        if (problems.length) throw new Error(`${dir} 记录损坏：${problems.join('；')}`);
        if (run.submitted || run.status === 'submitted') submitted = true;
        else candidates.push({ dir, run });
    }
    if (submitted) return { submitted: true };
    if (candidates.length > 1) throw new Error(`任务 ${taskCode} 有多个未完成 run，须先核对：${candidates.map((c) => c.dir).join('；')}`);
    return candidates[0] ?? null;
}

function resumeProgress(dir, run) {
    const completedPlatforms = [];
    let stopAfterTask = !!run.stopAfterTask;
    for (const platform of run.platforms ?? []) {
        const path = platformFile(dir, platform);
        if (!existsSync(path)) continue;
        const part = readJsonFile(path);
        const problems = validatePart(run, part, platform, true);
        if (problems.length) throw new Error(`${path} 记录损坏：${problems.join('；')}`);
        if (partState(part) === 'completed' || part.skipped) completedPlatforms.push(platform);
        if (partState(part) === 'interrupted') stopAfterTask = true;
    }
    return { completedPlatforms, stopAfterTask };
}

function newRun(taskCode, json = false) {
    const prior = resumableRun(taskCode);
    if (prior?.submitted) throw new Error(`任务 ${taskCode} 本机已提交，先核对 ERP，不得重新询价`);
    let dir = prior?.dir;
    let run = prior?.run;
    if (!dir) {
        dir = join(RUNS, `${safeTask(taskCode)}-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`);
        mkdirSync(dir, { recursive: true });
        run = { task: taskCode, status: 'running', createdAt: new Date().toISOString(), items: [], platforms: [], submitted: false };
        writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
    }
    const progress = resumeProgress(dir, run);
    console.log(json ? JSON.stringify({ runDir: dir, resumed: !!prior, needsErpReconcile: true, ...progress }, null, 2) : dir);
}

function recent(model, days = SETTINGS.dedupeDays) {
    const since = Date.now() - Number(days) * 86400000;
    const key = normModel(model);
    const latest = new Map();
    for (const r of readJsonl(RECORDS)) {
        if (normModel(r.model) === key) latest.set(JSON.stringify([r.platform, r.shop, key]), r);
    }
    // 先取最新更正再检查原报价时间，避免旧价格复活或沿用报价刷新去重窗口。
    const hits = [...latest.values()].filter((r) => Date.parse(r.time) >= since);
    console.log(JSON.stringify(hits, null, 2));
}

/** 只有提交过回价才算处理过；没提交成功的记录（not-submitted）不算 */
function processed(taskCode) {
    const history = readJsonl(PROCESSED).filter((r) => r.task === taskCode);
    console.log(JSON.stringify({ task: taskCode, processed: history.some((r) => r.result === 'submitted'), history }, null, 2));
}

/** 连续处理任务时取下一个：按「待处理」列表的顺序，跳过本机已提交/已跳过的任务；manual 有真实未完 run 时恢复，无断点才跳过 */
function next(taskCodes) {
    const reasonOf = new Map();
    for (const r of readJsonl(PROCESSED)) {
        if (r.result === 'submitted') reasonOf.set(r.task, '本机已提交过回价');
        else if (r.result === 'skipped' && reasonOf.get(r.task) !== '本机已提交过回价') reasonOf.set(r.task, `已跳过：${r.reason ?? ''}`);
        else if (r.result === 'manual' && !reasonOf.has(r.task)) reasonOf.set(r.task, `需人工处理：${r.reason ?? ''}`);
    }
    const skipped = [];
    for (const task of taskCodes) {
        const prior = resumableRun(task);
        if (prior?.submitted) reasonOf.set(task, '本机已提交过回价');
        if (prior && !prior.submitted && !reasonOf.get(task)?.startsWith('已跳过')) {
            console.log(JSON.stringify({ next: task, resumeRun: prior.dir, needsErpReconcile: true, ...resumeProgress(prior.dir, prior.run), skipped }, null, 2));
            return;
        }
        if (reasonOf.has(task)) skipped.push({ task, reason: reasonOf.get(task) });
        else {
            console.log(JSON.stringify({ next: task, skipped }, null, 2));
            return;
        }
    }
    console.log(JSON.stringify({ next: null, skipped }, null, 2));
}

/**
 * 把任务记为跳过（skipped：询盘已取消、已在别处回过价）或需人工处理（manual：提交失败、AI 解决不了），
 * skipped 不再由 next 选中；manual 有真实未完 run 时仍可恢复，同轮已收尾任务由主代理从候选中排除
 */
function mark(result, taskCode, reason) {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(PROCESSED, JSON.stringify({ time: new Date().toISOString(), task: taskCode, result, reason }) + '\n');
    console.log(`任务 ${taskCode} 已记为${result === 'manual' ? '需人工处理' : '跳过'}：${reason}`);
}

function validateRun(run) {
    const problems = [];
    const ids = new Set((run.items ?? []).map((i) => String(i.itemId)));
    if (!run.task) problems.push('缺少 task（任务编号）');
    if (!ids.size) problems.push('缺少 items（每个型号的 itemId 和 model）');
    for (const i of run.items ?? []) {
        if (i.itemId == null || !String(i.itemId).trim()) problems.push('items：缺少 itemId');
        if (!String(i.model ?? '').trim()) problems.push(`items：itemId ${i.itemId} 缺少 model`);
    }
    if (ids.size !== (run.items ?? []).length) problems.push('items：itemId 重复，无法区分型号');
    if (run.submissionAttempt != null && (!['pending', 'unknown', 'failed', 'confirmed', 'not_sent'].includes(run.submissionAttempt.state) || !validTime(run.submissionAttempt.at))) {
        problems.push('submissionAttempt：需要 state（pending / unknown / failed / confirmed / not_sent）和有效 at');
    }
    if (run.submissionAttempt?.state === 'not_sent' && run.submissionAttempt.writeAttempted !== false) problems.push('submissionAttempt.not_sent 必须有 helper 明确返回的 writeAttempted:false');
    (run.shops ?? []).forEach((s, n) => {
        const at = `shops 第 ${n + 1} 家（${s.shop ?? '未命名'}）`;
        if (!String(s.shop ?? '').trim()) problems.push(`${at}：缺少店铺名称`);
        if (!String(s.platform ?? '').trim()) problems.push(`${at}：缺少 platform（平台）`);
        if (!STATUSES.includes(s.status)) problems.push(`${at}：status 只能是 ${STATUSES.join(' / ')}`);
        for (const key of ['sentAt', 'followUpAt', 'replyAt']) {
            if (s[key] != null && s[key] !== '' && !validTime(s[key])) problems.push(`${at}：${key} 应为有效时间`);
        }
        if (s.followUps != null && (!Number.isInteger(s.followUps) || s.followUps < 0)) problems.push(`${at}：followUps 应为非负整数`);
        if (s.answeredTopics != null && !Array.isArray(s.answeredTopics)) problems.push(`${at}：answeredTopics 应为数组`);
        if (s.pendingMessage != null) {
            const m = s.pendingMessage;
            if (!['initial', 'followUp', 'reply', 'thankYou', 'correction'].includes(m.kind) || !String(m.text ?? '').trim() || !validTime(m.preparedAt) || !['pending', 'confirmed', 'cancelled'].includes(m.state)) problems.push(`${at}：pendingMessage 需要 kind/text/preparedAt/state`);
            if (m.state === 'confirmed' && !validTime(m.confirmedAt)) problems.push(`${at}：已确认 pendingMessage 缺少 confirmedAt`);
            if (m.state === 'confirmed' && m.kind === 'initial' && !validTime(s.sentAt)) problems.push(`${at}：首条发送已确认但未保存 sentAt`);
            if (m.state === 'confirmed' && m.kind === 'followUp' && (!validTime(s.followUpAt) || !(s.followUps > 0))) problems.push(`${at}：追问已确认但未保存 followUpAt/followUps`);
            if (m.state === 'confirmed' && m.kind === 'reply' && (!validTime(s.replyAt) || !Array.isArray(s.answeredTopics) || !s.answeredTopics.length)) problems.push(`${at}：答复已确认但未保存 replyAt/answeredTopics`);
        }
        for (const id of s.itemIds ?? []) {
            if (!ids.has(String(id))) problems.push(`${at}：itemIds 的 ${id} 不在本任务里`);
        }
        for (const q of s.quotes ?? []) {
            if (!ids.has(String(q.itemId))) problems.push(`${at}：itemId ${q.itemId} 不在本任务里`);
            else if (s.itemIds && !s.itemIds.some((id) => String(id) === String(q.itemId))) problems.push(`${at}：报价 itemId ${q.itemId} 不在这家店的 itemIds 里`);
            if (q.price != null && q.price !== '' &&
                (!['number', 'string'].includes(typeof q.price) || !String(q.price).trim() || !Number.isFinite(Number(q.price)))) {
                problems.push(`${at}：itemId ${q.itemId} 的 price 应为有限数字，未报价请留空`);
            }
        }
        if (s.reusedFrom != null && Number.isNaN(Date.parse(s.reusedFrom))) {
            problems.push(`${at}：reusedFrom 应为原报价记录的时间`);
        }
        if (STOP_REASONS.includes(s.endReason) && !String(s.stopQuestion?.type ?? '').trim()) {
            problems.push(`${at}：结束原因是「${s.endReason}」，要在 stopQuestion 里填问题类型 type`);
        }
    });
    for (const n of run.noStock ?? []) {
        if (!ids.has(String(n.itemId))) problems.push(`noStock：itemId ${n.itemId} 不在本任务里`);
    }
    for (const n of run.incompleteItems ?? []) {
        if (!ids.has(String(n.itemId))) problems.push(`incompleteItems：itemId ${n.itemId} 不在本任务里`);
        if (!String(n.reason ?? '').trim()) problems.push(`incompleteItems：itemId ${n.itemId} 缺少未完成原因 reason`);
    }
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

const validTime = (value) => typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
const partState = (part) => part.status ?? (part.skipped || part.stages?.repliesDone ? 'completed' : 'running');
const humanHelpBlocked = (help) => help != null && (help.status !== 'resolved' || help.verified !== true || !validTime(help.verifiedAt));

function finalProblems(run) {
    const problems = [];
    if (simulated(run)) problems.push('模拟 run 不得提交');
    if (!run.platforms?.length) problems.push('缺少 platforms');
    if (humanHelpBlocked(run.humanHelp)) problems.push('ERP 人助尚未核验解除，不能正式提交');
    for (const platform of run.platforms ?? []) {
        if (run.platformStates?.[platform] !== 'completed') problems.push(`${platform} 尚未完成（${run.platformStates?.[platform] ?? '缺少结果'}）`);
        if (humanHelpBlocked(run.platformHumanHelp?.[platform])) problems.push(`${platform} 人助尚未核验解除，不能正式提交`);
    }
    if (run.stopAfterTask) problems.push('本轮因中断停止，恢复并核对后才能提交');
    for (const shop of run.shops ?? []) if (shop.pendingMessage?.state === 'pending') problems.push(`${shop.shop} 有未确认发送，先核对聊天界面`);
    return problems;
}

function validatePart(run, part, platform, partial = false) {
    const problems = [];
    if (run.platforms && !run.platforms.includes(platform)) problems.push(`平台「${platform}」不在本次 platforms 里`);
    if (String(part.platform ?? '').trim() !== platform) {
        problems.push(`platform 应为「${platform}」，现在是「${part.platform ?? ''}」`);
    }
    const shops = (part.shops ?? []).map((s) => ({ ...s, platform }));
    problems.push(...validateRun({ task: run.task, items: run.items, shops, noStock: part.noStock, incompleteItems: part.incompleteItems }));
    const state = partState(part);
    if (!['running', 'completed', 'interrupted'].includes(state)) problems.push('status 应为 running / completed / interrupted');
    if (part.skipped && state !== 'completed') problems.push('skipped 平台应为 completed');
    if (state === 'completed' && !part.skipped && !validTime(part.stages?.repliesDone)) problems.push('stages.repliesDone 为空：所有店都结束后记下时间');
    if (state !== 'completed' && (part.stages?.repliesDone || part.endedAt)) problems.push('未完成平台不得填写 repliesDone 或平台 endedAt');
    if (state === 'interrupted' && !String(part.interruption?.reason ?? '').trim()) problems.push('interrupted 需要 interruption.reason');
    if (!partial && state !== 'completed') problems.push(`平台 ${state}，只能用 --partial 保存中途快照`);
    if (state === 'completed' && (part.shops ?? []).some((s) => s.pendingMessage?.state === 'pending')) problems.push('已完成平台仍有未确认发送，先核对聊天界面');
    if (state === 'completed' && humanHelpBlocked(part.humanHelp)) problems.push('已完成平台的人助尚未核验解除，需要 resolved、verified:true 和有效 verifiedAt');
    return problems;
}

/**
 * 把子代理写的各平台记录 run-<平台>.json 合并进本次目录的 run.json；重复执行时按平台覆盖，不会重复追加。
 * run.json 的 platforms 里每个平台都要有记录文件，否则报错退出；合并结果校验通过后才写回 run.json。
 */
function merge(runDir, args = []) {
    const runPath = join(runDir, 'run.json');
    const run = readJsonFile(runPath);
    const partial = args.includes('--partial');
    const selected = args.filter((a) => a !== '--partial');
    if (partial && !selected.length) throw new Error('merge --partial 必须明确指定平台');
    const files = partial ? [...new Set(selected)].map((p) => `run-${p}.json`) : readdirSync(runDir).filter((f) => /^run-.+\.json$/.test(f));
    if (!files.length) {
        console.error(`${runDir} 里没有 run-<平台>.json`);
        process.exit(2);
    }
    const merged = [];
    for (const f of files) {
        const part = readJsonFile(join(runDir, f));
        const platform = String(part.platform ?? '').trim();
        if (!platform) {
            console.error(`${f}：缺少 platform（平台）`);
            process.exit(2);
        }
        const problems = validatePart(run, part, f.slice(4, -5), partial);
        if (problems.length) {
            console.error(`${f} 有问题，合并没有写入 run.json：\n- ` + problems.join('\n- '));
            process.exit(2);
        }
        const other = (x) => x.platform !== platform;
        run.shops = [...(run.shops ?? []).filter(other), ...(part.shops ?? []).map((s) => ({ ...s, platform }))];
        run.noStock = [...(run.noStock ?? []).filter(other), ...(part.noStock ?? []).map((n) => ({ ...n, platform }))];
        run.incompleteItems = [...(run.incompleteItems ?? []).filter(other), ...(part.incompleteItems ?? []).map((n) => ({ ...n, platform }))];
        run.incidents = [...(run.incidents ?? []).filter(other), ...(part.incidents ?? []).map((i) => ({ ...i, platform }))];
        run.skippedPlatforms = (run.skippedPlatforms ?? []).filter(other);
        if (part.skipped) run.skippedPlatforms.push({ platform, reason: part.skipped });
        run.platformStages = { ...(run.platformStages ?? {}), [platform]: part.stages ?? {} };
        run.platformStates = { ...(run.platformStates ?? {}), [platform]: partState(part) };
        if (part.humanHelp != null) run.platformHumanHelp = { ...(run.platformHumanHelp ?? {}), [platform]: part.humanHelp };
        run.platformInterruptions = { ...(run.platformInterruptions ?? {}) };
        delete run.platformInterruptions[platform];
        if (partState(part) === 'interrupted') {
            run.platformInterruptions[platform] = part.interruption;
            run.stopAfterTask = true;
        }
        merged.push(`${platform}：${(part.shops ?? []).length} 家店`);
    }
    const covered = new Set(files.map((f) => String(readJsonFile(join(runDir, f)).platform).trim()));
    const missing = (run.platforms ?? []).filter((p) => !covered.has(p));
    const problems = [
        ...(partial ? [] : missing.map((p) => `平台「${p}」没有 run-<平台>.json：子代理还没写完，或该平台需要在记录文件里写明 skipped 原因`)),
        ...validateRun(run),
    ];
    if (problems.length) {
        console.error('合并没有写入 run.json：\n- ' + problems.join('\n- '));
        process.exit(2);
    }
    const temporary = join(runDir, `.run-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(run, null, 2), { flag: 'wx' });
    renameSync(temporary, runPath);
    console.log(`已合并到 ${runPath}\n` + merged.join('\n'));
}

/**
 * 子代理结束前自检自己的平台记录文件：能读出来、平台名对、每家店的必填项和型号 ID 与本次的 run.json 对得上、
 * 已记下全部结束的时间。有问题时列出并以 2 退出，子代理改好再结束。
 */
function check(runDir, platform, args = []) {
    const run = readJsonFile(join(runDir, 'run.json'));
    const part = readJsonFile(platformFile(runDir, platform));
    const problems = validatePart(run, part, platform, args.includes('--partial'));
    if (problems.length) {
        console.error(`run-${platform}.json 有问题：\n- ` + problems.join('\n- '));
        process.exit(2);
    }
    console.log(`run-${platform}.json 检查通过：${part.skipped ? `本平台跳过（${part.skipped}）` : `${(part.shops ?? []).length} 家店`}`);
}

/** 子代理打卡：追加一行时间和正在做的事。停下等人处理时带 --paused，watch 不把它算作卡住 */
function beat(runDir, platform, args) {
    if (!existsSync(join(runDir, 'run.json'))) {
        throw new Error(`${runDir} 里没有 run.json，本次目录写错了`);
    }
    const paused = args.includes('--paused');
    const doing = args.filter((a) => a !== '--paused').join(' ');
    appendFileSync(beatFile(runDir, platform), JSON.stringify({ at: new Date().toISOString(), paused, doing }) + '\n');
    console.log('ok');
}

/** 读文件，读不出来（如正在写入）时返回 null */
function tryRead(read) {
    try {
        return read();
    } catch {
        return null;
    }
}

/**
 * 主代理盯子代理：每 15 秒看一次各平台的打卡。某个平台超过 subagents.stallMinutes 分钟没打卡（停下等人处理的不算），
 * 或所有平台都已结束（平台文件里有 stages.repliesDone 或 skipped）时，输出情况并退出；--once 只看一次。
 * 还没打过卡的平台从 watch 开始时算起。maxGapMinutes 是这个平台两次打卡之间最长隔了几分钟，供调整 stallMinutes 参考。
 */
function watch(runDir, args) {
    const run = readJsonFile(join(runDir, 'run.json'));
    const platforms = (run.platforms ?? []).filter((p) => !(run.skippedPlatforms ?? []).some((s) => s.platform === p));
    const limitMs = Number(SETTINGS.subagents?.stallMinutes ?? 3) * 60000;
    const started = Date.now();
    const minutes = (ms) => Math.round(ms / 6000) / 10;
    const look = () => {
        const now = Date.now();
        const out = { stalled: [], running: [], paused: [], finished: [], interrupted: [] };
        for (const p of platforms) {
            const part = tryRead(() => JSON.parse(readFileSync(platformFile(runDir, p), 'utf8')));
            // 追加打卡时可能只读到最后一行的一部分，仍保留前面有效的暂停和时间记录。
            const beats = (tryRead(() => readFileSync(beatFile(runDir, p), 'utf8')) ?? '').split('\n')
                .map((line) => tryRead(() => JSON.parse(line)))
                .filter((b) => b && !Number.isNaN(Date.parse(b.at)));
            const times = beats.map((b) => Date.parse(b.at)).filter((t) => !Number.isNaN(t)).sort((x, y) => x - y);
            const gaps = times.slice(1).map((t, i) => t - times[i]);
            const last = beats[beats.length - 1];
            const since = times.length ? times[times.length - 1] : started;
            const row = { platform: p, lastBeat: last?.at ?? null, doing: last?.doing ?? '', idleMinutes: minutes(now - since),
                maxGapMinutes: gaps.length ? minutes(Math.max(...gaps)) : null };
            if (part && partState(part) === 'interrupted') out.interrupted.push({ ...row, reason: part.interruption?.reason ?? '' });
            else if (part && partState(part) === 'completed') out.finished.push(row);
            else if (last?.paused) out.paused.push(row);
            else if (now - since > limitMs) out.stalled.push(row);
            else out.running.push(row);
        }
        return out;
    };
    const outcome = (out) => out.stalled.length ? 'stalled' : out.running.length || out.paused.length ? 'running' : out.interrupted.length ? 'interrupted' : 'finished';
    const report = (result, out) => console.log(JSON.stringify({ result, stopAfterTask: !!run.stopAfterTask || !!out.interrupted.length, stallMinutes: limitMs / 60000, ...out }, null, 2));
    if (args.includes('--once')) {
        const out = look();
        report(outcome(out), out);
        return;
    }
    const timer = setInterval(() => {
        const out = look();
        if (out.stalled.length || (!out.running.length && !out.paused.length)) {
            clearInterval(timer);
            report(outcome(out), out);
        }
    }, WATCH_INTERVAL_MS);
}

function finish(runPath) {
    const run = loadRun(runPath);
    if (simulated(run)) throw new Error('模拟 run 不得写入真实询价记录');
    const snapshot = createHash('sha256').update(JSON.stringify(run)).digest('hex');
    const archiveKey = createHash('sha256').update(join(dirname(runPath), 'run.json') + '\n' + snapshot).digest('hex');
    const recorded = new Set(readJsonl(RECORDS).filter((r) => r.archiveKey === archiveKey).map((r) => r.archiveRow));
    const archived = readJsonl(PROCESSED).some((r) => r.archiveKey === archiveKey);
    if (archived) {
        console.log(`本次快照已归档，未重复写入：${archiveKey}`);
        return;
    }
    const modelOf = new Map(run.items.map((i) => [String(i.itemId), i.model]));
    const now = new Date().toISOString();
    const lines = [];
    let quoteCount = 0;
    const platforms = new Set();
    for (const s of run.shops ?? []) {
        // 仅挑中的候选没有实际询价；公开挂牌价与沿用报价仍是可用业务记录。
        if (!s.sentAt && !s.reusedFrom && s.status !== '挂牌价') continue;
        const platform = s.platform;
        platforms.add(platform);
        // 没有报价的店（未回复、无货等）也按型号各记一行，用于防重复询价
        const quotes = [...(s.quotes ?? [])];
        for (const id of s.itemIds ?? (quotes.length ? [] : run.items.map((i) => i.itemId))) {
            if (!quotes.some((q) => String(q.itemId) === String(id))) quotes.push({ itemId: id });
        }
        // 沿用的报价保留原记录时间，不按今天重新记，否则防重复窗口会被一直续上，旧报价被无限沿用
        const time = s.reusedFrom ?? now;
        for (const q of quotes) {
            if (q.price != null && q.price !== '') quoteCount++;
            const archiveRow = lines.length;
            lines.push(JSON.stringify({
                archiveKey, archiveRow, recordedAt: now,
                time, task: run.task, platform, reusedFrom: s.reusedFrom ?? null, model: modelOf.get(String(q.itemId)) ?? '',
                shop: s.shop, contact: s.contact ?? '', url: s.url ?? '', status: s.status, reply: s.reply ?? '',
                price: s.status === '无货' ? '无货' : String(q.price ?? ''),
                taxIncluded: !!q.taxIncluded, taxRate: q.taxRate ?? null,
                condition: q.condition ?? '', leadTime: q.leadTime ?? '', freeShipping: q.freeShipping !== false, sentAt: s.sentAt ?? '',
                note: q.note ?? '',
                endReason: s.endReason ?? '', stopQuestion: s.stopQuestion ?? null,
                followUps: s.followUps ?? 0, followUpAt: s.followUpAt ?? null, replyAt: s.replyAt ?? null, answeredTopics: s.answeredTopics ?? [],
                thankYou: s.thankYou ?? null, pendingMessage: s.pendingMessage ?? null,
            }));
        }
    }
    mkdirSync(DATA_DIR, { recursive: true });
    const missing = lines.filter((_, n) => !recorded.has(n));
    if (missing.length) {
        appendFileSync(RECORDS, missing.join('\n') + '\n');
    }
    appendFileSync(PROCESSED, JSON.stringify({
        time: now, task: run.task, taskId: run.taskId ?? null,
        archiveKey, snapshot, runDir: dirname(runPath), stopAfterTask: !!run.stopAfterTask,
        result: run.submitted ? 'submitted' : 'not-submitted', quotes: quoteCount, platforms: [...platforms],
    }) + '\n');
    console.log(`已写入询价记录 ${lines.length} 条；任务 ${run.task} 记为${run.submitted ? '已提交' : '未提交'}`);
}

/**
 * 统计近 N 天询价的结束原因，以及因店家提问而停止聊天的问题类型，供维护者判断是否扩大答复范围。
 * 沿用的报价不算（这次没有发消息）；同一任务里的同一家店有多个型号时只算一次。
 */
function stats(arg) {
    const days = Number(arg) > 0 ? Number(arg) : 30;
    const since = Date.now() - days * 86400000;
    const shops = new Map();
    for (const r of readJsonl(RECORDS)) {
        if (r.reusedFrom == null && Date.parse(r.time) >= since) shops.set(`${r.task}|${r.platform}|${r.shop}`, r);
    }
    const total = shops.size;
    const pct = (n) => `${((n * 100) / total).toFixed(1)}%`;
    const reasons = new Map();
    const types = new Map();
    // 从最近的记录往前数，举例时取最近的店家原话
    for (const r of [...shops.values()].sort((a, b) => Date.parse(b.time) - Date.parse(a.time))) {
        const reason = r.endReason || '未记录';
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
        if (!STOP_REASONS.includes(r.endReason)) continue;
        const key = `${r.endReason} · ${r.stopQuestion?.type || '未分类'}`;
        const t = types.get(key) ?? { n: 0, examples: [] };
        t.n++;
        const text = String(r.stopQuestion?.text ?? '').trim();
        if (text && t.examples.length < 3) t.examples.push(`「${text.slice(0, 40)}」`);
        types.set(key, t);
    }
    if (!total) {
        console.log(`近 ${days} 天没有询价记录`);
        return;
    }
    const lines = [`近 ${days} 天询价 ${total} 家店（沿用的报价不算，同一任务里的同一家店只算一次）`, '', '结束原因：'];
    for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) lines.push(`  ${k}：${n} 家（${pct(n)}）`);
    lines.push('', '因店家提问停止聊天，按问题类型：');
    if (!types.size) lines.push('  无');
    for (const [k, t] of [...types].sort((a, b) => b[1].n - a[1].n)) {
        lines.push(`  ${k}：${t.n} 家（${pct(t.n)}）${t.examples.length ? '，例：' + t.examples.join(' ') : ''}`);
    }
    lines.push('', '例子是店家原话，属于公司内部数据，不要放进公开仓库。');
    console.log(lines.join('\n'));
}

try {
    // version 仍可只复制 records.mjs 和 SKILL.md 运行，不读取或校验配置。
    if (cmd !== 'version') SETTINGS = (await import('./config.mjs')).readSettings().settings;
    if (cmd === 'version') {
        version();
    } else if (cmd === 'init') {
        init(args);
    } else if (cmd === 'install-helpers') {
        installHelpers(args);
    } else if (cmd === 'new-run' && args[0]) {
        newRun(args[0]);
    } else if (cmd === 'open-run' && args[0]) {
        newRun(args[0], true);
    } else if (cmd === 'recent' && args[0]) {
        recent(args[0], args[1]);
    } else if (cmd === 'processed' && args[0]) {
        processed(args[0]);
    } else if (cmd === 'next') {
        next(args);
    } else if ((cmd === 'skip' || cmd === 'manual') && args[0]) {
        mark(cmd === 'skip' ? 'skipped' : 'manual', args[0], args.slice(1).join(' ') || '未说明');
    } else if (cmd === 'check' && args[1]) {
        check(args[0], args[1], args.slice(2));
    } else if (cmd === 'beat' && args[1]) {
        beat(args[0], args[1], args.slice(2));
    } else if (cmd === 'watch' && args[0]) {
        watch(args[0], args.slice(1));
    } else if (cmd === 'merge' && args[0]) {
        merge(args[0], args.slice(1));
    } else if (cmd === 'erp-items' && args[0]) {
        erpItems(args[0], args.slice(1));
    } else if (cmd === 'finish' && args[0]) {
        finish(args[0]);
    } else if (cmd === 'stats') {
        stats(args[0]);
    } else {
        console.error([
            '用法：',
            '  node records.mjs version',
            '  node records.mjs init [--erp <ERP地址>]',
            '  node records.mjs install-helpers [--force]',
            '  node records.mjs new-run <任务编号>',
            '  node records.mjs open-run <任务编号>',
            `  node records.mjs recent <型号> [天数=${SETTINGS.dedupeDays}]`,
            '  node records.mjs processed <任务编号>',
            '  node records.mjs next <任务编号...>',
            '  node records.mjs skip <任务编号> <原因>',
            '  node records.mjs manual <任务编号> <原因>',
            '  node records.mjs check <本次目录> <平台> [--partial]',
            '  node records.mjs beat <本次目录> <平台> [--paused] [在做什么]',
            '  node records.mjs watch <本次目录> [--once]',
            '  node records.mjs merge <本次目录> [--partial <平台...>]',
            '  node records.mjs erp-items <run.json> [--draft]',
            '  node records.mjs finish <run.json>',
            '  node records.mjs stats [天数=30]',
        ].join('\n'));
        process.exit(1);
    }
} catch (e) {
    console.error('出错：' + e.message);
    process.exit(1);
}
