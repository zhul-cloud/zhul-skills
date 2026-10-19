#!/usr/bin/env node
// 本地询价记录工具（零依赖，Node 18+）。数据目录固定为用户主目录下的 .zhul-trade-sourcing（Windows %USERPROFILE%\.zhul-trade-sourcing\，macOS/Linux ~/.zhul-trade-sourcing/）
//   node records.mjs version                    只读本脚本所属技能的名称、版本和绝对目录，不初始化数据或读取业务设置
//   node records.mjs init [--erp <ERP地址>]       创建数据目录；带 --erp 时保存 ERP 地址。输出当前配置
//   node records.mjs install-helpers [--force]    维护者可选磁盘导出；需显式 BROWSEROS_HELPERS_DIR，copied 不等于 runtimeLoaded
//   node records.mjs new-run <任务编号>           恢复唯一未提交 run；没有时新建，输出路径
//   node records.mjs open-run <任务编号>          同 new-run，输出 JSON（恢复标志、已完成平台、ERP 核对提示）
//   node records.mjs plan-inquiry <本次目录>       主执行者按最新平台事实保存首轮/补轮累计授权，输出有效/等待/不足原因
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

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
let validateIdentity, coverageProblems, coverageTransitionProblems, inquiryFactProblems, inquiryCheckpointProblems, planInquiry;
let initializeData, withCurrentData, withDataRead, currentVersion;
let store;

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
    const result = initializeData(() => {
        store.recoverPending();
        const config = readConfig();
        const effectiveUrl = erpUrl ?? (config.erpUrl == null || config.erpUrl === '' ? null : normalizeErpUrl(config.erpUrl));
        mkdirSync(RUNS, { recursive: true });
        mkdirSync(LEARNINGS, { recursive: true });
        mkdirSync(REPORTS, { recursive: true });
        if (erpUrl !== undefined) {
            config.erpUrl = erpUrl;
            writeFileSync(CONFIG, JSON.stringify(config, null, 2));
        }
        return { dataDir: DATA_DIR, erpUrl: effectiveUrl };
    });
    console.log(JSON.stringify(result, null, 2));
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
    if (run.draftReceipt != null && !['not_sent', 'confirmed'].includes(run.draftReceipt.state)) throw new Error('草稿写入已发或结果未确认，只能用原 draftReceipt.payload 和 expectedSnapshot 核对；不得重新生成输入');
    if (!draft) {
        const problems = finalProblems(run);
        if (problems.length) throw new Error('不能生成正式提交报价：\n- ' + problems.join('\n- '));
    }
    if (!run.taskId) {
        console.error('run.json 缺少 taskId（ERP 任务 ID），请用 erpApi 的 task 结果写入');
        throw Object.assign(new Error('记录校验失败'), { exitCode: 2, reported: true });
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
        throw Object.assign(new Error('记录校验失败'), { exitCode: 2, reported: true });
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
        if (run.inquiryPlan) {
            const asked = (run.shops ?? []).filter(s => s.itemIds?.some(id => String(id) === String(i.itemId)) && (s.sentAt || s.reusedFrom));
            const unknown = (run.shops ?? []).some(s => s.itemIds?.some(id => String(id) === String(i.itemId)) && s.pendingMessage?.state === 'pending');
            if (!asked.length || unknown || asked.some(s => !s.noStockItemIds?.some(id => String(id) === String(i.itemId)))) {
                skipItemIds.push(Number(i.itemId));
                console.error(`型号 ${i.model}（itemId ${i.itemId}）无可填报价且未全部明确无货，需人工处理；有效报价不足不等于无货`);
                continue;
            }
            if (!ns.length) ns.push({ note: '所有实际联系商家均明确回复该型号无货' });
        }
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
        if (!existsSync(join(dir, 'run.json')) && readdirSync(dir).length === 0) continue; // 首次事务提交前失败留下的空目录不是业务断点。
        const run = store.readManaged(dir);
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
        const part = store.readPart(dir, platform, run);
        const problems = [...validatePart(run, part, platform, true), ...inquiryCheckpointProblems(run, run.inquiryPlan ? readParts(dir, run) : [], part, part)];
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
        run = store.createRun(dir, taskCode);
    }
    const progress = resumeProgress(dir, run);
    if (prior) {
        store.commit(dir, run, { event: { eventType: 'run.opened', phase: 'task' } });
        run = store.readManaged(dir);
    }
    console.log(json ? JSON.stringify({ runDir: dir, runId: run.runId, skillVersion: run.skillVersion, executionVersion: currentVersion(), revision: run.revision, resumed: !!prior, needsErpReconcile: true, ...progress }, null, 2) : dir);
}

function recent(model, days = SETTINGS.dedupeDays) {
    const since = Date.now() - Number(days) * 86400000;
    const key = normModel(model);
    const perRun = new Map();
    for (const [index, row] of readJsonl(RECORDS).entries()) {
        if (normModel(row.model) === key) perRun.set(JSON.stringify([row.runId, row.platform, row.shop, String(row.itemId)]), { row, index });
    }
    // 先按每个 run/型号取最后纠正，不能按时间排序复活同 run 已撤销的旧价。
    const latest = new Map();
    for (const candidate of perRun.values()) {
        const time = Date.parse(candidate.row.time);
        if (!Number.isFinite(time)) continue;
        const shopKey = JSON.stringify([candidate.row.platform, candidate.row.shop, key]);
        const previous = latest.get(shopKey);
        const recordedAt = Date.parse(candidate.row.recordedAt);
        const rank = [time, Number.isFinite(recordedAt) ? recordedAt : -Infinity, candidate.index];
        if (!previous || rank[0] > previous.rank[0] || rank[0] === previous.rank[0]
            && (rank[1] > previous.rank[1] || rank[1] === previous.rank[1] && rank[2] > previous.rank[2])) {
            latest.set(shopKey, { row: candidate.row, rank });
        }
    }
    // 跨 run 按业务时间择新后再检查窗口，旧 run 的迟归档不遮蔽新询价。
    const hits = [...latest.values()].map(({ row }) => row).filter((r) => Date.parse(r.time) >= since);
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
    const prior = resumableRun(taskCode);
    const content = (existsSync(PROCESSED) ? readFileSync(PROCESSED, 'utf8') : '') + JSON.stringify({ time: new Date().toISOString(), task: taskCode, result, reason,
        ...(prior?.run ? { runId: prior.run.runId, skillVersion: prior.run.skillVersion, executionVersion: currentVersion() } : {}) }) + '\n';
    if (prior?.run) store.commit(prior.dir, prior.run, { event: { eventType: result === 'manual' ? 'task.manual' : 'task.skipped', phase: 'task', reason, outcome: result }, writes: [{ path: PROCESSED, content }] });
    else store.queueEvent(taskCode, result, reason, PROCESSED, content);
    console.log(`任务 ${taskCode} 已记为${result === 'manual' ? '需人工处理' : '跳过'}：${reason}`);
}

function validateRun(run) {
    const problems = [];
    if (run.userStopped !== undefined && typeof run.userStopped !== 'boolean') problems.push('userStopped 必须是布尔值');
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
    if (run.draftReceipt != null) {
        const r = run.draftReceipt;
        const object = v => v != null && typeof v === 'object' && !Array.isArray(v);
        if (!object(r) || !['pending', 'unknown', 'failed', 'confirmed', 'not_sent'].includes(r.state) || !validTime(r.at)
            || !object(r.payload) || String(r.payload.taskId) !== String(run.taskId) || !Array.isArray(r.payload.items) || !object(r.expectedSnapshot)) problems.push('draftReceipt：需要合法state/at、原payload及expectedSnapshot');
        if (r.state === 'not_sent' && r.writeAttempted !== false) problems.push('draftReceipt.not_sent 必须有明确 writeAttempted:false');
        if (r.state === 'confirmed') {
            const verified = r.verifiedItemIds;
            if (!validTime(r.verifiedAt) || r.verify?.ok !== true || !Array.isArray(r.verify?.mismatches) || r.verify.mismatches.length
                || !Array.isArray(verified) || !verified.length || new Set(verified.map(String)).size !== verified.length
                || verified.some(id => !ids.has(String(id))) || !Array.isArray(r.snapshot?.items)
                || (r.payload?.items ?? []).some(i => !(r.payload.skipItemIds ?? []).some(id => String(id) === String(i.itemId)) && !verified.some(id => String(id) === String(i.itemId)))
                || (verified ?? []).some(id => !r.snapshot?.items?.some(i => String(i.itemId) === String(id)))) problems.push('draftReceipt.confirmed 缺少本次成功verify、完整verifiedItemIds、同次snapshot及verifiedAt');
        }
    }
    (run.shops ?? []).forEach((s, n) => {
        const at = `shops 第 ${n + 1} 家（${s.shop ?? '未命名'}）`;
        if (!String(s.shop ?? '').trim()) problems.push(`${at}：缺少店铺名称`);
        if (!String(s.platform ?? '').trim()) problems.push(`${at}：缺少 platform（平台）`);
        if (s.identity != null) problems.push(...validateIdentity(s.identity, s.platform).map((problem) => `${at}：${problem}`));
        if (s.identity != null && s.contact && s.contact !== s.identity.contact) problems.push(`${at}：contact 与已核实 identity.contact 不一致`);
        if (!STATUSES.includes(s.status)) problems.push(`${at}：status 只能是 ${STATUSES.join(' / ')}`);
        for (const key of ['sentAt', 'followUpAt', 'replyAt']) {
            if (s[key] != null && s[key] !== '' && !validTime(s[key])) problems.push(`${at}：${key} 应为有效时间`);
        }
        if (s.followUps != null && (!Number.isInteger(s.followUps) || s.followUps < 0)) problems.push(`${at}：followUps 应为非负整数`);
        if (s.answeredTopics != null && !Array.isArray(s.answeredTopics)) problems.push(`${at}：answeredTopics 应为数组`);
        if (s.pendingMessage != null) {
            const m = s.pendingMessage;
            if (typeof m.messageId !== 'string' || !m.messageId.trim() || m.messageId.length > 200) problems.push(`${at}：pendingMessage需要稳定messageId`);
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
            for (const key of ['taxIncluded', 'freeShipping']) {
                if (Object.hasOwn(q, key) && typeof q[key] !== 'boolean') problems.push(`${at}：itemId ${q.itemId} 的 ${key} 应为布尔值`);
            }
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
    for (const incident of run.incidents ?? []) {
        if (incident.type !== 'message.correction') continue;
        if (!CHANNELS.includes(incident.platform) || incident.pendingMessage?.kind !== 'correction'
            || !Array.isArray(incident.itemIds) || !incident.itemIds.length) problems.push('更正事件需要本平台、实际targetShop/itemIds及kind:correction的pendingMessage');
        problems.push(...validateRun({ task: run.task, items: run.items, shops: [{ platform: incident.platform, shop: incident.targetShop,
            itemIds: incident.itemIds, status: '未回复', quotes: [], pendingMessage: incident.pendingMessage }] }).map(p => `更正事件：${p}`));
    }
    for (const n of run.noStock ?? []) {
        if (!ids.has(String(n.itemId))) problems.push(`noStock：itemId ${n.itemId} 不在本任务里`);
    }
    for (const n of run.incompleteItems ?? []) {
        if (!ids.has(String(n.itemId))) problems.push(`incompleteItems：itemId ${n.itemId} 不在本任务里`);
        if (!String(n.reason ?? '').trim()) problems.push(`incompleteItems：itemId ${n.itemId} 缺少未完成原因 reason`);
    }
    for (const platform of new Set((run.shops ?? []).map(s => s.platform))) problems.push(...inquiryFactProblems(run, { platform, shops: run.shops.filter(s => s.platform === platform) }));
    return problems;
}

function loadRun(path) {
    if (basename(path) !== 'run.json') throw new Error('必须指定 run.json');
    const run = store.readManaged(dirname(path));
    const problems = validateRun(run);
    if (problems.length) {
        console.error('run.json 有问题：\n- ' + problems.join('\n- '));
        throw Object.assign(new Error('记录校验失败'), { exitCode: 2, reported: true });
    }
    return run;
}

const validTime = (value) => typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
const partState = (part) => part.status ?? (part.skipped || part.stages?.repliesDone ? 'completed' : 'running');
const humanHelpBlocked = (help) => help != null && (help.status !== 'resolved' || help.verified !== true || !validTime(help.verifiedAt));
const readParts = (dir, run, tolerateUnavailable = false) => run.platforms.map(platform => {
    try { return store.readPart(dir, platform, run); }
    catch (error) {
        if (!tolerateUnavailable) throw error;
        // 仅保存独立结果时的只读缺失视图，不写成真实平台中断，也不用于授权新首发或补轮。
        return { platform, status: 'interrupted', shops: [], unavailableReason: error.message };
    }
}).filter(Boolean);

function planInquiryRun(runDir) {
    const run = store.readManaged(runDir);
    if (!run.items?.length || !run.platforms?.length || run.submitted) throw new Error('INQUIRY_PLAN: 需要本任务未提交的已绑定明细及平台');
    const parts = readParts(runDir, run);
    for (const part of parts) {
        const problems = validatePart(run, part, part.platform, true);
        if (problems.length) throw new Error('INQUIRY_PLAN: ' + problems.join('；'));
    }
    const result = planInquiry(run, parts, SETTINGS.inquiryStrategy);
    if (result.changed) {
        run.inquiryPlan = result.plan;
        run.revision++;
        store.commit(runDir, run, { event: { eventType: 'inquiry.planned', phase: 'selection',
            correlationId: `inquiry-round-${result.plan.round}`, outcome: result.plan.round === 1 ? 'initial' : 'supplement' } });
    }
    console.log(JSON.stringify(result, null, 2));
}

function finalProblems(run) {
    const problems = [];
    if (run.userStopped) problems.push('用户已停止本次询价，未经明确恢复不能正式提交');
    if (simulated(run)) problems.push('模拟 run 不得提交');
    if (!run.platforms?.length) problems.push('缺少 platforms');
    if (humanHelpBlocked(run.humanHelp)) problems.push('ERP 人助尚未核验解除，不能正式提交');
    for (const platform of run.platforms ?? []) {
        if (run.platformStates?.[platform] !== 'completed') problems.push(`${platform} 尚未完成（${run.platformStates?.[platform] ?? '缺少结果'}）`);
        if (humanHelpBlocked(run.platformHumanHelp?.[platform])) problems.push(`${platform} 人助尚未核验解除，不能正式提交`);
    }
    if (run.stopAfterTask) problems.push('本轮因中断停止，恢复并核对后才能提交');
    for (const shop of run.shops ?? []) if (shop.pendingMessage?.state === 'pending') problems.push(`${shop.shop} 有未确认发送，先核对聊天界面`);
    for (const incident of run.incidents ?? []) if (incident.type === 'message.correction' && incident.pendingMessage?.state === 'pending') problems.push(`${incident.targetShop} 有未确认更正，先核对聊天界面`);
    return problems;
}

function validatePart(run, part, platform, partial = false, effectiveSettings) {
    const problems = [...coverageProblems(run, part, effectiveSettings), ...inquiryFactProblems(run, part)];
    if (run.platforms && !run.platforms.includes(platform)) problems.push(`平台「${platform}」不在本次 platforms 里`);
    if (String(part.platform ?? '').trim() !== platform) {
        problems.push(`platform 应为「${platform}」，现在是「${part.platform ?? ''}」`);
    }
    const shops = (part.shops ?? []).map((s) => ({ ...s, platform }));
    problems.push(...validateRun({ task: run.task, items: run.items, shops, noStock: part.noStock, incompleteItems: part.incompleteItems,
        incidents: (part.incidents ?? []).map(i => ({ ...i, platform })) }));
    const state = partState(part);
    if (!['running', 'completed', 'interrupted'].includes(state)) problems.push('status 应为 running / completed / interrupted');
    if (part.skipped && state !== 'completed') problems.push('skipped 平台应为 completed');
    if (state === 'completed' && !part.skipped && !validTime(part.stages?.repliesDone)) problems.push('stages.repliesDone 为空：所有店都结束后记下时间');
    if (state !== 'completed' && (part.stages?.repliesDone || part.endedAt)) problems.push('未完成平台不得填写 repliesDone 或平台 endedAt');
    if (state === 'interrupted' && !String(part.interruption?.reason ?? '').trim()) problems.push('interrupted 需要 interruption.reason');
    if (!partial && state !== 'completed') problems.push(`平台 ${state}，只能用 --partial 保存中途快照`);
    if (state === 'completed' && (part.shops ?? []).some((s) => s.pendingMessage?.state === 'pending')) problems.push('已完成平台仍有未确认发送，先核对聊天界面');
    if (state === 'completed' && (part.incidents ?? []).some(i => i.type === 'message.correction' && i.pendingMessage?.state === 'pending')) problems.push('已完成平台仍有未确认更正，先核对聊天界面');
    if (state === 'completed' && humanHelpBlocked(part.humanHelp)) problems.push('已完成平台的人助尚未核验解除，需要 resolved、verified:true 和有效 verifiedAt');
    return problems;
}

/**
 * 把子代理写的各平台记录 run-<平台>.json 合并进本次目录的 run.json；重复执行时按平台覆盖，不会重复追加。
 * run.json 的 platforms 里每个平台都要有记录文件，否则报错退出；合并结果校验通过后才写回 run.json。
 */
function merge(runDir, args = []) {
    const runPath = join(runDir, 'run.json');
    const run = store.readManaged(runDir);
    const before = store.stable(store.business(run));
    const partial = args.includes('--partial');
    const selected = args.filter((a) => a !== '--partial');
    if (partial && !selected.length) throw new Error('merge --partial 必须明确指定平台');
    const files = partial ? [...new Set(selected)].map((p) => `run-${p}.json`) : readdirSync(runDir).filter((f) => /^run-.+\.json$/.test(f));
    if (!files.length) {
        console.error(`${runDir} 里没有 run-<平台>.json`);
        throw Object.assign(new Error('记录校验失败'), { exitCode: 2, reported: true });
    }
    const merged = [], covered = new Set();
    for (const f of files) {
        const part = store.readPart(runDir, f.slice(4, -5), run);
        const platform = String(part.platform ?? '').trim();
        if (!platform) {
            console.error(`${f}：缺少 platform（平台）`);
            throw Object.assign(new Error('记录校验失败'), { exitCode: 2, reported: true });
        }
        const problems = [...validatePart(run, part, f.slice(4, -5), partial),
            ...inquiryCheckpointProblems(run, run.inquiryPlan ? readParts(runDir, run, partial) : [], part, part)];
        if (problems.length) {
            console.error(`${f} 有问题，合并没有写入 run.json：\n- ` + problems.join('\n- '));
            throw Object.assign(new Error('记录校验失败'), { exitCode: 2, reported: true });
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
        covered.add(platform);
    }
    const missing = (run.platforms ?? []).filter((p) => !covered.has(p));
    const problems = [
        ...(partial ? [] : missing.map((p) => `平台「${p}」没有 run-<平台>.json：子代理还没写完，或该平台需要在记录文件里写明 skipped 原因`)),
        ...validateRun(run),
    ];
    if (problems.length) {
        console.error('合并没有写入 run.json：\n- ' + problems.join('\n- '));
        throw Object.assign(new Error('记录校验失败'), { exitCode: 2, reported: true });
    }
    if (before !== store.stable(store.business(run))) {
        run.revision++;
        store.commit(runDir, run, { event: { eventType: 'platform.merged', phase: 'platform', outcome: [...covered].join(',') } });
    }
    console.log(`已合并到 ${runPath}\n` + merged.join('\n'));
}

/**
 * 子代理结束前自检自己的平台记录文件：能读出来、平台名对、每家店的必填项和型号 ID 与本次的 run.json 对得上、
 * 已记下全部结束的时间。有问题时列出并以 2 退出，子代理改好再结束。
 */
function check(runDir, platform, args = []) {
    const run = store.readManaged(runDir);
    const part = store.readPart(runDir, platform, run);
    if (!part) throw new Error(`找不到 run-${platform}.json`);
    const problems = [...validatePart(run, part, platform, args.includes('--partial')),
        ...inquiryCheckpointProblems(run, run.inquiryPlan ? readParts(runDir, run, true) : [], part, part)];
    if (problems.length) {
        console.error(`run-${platform}.json 有问题：\n- ` + problems.join('\n- '));
        throw Object.assign(new Error('记录校验失败'), { exitCode: 2, reported: true });
    }
    console.log(`run-${platform}.json 检查通过：${part.skipped ? `本平台跳过（${part.skipped}）` : `${(part.shops ?? []).length} 家店`}`);
}

/** 主/平台统一保存入口。业务快照由调用者提供；身份、版本、序号由脚本维护。 */
function checkpoint(runDir, inputPath, eventOnly = false) {
    const input = readJsonFile(inputPath), run = store.readManaged(runDir);
    if (!input || input.runId !== run.runId) throw new Error('RUN_ID: 输入不属于当前 run');
    const allowed = ['runId', 'eventId', 'actor', 'event', ...(eventOnly ? [] : ['scope', 'platform', 'expectedRevision', 'snapshot'])];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('CHECKPOINT_INPUT: 含未知输入字段');
    if (typeof input.eventId !== 'string' || !input.eventId.trim() || input.eventId.length > 200) throw new Error('EVENT_ID: 需要稳定 eventId');
    const prior = store.previousEvent(run, input.eventId, input);
    if (prior) { console.log(JSON.stringify(prior)); return; }
    let next = { ...run }, writes = [];
    if (!eventOnly) {
        if (!['run', 'platform'].includes(input.scope) || input.snapshot == null || typeof input.snapshot !== 'object' || Array.isArray(input.snapshot)) throw new Error('CHECKPOINT_INPUT: 需要scope和完整snapshot');
        const platform = input.platform;
        if (input.actor !== 'main' && !(input.scope === 'platform' && input.actor === platform)) throw new Error('CHECKPOINT_OWNER: 平台执行者只能保存自身平台');
        if (input.scope === 'run' && platform != null) throw new Error('CHECKPOINT_INPUT: run scope不能指定platform');
        const old = input.scope === 'run' ? run : store.readPart(runDir, platform, run);
        const revision = old?.revision ?? 0;
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== revision) throw new Error(`REVISION_CONFLICT: 预期 ${input.expectedRevision}，当前 ${revision}；重新读取并合并，不盲重放旧快照`);
        for (const key of store.META) if (Object.hasOwn(input.snapshot, key) && store.stable(input.snapshot[key]) !== store.stable(old?.[key])) throw new Error(`RUN_METADATA: ${key} 由脚本维护`);
        const snapshot = store.business(input.snapshot);
        if (input.scope === 'run') {
            if (store.stable(snapshot.inquiryPlan) !== store.stable(run.inquiryPlan)) throw new Error('INQUIRY_PLAN: 补店授权只能由主执行者 plan-inquiry 计算保存');
            if (snapshot.task !== run.task || run.taskId != null && snapshot.taskId !== run.taskId
                || run.items.length && store.stable(snapshot.items?.map(i => [String(i.itemId), i.model])) !== store.stable(run.items.map(i => [String(i.itemId), i.model]))) throw new Error('RUN_IDENTITY: 不能改变已绑定任务或型号身份');
            if (run.platforms.length && store.stable(snapshot.platforms) !== store.stable(run.platforms)) throw new Error('RUN_PLATFORM: 不能改变已绑定平台范围');
            if (validTime(run.deadline) && snapshot.deadline !== run.deadline || run.quoteDeadline != null && snapshot.quoteDeadline !== run.quoteDeadline) throw new Error('RUN_DEADLINE: 不能重置或删除原任务截止时间');
            for (const key of ['shops', 'noStock', 'incompleteItems', 'skippedPlatforms', 'platformStages', 'platformStates', 'platformHumanHelp', 'platformInterruptions']) {
                const empty = v => v == null || typeof v === 'object' && Object.keys(v).length === 0;
                if (store.stable(snapshot[key]) !== store.stable(run[key]) && !(empty(snapshot[key]) && empty(run[key]))) throw new Error(`CHECKPOINT_OWNER: ${key} 仅由平台checkpoint和merge维护`);
            }
            if (store.stable((snapshot.incidents ?? []).filter(i => i.platform != null)) !== store.stable((run.incidents ?? []).filter(i => i.platform != null))) throw new Error('CHECKPOINT_OWNER: 必须保留已有平台incidents');
            next = { ...snapshot, ...Object.fromEntries(store.META.map(key => [key, run[key]])), revision: revision + 1 };
            const problems = validateRun(next);
            if (problems.length) throw new Error('CHECKPOINT_INVALID: ' + problems.join('；'));
        } else {
            if (snapshot.platform !== platform) throw new Error('RUN_PLATFORM: snapshot.platform与scope不符');
            // 已完成平台不因用户后改目标重新挑店；新/未完平台写入必须使用本次有效配额。
            const quota = run.inquiryPlan ? { inquiryStrategy: run.inquiryPlan.policy } : SETTINGS;
            const newInitial = (snapshot.shops ?? []).some(s => s.pendingMessage?.kind === 'initial' && s.pendingMessage.state === 'pending'
                && !(old?.shops ?? []).some(prior => prior.pendingMessage?.messageId === s.pendingMessage.messageId && prior.pendingMessage.kind === 'initial' && prior.pendingMessage.state === 'pending'));
            const parts = readParts(runDir, run, !newInitial);
            const problems = [...validatePart(run, snapshot, platform, true, quota), ...coverageTransitionProblems(old, snapshot),
                ...inquiryCheckpointProblems(run, parts, old, snapshot)];
            if (problems.length) throw new Error('CHECKPOINT_INVALID: ' + problems.join('；'));
            const at = new Date().toISOString();
            const part = { ...snapshot, schemaVersion: 1, runId: run.runId, skillVersion: run.skillVersion, executionVersion: currentVersion(), revision: revision + 1,
                createdAt: old?.createdAt ?? at, updatedAt: at };
            writes.push({ path: platformFile(runDir, platform), content: JSON.stringify(part, null, 2) + '\n', revision: part.revision });
        }
    }
    const event = { ...input.event };
    if (!eventOnly && input.scope === 'platform') {
        if (event.platform != null && event.platform !== input.platform) throw new Error('EVENT_PLATFORM: 事件平台必须与checkpoint目标一致');
        event.platform = input.platform;
    }
    if (!eventOnly && /^message\./.test(event.eventType)) {
        if (input.scope !== 'platform') throw new Error('EVENT_MESSAGE: 消息事实必须保存在平台checkpoint');
        const subjects = event.messageKind === 'correction'
            ? (input.snapshot.incidents ?? []).filter(i => i.type === 'message.correction' && i.targetShop === event.shop
                && i.pendingMessage?.messageId === event.messageId && i.pendingMessage?.kind === event.messageKind)
            : (input.snapshot.shops ?? []).filter(s => s.shop === event.shop
                && s.pendingMessage?.messageId === event.messageId && s.pendingMessage?.kind === event.messageKind);
        if (subjects.length !== 1) throw new Error('EVENT_MESSAGE: 店名/messageId/kind 必须唯一对应当前发送意图');
        const subject = subjects[0];
        const message = subject?.pendingMessage;
        const state = event.eventType === 'message.confirmed' ? 'confirmed' : event.eventType === 'message.cancelled' ? 'cancelled' : 'pending';
        if (message?.messageId !== event.messageId || message?.kind !== event.messageKind || message?.state !== state
            || !(event.itemIds ?? []).every(id => subject?.itemIds?.some(x => String(x) === String(id)))) throw new Error('EVENT_MESSAGE: 事件必须关联本店当前pendingMessage的messageId/kind/state/itemIds');
    }
    store.eventFields(next, input.actor, event);
    const result = store.commit(runDir, next, { event, actor: input.actor, eventId: input.eventId, writes, request: input });
    console.log(JSON.stringify(result));
}

/** 子代理打卡：追加一行时间和正在做的事。停下等人处理时带 --paused，watch 不把它算作卡住 */
function beat(runDir, platform, args) {
    const run = store.readManaged(runDir);
    if (!run.platforms.includes(platform)) throw new Error('平台不在本次任务中');
    const paused = args.includes('--paused');
    const doing = args.filter((a) => a !== '--paused').join(' ');
    const path = beatFile(runDir, platform);
    store.commit(runDir, run, { actor: platform, event: { eventType: 'heartbeat', phase: 'platform', outcome: paused ? 'paused' : 'running' },
        writes: [{ path, content: (existsSync(path) ? readFileSync(path, 'utf8') : '') + JSON.stringify({ at: new Date().toISOString(), paused, doing }) + '\n' }] });
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
    const run = store.readManaged(runDir);
    const platforms = (run.platforms ?? []).filter((p) => !(run.skippedPlatforms ?? []).some((s) => s.platform === p));
    const limitMs = Number(SETTINGS.subagents?.stallMinutes ?? 3) * 60000;
    const started = Date.now();
    const minutes = (ms) => Math.round(ms / 6000) / 10;
    const look = () => withDataRead(() => {
        store.noPending();
        const current = store.readManaged(runDir);
        if (current.runId !== run.runId) throw new Error('RUN_ID: watch 的 run 已被替换');
        const now = Date.now();
        const out = { stopAfterTask: !!current.stopAfterTask, stalled: [], running: [], paused: [], finished: [], interrupted: [] };
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
    }, { waitMs: 5000 });
    const outcome = (out) => out.stalled.length ? 'stalled' : out.running.length || out.paused.length ? 'running' : out.interrupted.length ? 'interrupted' : 'finished';
    const report = (result, out) => console.log(JSON.stringify({ result, stallMinutes: limitMs / 60000, ...out, stopAfterTask: out.stopAfterTask || !!out.interrupted.length }, null, 2));
    if (args.includes('--once')) {
        const out = look();
        report(outcome(out), out);
        return;
    }
    const timer = setInterval(() => {
        try {
            const out = look();
            if (out.stalled.length || (!out.running.length && !out.paused.length)) {
                clearInterval(timer);
                report(outcome(out), out);
            }
        } catch (error) {
            clearInterval(timer);
            console.error('出错：' + error.message);
            process.exitCode = 1;
        }
    }, WATCH_INTERVAL_MS);
}

function finish(runPath) {
    const run = loadRun(runPath);
    if (simulated(run)) throw new Error('模拟 run 不得写入真实询价记录');
    const snapshot = createHash('sha256').update(store.stable(store.business(run))).digest('hex');
    const previousArchive = readJsonl(PROCESSED).filter((r) => r.runId === run.runId
        && typeof r.archiveKey === 'string' && typeof r.snapshot === 'string').at(-1);
    if (previousArchive?.snapshot === snapshot) {
        console.log(`本次快照已归档，未重复写入：${previousArchive.archiveKey}`);
        return;
    }
    // 相邻快照幂等；A→B→A 是新纠正，链上前一归档使其不会被历史 A 的行去重吞掉。
    const archiveKey = createHash('sha256').update(run.runId + '\n' + snapshot + '\n' + (previousArchive?.archiveKey ?? '')).digest('hex');
    const history = readJsonl(RECORDS);
    const recorded = new Set(history.filter((r) => r.archiveKey === archiveKey).map((r) => r.archiveRow));
    const rowKey = (r) => JSON.stringify([r.runId, r.platform, r.shop, String(r.itemId)]);
    const latest = new Map(history.filter((r) => r.runId === run.runId).map((r) => [rowKey(r), r]));
    // 有价行按本型号报价比较，店级共享回复/结论不能刷新其他型号旧价；无价行保留店级回复变化。
    const factFields = ['model', 'sentAt', 'status', 'price', 'taxIncluded', 'taxRate', 'condition', 'leadTime', 'freeShipping', 'note'];
    const rowFacts = (r) => store.stable(Object.fromEntries([
        ...factFields, ...(r.price !== '' && r.price !== '无货' ? [] : ['firstHumanReplyAt', 'reply', 'endReason', 'stopQuestion']),
    ].map((key) => {
        let value = r[key] ?? null;
        if (['price', 'taxRate'].includes(key) && (typeof value === 'number' || typeof value === 'string' && value.trim())
            && Number.isFinite(Number(value))) value = Number(value);
        return [key, value];
    })));
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
        for (const q of quotes) {
            if (q.price != null && q.price !== '') quoteCount++;
            const archiveRow = lines.length;
            const row = {
                archiveKey, archiveRow, recordedAt: now, runId: run.runId, skillVersion: run.skillVersion, executionVersion: currentVersion(),
                task: run.task, platform, itemId: q.itemId, reusedFrom: s.reusedFrom ?? null, model: modelOf.get(String(q.itemId)) ?? '',
                shop: s.shop, contact: s.contact ?? '', url: s.url ?? '', status: s.status, reply: s.reply ?? '',
                ...(s.identity != null ? { identity: s.identity } : {}),
                ...(s.businessEntity != null ? { businessEntity: s.businessEntity } : {}),
                ...(s.noStockItemIds != null ? { noStockItemIds: s.noStockItemIds } : {}),
                ...(q.comparability != null ? { comparability: q.comparability } : {}),
                price: s.status === '无货' ? '无货' : String(q.price ?? ''),
                taxIncluded: !!q.taxIncluded, taxRate: q.taxRate ?? null,
                condition: q.condition ?? '', leadTime: q.leadTime ?? '', freeShipping: q.freeShipping !== false, sentAt: s.sentAt ?? '',
                firstHumanReplyAt: s.firstHumanReplyAt ?? null,
                note: q.note ?? '',
                endReason: s.endReason ?? '', stopQuestion: s.stopQuestion ?? null,
                followUps: s.followUps ?? 0, followUpAt: s.followUpAt ?? null, replyAt: s.replyAt ?? null, answeredTopics: s.answeredTopics ?? [],
                thankYou: s.thankYou ?? null, pendingMessage: s.pendingMessage ?? null,
            };
            const previous = latest.get(rowKey(row));
            // 沿用时间优先；同一 run 的同店同型号业务事实未变时也保留原时间，归档时刻另记。
            row.time = s.reusedFrom ?? (previous && rowFacts(previous) === rowFacts(row) ? previous.time : now);
            lines.push(JSON.stringify(row));
        }
    }
    mkdirSync(DATA_DIR, { recursive: true });
    const missing = lines.filter((_, n) => !recorded.has(n));
    const writes = [];
    if (missing.length) writes.push({ path: RECORDS, content: (existsSync(RECORDS) ? readFileSync(RECORDS, 'utf8') : '') + missing.join('\n') + '\n' });
    writes.push({ path: PROCESSED, content: (existsSync(PROCESSED) ? readFileSync(PROCESSED, 'utf8') : '') + JSON.stringify({
        time: now, task: run.task, taskId: run.taskId ?? null,
        runId: run.runId, skillVersion: run.skillVersion, executionVersion: currentVersion(),
        archiveKey, snapshot, runDir: dirname(runPath), stopAfterTask: !!run.stopAfterTask,
        result: run.submitted ? 'submitted' : 'not-submitted', quotes: quoteCount, platforms: [...platforms],
    }) + '\n' });
    store.commit(dirname(runPath), run, { event: { eventType: 'run.archived', phase: 'archive', outcome: run.submitted ? 'submitted' : 'not-submitted' }, writes });
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
    const config = cmd === 'version' ? null : await import('./config.mjs');
    if (cmd !== 'version') {
        ({ initializeData, withCurrentData, withDataRead, currentVersion } = await import('./data-lifecycle.mjs'));
        store = await import('./run-store.mjs');
        validateIdentity = (await import('./contacts.mjs')).identityProblems;
        ({ coverageProblems, coverageTransitionProblems, inquiryFactProblems, inquiryCheckpointProblems, planInquiry } = await import('./search-coverage.mjs'));
    }
    const execute = () => {
    if (cmd !== 'version' && cmd !== 'init') SETTINGS = config.readSettings().settings;
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
    } else if (cmd === 'plan-inquiry' && args.length === 1) {
        planInquiryRun(args[0]);
    } else if (['checkpoint', 'event'].includes(cmd) && args.length === 2) {
        checkpoint(args[0], args[1], cmd === 'event');
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
            '  node records.mjs plan-inquiry <本次目录>',
            '  node records.mjs checkpoint <本次目录> <input.json>',
            '  node records.mjs event <本次目录> <event.json>',
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
        throw Object.assign(new Error('命令参数无效'), { exitCode: 1, reported: true });
    }
    };
    // init 自持生命周期锁；其余写入口只校验当前版，不自动清理。
    if (['install-helpers', 'new-run', 'open-run', 'skip', 'manual', 'beat', 'merge', 'finish', 'checkpoint', 'event', 'plan-inquiry'].includes(cmd)) {
        withCurrentData(() => { store.recoverPending(); execute(); }, { waitMs: 5000 });
    } else if (['check', 'erp-items'].includes(cmd)) {
        withCurrentData(() => { store.noPending(); execute(); }, { waitMs: 5000 });
    } else if (cmd === 'next') {
        withDataRead(() => { store.noPending(); execute(); }, { waitMs: 5000 });
    } else {
        if (cmd !== 'version' && cmd !== 'init') store.noPending();
        execute();
    }
} catch (e) {
    if (!e.reported) console.error('出错：' + e.message);
    process.exitCode = e.exitCode ?? 1;
}
