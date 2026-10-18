#!/usr/bin/env node
// 本机个人配置工具（零依赖，Node 18+），只写数据目录中的稀疏覆盖。
// node settings.mjs [check | json | set <patch.json> | reset <key> [key...] | reset --all]
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { withCurrentData } from './data-lifecycle.mjs';
import { fields, get, object, parseJson, readText, merge, readSettings, applyPatch, validateAt, writeSettings } from './config.mjs';

const cell = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/`/g, '&#96;').replace(/\r?\n/g, '<br>');
const display = (value) => cell(JSON.stringify(value) ?? '缺失');
const paths = (state) => `默认配置：${state.defaultsPath}\n个人配置：${state.userSettingsPath}\n数据目录：${state.dataDir}`;

function resetOverrides(overrides, keys) {
    if (keys[0] === '--all') return {};
    const next = structuredClone(overrides);
    function remove(value, names) {
        const [name, ...rest] = names;
        if (!object(value) || !Object.hasOwn(value, name)) return false;
        if (rest.length) {
            if (!remove(value[name], rest)) return false;
            if (Object.keys(value[name]).length) return true;
        }
        delete value[name];
        return true;
    }
    for (const key of keys) remove(next, key.split('.'));
    return next;
}

function main(args) {
    const [command, input] = args;
    if (!(args.length === 0 || (['check', 'json'].includes(command) && args.length === 1) || (command === 'set' && args.length === 2) || (command === 'reset' && args.length >= 2))) {
        throw new Error('用法：node settings.mjs [check | json | set <patch.json> | reset <key> [key...] | reset --all]');
    }
    if (command === 'reset') {
        const keys = args.slice(1);
        if (keys.includes('--all')) {
            if (keys.length !== 1) throw new Error('reset --all 不能与其他参数混用');
        } else {
            for (const key of keys) {
                if (!Object.hasOwn(fields, key) && !Object.keys(fields).some((field) => field.startsWith(`${key}.`))) {
                    throw new Error(`${key}：未知配置键或配置组`);
                }
            }
        }
    }
    const execute = () => {
    const state = readSettings({ validateEffective: !['set', 'reset'].includes(command) });
    if (command === 'json') {
        const { dataDir, defaultsPath, userSettingsPath, settings } = state;
        console.log(JSON.stringify({ dataDir, defaultsPath, userSettingsPath, settings }, null, 2));
    } else if (!command) {
        console.log(`${paths(state)}\n\n| 键名 | 有效值 | 来源 | 简要说明 |\n|---|---|---|---|`);
        for (const [key, [, description]] of Object.entries(fields)) {
            console.log(`| ${key} | ${display(get(state.settings, key))} | ${get(state.overrides, key) === undefined ? '默认' : '个人'} | ${cell(description)} |`);
        }
    } else if (command === 'check') {
        console.log(`${paths(state)}\n校验通过。模型及思考深度的实际可用性仍需按当前客户端工具核对。`);
    } else {
        let next;
        if (command === 'reset') next = resetOverrides(state.overrides, args.slice(1));
        else {
            const inputPath = resolve(input);
            const patch = parseJson(readText(inputPath, inputPath), inputPath);
            next = applyPatch(state.overrides, patch, inputPath);
        }
        const settings = merge(state.defaults, next);
        validateAt(settings, state.userSettingsPath);
        const changed = writeSettings(state.userSettingsPath, state.originalText, next);
        console.log(`${paths(state)}\n${changed ? command === 'reset' ? '已更新个人配置：移除覆盖，恢复默认。' : '已更新个人配置。' : '配置无变化，未重写文件。'}`);
        if (changed) {
            console.log('\n| 键名 | 修改前有效值 | 修改后有效值 | 个人覆盖 |\n|---|---|---|---|');
            for (const key of Object.keys(fields)) {
                const before = get(state.settings, key);
                const after = get(settings, key);
                const oldOverride = get(state.overrides, key);
                const newOverride = get(next, key);
                if (!isDeepStrictEqual(before, after) || !isDeepStrictEqual(oldOverride, newOverride)) {
                    console.log(`| ${key} | ${display(before)} | ${display(after)} | ${command === 'reset' ? '移除覆盖，恢复默认' : oldOverride === undefined ? '新增覆盖' : '更新覆盖'} |`);
                }
            }
        }
    }
    };
    if (['set', 'reset'].includes(command)) withCurrentData(execute);
    else execute();
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    try { main(process.argv.slice(2)); }
    catch (error) { console.error(`配置操作失败：${error.message}`); process.exitCode = 1; }
}
