// 默认值与个人稀疏覆盖的共同读取、校验和写入边界（零依赖，Node 18+）。
import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const DATA_DIR = join(homedir(), '.zhul-trade-sourcing');
export const DEFAULTS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'settings.json');
export const USER_SETTINGS_PATH = join(DATA_DIR, 'settings.json');

export const fields = {
    confirmBeforeSend: ['boolean', '发询价前是否先请用户确认店铺与话术'],
    'inquiryStrategy.initialShopsPerPlatform': ['positiveInteger', '每个ERP明细在每个平台首轮联系的不同商家数'],
    'inquiryStrategy.targetComparableQuotes': ['positiveInteger', '每个ERP明细跨平台的有效可比报价商家目标'],
    'inquiryStrategy.maxShopsPerPlatform': ['positiveInteger', '每个ERP明细在每个平台累计联系的不同商家上限'],
    firstHumanReplyMinutes: ['nonnegativeNumber', '等待首次人工回复的分钟数；0 表示即时结束'],
    followUpReplyMinutes: ['nonnegativeNumber', '追问或答复后等待的分钟数；0 表示即时结束'],
    'pollIntervalSeconds.min': ['positiveNumber', '查看回复的最短秒数；建议不低于 10'],
    'pollIntervalSeconds.max': ['positiveNumber', '查看回复的最长秒数'],
    maxFollowUpsPerShop: ['nonnegativeInteger', '每家店最多追问次数；建议 0–2，0 表示不追问'],
    dedupeDays: ['nonnegativeNumber', '同店同型号防重复天数；0 表示不防重复'],
    priceOutlierPercent: ['percent', '同型号不含税单价低于各家中位价的异常提醒阈值，单位为百分比'],
    thankYouMessages: ['messages', '信息齐全后选用的道谢话术；至少 3 句非空字符串'],
    'subagents.enabled': ['boolean', '有多个平台且客户端支持时，是否启用平台子代理'],
    'subagents.stallMinutes': ['positiveNumber', '子代理多久未打卡视为卡住，单位为分钟'],
    'subagents.claude.model': ['string', 'Claude Code 平台子代理模型；空字符串继承'],
    'subagents.claude.effort': ['claudeEffort', 'Claude Code 思考深度；low/medium/high/xhigh/max，空字符串继承'],
    'subagents.codex.model': ['string', 'Codex 平台子代理模型 ID；空字符串继承，实际可用性由运行时核对'],
    'subagents.codex.effort': ['codexEffort', 'Codex 思考深度；low/medium/high/xhigh/max/ultra，空字符串继承'],
};
export const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const get = (value, key) => key.split('.').reduce((part, name) => object(part) && Object.hasOwn(part, name) ? part[name] : undefined, value);
const fail = (key, reason) => { throw new Error(`${key}：${reason}`); };

export function parseJson(text, label) {
    if (text.startsWith('\uFEFF')) throw new Error(`${label}：请保存为 UTF-8 无 BOM 格式`);
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`${label}：不是有效的 UTF-8 JSON`);
    }
    function safe(value) {
        if (value === null || typeof value !== 'object') return;
        for (const [key, item] of Object.entries(value)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`${label}：${key}：禁止原型路径`);
            safe(item);
        }
    }
    safe(parsed);
    return parsed;
}

export function readText(path, label) {
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
    } catch (error) {
        throw new Error(`${label}：无法读取文件（${error.code || '读取失败'}）`);
    }
}

export function validate(settings) {
    if (!object(settings)) fail('settings.json', '顶层必须是对象');
    function checkKeys(value, prefix = '') {
        for (const [name, item] of Object.entries(value)) {
            const key = prefix ? `${prefix}.${name}` : name;
            if (['__proto__', 'prototype', 'constructor'].includes(name)) fail(key, '禁止原型路径');
            if (name.includes('.')) fail(key, '未知配置键，请使用嵌套对象');
            if (Object.hasOwn(fields, key)) continue;
            if (!Object.keys(fields).some((field) => field.startsWith(`${key}.`))) fail(key, '未知配置键，请手工移除或纠正');
            if (object(item)) checkKeys(item, key);
        }
    }
    checkKeys(settings);
    for (const key of ['inquiryStrategy', 'pollIntervalSeconds', 'subagents', 'subagents.claude', 'subagents.codex']) {
        if (!object(get(settings, key))) fail(key, '必须是对象');
    }
    const efforts = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
    for (const [key, [type]] of Object.entries(fields)) {
        const value = get(settings, key);
        const number = typeof value === 'number' && Number.isFinite(value);
        let valid;
        let reason;
        switch (type) {
            case 'boolean': valid = typeof value === 'boolean'; reason = '必须是 boolean（true 或 false）'; break;
            case 'string': valid = typeof value === 'string'; reason = '必须是字符串，留空请用空字符串'; break;
            case 'positiveInteger': valid = number && Number.isInteger(value) && value > 0; reason = '必须是正整数'; break;
            case 'nonnegativeInteger': valid = number && Number.isInteger(value) && value >= 0; reason = '必须是非负整数'; break;
            case 'positiveNumber': valid = number && value > 0; reason = '必须是正的有限数字'; break;
            case 'nonnegativeNumber': valid = number && value >= 0; reason = '必须是非负有限数字'; break;
            case 'percent': valid = number && value >= 0 && value <= 100; reason = '必须是 0 到 100 之间的有限数字'; break;
            case 'messages': valid = Array.isArray(value) && value.length >= 3 && value.every((item) => typeof item === 'string' && item.trim()); reason = '必须是至少 3 个非空字符串的数组'; break;
            case 'claudeEffort': valid = efforts.includes(value); reason = '必须是 low/medium/high/xhigh/max 或空字符串'; break;
            case 'codexEffort': valid = [...efforts, 'ultra'].includes(value); reason = '必须是 low/medium/high/xhigh/max/ultra 或空字符串'; break;
        }
        if (!valid) fail(key, reason);
    }
    if (settings.inquiryStrategy.initialShopsPerPlatform > settings.inquiryStrategy.maxShopsPerPlatform) fail('inquiryStrategy', 'initialShopsPerPlatform 不能大于 maxShopsPerPlatform；旧个人店数请用新配置修复');
    for (const key of ['pollIntervalSeconds']) {
        if (settings[key].min > settings[key].max) fail(key, 'min 不能大于 max');
    }
}

// 这里只检查路径；已知字段的坏值可由 set 修复，再校验完整的有效配置。
export function checkPaths(value, prefix = '') {
    if (!object(value)) fail(prefix || '配置', '顶层必须是对象');
    let count = 0;
    for (const [name, item] of Object.entries(value)) {
        const key = prefix ? `${prefix}.${name}` : name;
        if (['__proto__', 'prototype', 'constructor'].includes(name)) fail(key, '禁止原型路径');
        if (name.includes('.')) fail(key, '未知配置键，请使用嵌套对象');
        if (Object.hasOwn(fields, key)) count++;
        else if (Object.keys(fields).some((field) => field.startsWith(`${key}.`))) {
            if (object(item)) count += checkPaths(item, key);
        } else fail(key, '未知配置键，请手工移除或纠正');
    }
    return count;
}

export function merge(current, patch) {
    const next = structuredClone(current);
    for (const [key, value] of Object.entries(patch)) {
        next[key] = object(value) ? merge(object(next[key]) ? next[key] : {}, value) : structuredClone(value);
    }
    return next;
}

function labeled(path, action) {
    try { return action(); } catch (error) { throw new Error(`${path}：${error.message}`); }
}

export function validateAt(settings, path) {
    return labeled(path, () => validate(settings));
}

function optionalText(path) {
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)); }
    catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error(`${path}：无法读取 UTF-8 文件（${error.code || '编码错误'}）`);
    }
}

// 只规范化保留的个人旧键；发布默认值和set/reset仍只接受新键。只读调用不改盘。
export function normalizePersonalSettings(value) {
    if (!object(value)) return value;
    const old = ['shopsPerItem', 'shopsPerLink'].filter(key => Object.hasOwn(value, key));
    if (!old.length) return value;
    if (old.length > 1 || Object.hasOwn(value, 'inquiryStrategy')) fail('inquiryStrategy', '新旧个人店数配置并存，请明确保留哪一项');
    const next = structuredClone(value);
    const range = next[old[0]];
    if (!object(range) || Object.keys(range).some(key => !['min', 'max'].includes(key))
        || Object.values(range).some(v => !Number.isInteger(v) || v <= 0)
        || range.min != null && range.max != null && range.min > range.max) fail(old[0], '旧店数配置无效，请核对原值后修复');
    // 原max是首轮目标；已取消的min不足阈值不迁移，新的报价目标/累计上限继承新版默认。
    next.inquiryStrategy = range.max === undefined ? {} : { initialShopsPerPlatform: range.max };
    delete next[old[0]];
    return next;
}

export function readSettings({ validateEffective = true } = {}) {
    const defaults = parseJson(readText(DEFAULTS_PATH, DEFAULTS_PATH), DEFAULTS_PATH);
    validateAt(defaults, DEFAULTS_PATH);
    const originalText = optionalText(USER_SETTINGS_PATH);
    const overrides = originalText === null ? {} : normalizePersonalSettings(parseJson(originalText, USER_SETTINGS_PATH));
    labeled(USER_SETTINGS_PATH, () => checkPaths(overrides));
    const settings = merge(defaults, overrides);
    if (validateEffective) validateAt(settings, USER_SETTINGS_PATH);
    return { dataDir: DATA_DIR, defaultsPath: DEFAULTS_PATH, userSettingsPath: USER_SETTINGS_PATH, defaults, overrides, originalText, settings };
}

export function applyPatch(current, patch, label) {
    labeled(label, () => {
        if (!checkPaths(patch)) fail('补丁', '不能为空，至少指定一个配置项');
        function containers(value, prefix = '') {
            for (const [name, item] of Object.entries(value)) {
                const key = prefix ? `${prefix}.${name}` : name;
                if (!Object.hasOwn(fields, key)) {
                    if (!object(item)) fail(key, '补丁中的嵌套配置必须是对象');
                    containers(item, key);
                }
            }
        }
        containers(patch);
    });
    return merge(current, patch);
}

// 所有本工具写入共用独占锁；比较读入的原文，检测到并发变化时拒绝写入。
// 首次创建也必须持有同一独占锁，避免两个本工具实例同时创建并互相覆盖。
export function writeSettings(path, originalText, next) {
    labeled(path, () => checkPaths(next));
    const original = originalText === null ? {} : parseJson(originalText, path);
    if (isDeepStrictEqual(original, next)) {
        if (optionalText(path) !== originalText) throw new Error(`${path}：读取后已被其他操作修改，请重新读取再修改`);
        return false;
    }
    const lock = join(dirname(path), '.settings.lock');
    const temp = join(dirname(path), `.settings-${randomUUID()}.tmp`);
    let locked = false;
    let created = false;
    try {
        mkdirSync(dirname(path), { recursive: true });
        try { writeFileSync(lock, '', { flag: 'wx', mode: 0o600 }); locked = true; }
        catch (error) {
            if (error.code === 'EEXIST') throw new Error(`${path}：其他操作正在修改配置（锁文件 ${lock}），请稍后重试`);
            throw error;
        }
        if (optionalText(path) !== originalText) throw new Error(`${path}：读取后已被其他操作修改，请重新读取再修改`);
        const newline = originalText?.includes('\r\n') ? '\r\n' : '\n';
        const text = `${JSON.stringify(next, null, 2).replace(/\n/g, newline)}${newline}`;
        writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx', mode: originalText === null ? 0o600 : statSync(path).mode });
        created = true;
        if (optionalText(path) !== originalText) throw new Error(`${path}：读取后已被其他操作修改，请重新读取再修改`);
        renameSync(temp, path);
        created = false;
        return true;
    } catch (error) {
        if (error.message.startsWith(`${path}：`)) throw error;
        throw new Error(`${path}：写入失败（${error.code || error.message}）`);
    } finally {
        if (created) unlinkSync(temp);
        if (locked) unlinkSync(lock);
    }
}
