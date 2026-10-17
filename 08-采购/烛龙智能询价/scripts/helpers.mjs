#!/usr/bin/env node
// 只读、零依赖（Node 18+）：提取单个技能 helper，适配 page.saveHelper 的函数签名。
// node helpers.mjs list [--erp <ERP地址>]              仅列元数据，不输出所有源码
// node helpers.mjs source <域名/名称> [--erp <ERP地址>] 输出单个 JSON；ERP key 为 _erp/erpApi
// node helpers.mjs compare <域名/名称> --file <已保存源码文件> [--erp <ERP地址>] 只读比对注册内容
// 本工具不读取个人配置、不写磁盘、不控制浏览器。source 生成成功不代表 runtimeLoaded。
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPERS = fileURLToPath(new URL('../helpers/', import.meta.url));
// 按 sourceKey 信任完整内容，不信名称/注释/版本标记。改动已发布 helper 时追加被替换版本的适配源码 hash。
// 2.3.2 原函数经当前确定性 wrapper 适配；亦覆盖 2.4.0 本轮修复前相同业务源码的已注册版本。
export const officialHashes = {
    'air.1688.com/imOpenAndRead': ['eb52007bea018df7c9caf4184966e7749a84cbfcd9ba5ca1d6ebe73fefd3a171',
        '98a65c0ae0d57d2a2e5c74fd0a45e86016f9008bfb11ce8a069f04bfb1e10b51'],
    'air.1688.com/imPreviews': ['cbeb0071afbab2a583e6fb4142ca71a817479b14528c3e5e06463c06b4b92424'],
    'market.m.taobao.com/imOpenAndRead': ['7340e9263083f18848cbc4fdb0b5ae14793d5ba54c410125431bd714bc5e4ca7'],
    'market.m.taobao.com/imPreviews': ['63f7508c2ef0b44880f8a6c865ef40fa71fc6fccffb52fc92805a8e69441cb06'],
    's.1688.com/searchCandidates': ['caf4e50921472230841d302f543f44db1a6735da93f4cca31ee70f807ed6bf98'],
    's.taobao.com/searchCandidates': ['f7f4a7f7b772523cef0734398245fcafb014c35de02bd8b083d5f45ccc7f45a1'],
};
const hash = (source) => createHash('sha256').update(source).digest('hex');

function extractBlock(markdown) {
    const blocks = [...markdown.replace(/\r\n/g, '\n').matchAll(/^```js\n([\s\S]*?)\n```[ \t]*$/gm)];
    if (blocks.length !== 1) throw new Error('helper 必须有且只有一个 ```js 函数源码块');
    return blocks[0][1].trim();
}

export function extractSource(markdown) {
    const source = extractBlock(markdown);
    if (!/^async \(browser, pageId, \w+\) => \{/.test(source)) {
        throw new Error('helper 源码必须保留 async (browser, pageId, 参数) => { ... } 签名');
    }
    // 只检查语法，不执行技能函数或业务请求。
    new Function(`return (${source}\n);`);
    return source;
}

export function adaptSource(source, key) {
    return `async (browser, page, inputs = {}) => {
  // zhul-helper: ${key}
  const pageId = typeof page === "number" ? page : page?.id;
  if (!Number.isSafeInteger(pageId) || pageId < 0) throw new Error("SKILL_INPUT: helper 需要数字 pageId 或 Page handle");
  return await (${source})(browser, pageId, inputs);
}`;
}

function erpHost(erpUrl) {
    if (!erpUrl) return '<ERP>';
    const url = new URL(erpUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('ERP 地址必须是无凭据的 HTTP(S) 网址');
    }
    return url.hostname;
}

export function listHelpers(erpUrl) {
    const configuredHost = erpHost(erpUrl);
    return readdirSync(HELPERS).sort().flatMap((directory) =>
        readdirSync(join(HELPERS, directory)).filter((file) => file.endsWith('.md')).sort().map((file) => {
            const originalName = file.slice(0, -3);
            return {
                sourceKey: `${directory}/${originalName}`,
                host: directory === '_erp' ? configuredHost : directory,
                originalName,
                // BrowserOS 在一次 run 中按名称注入全局 helpers；跨平台同名会相互覆盖。
                runtimeName: directory === '_erp' ? originalName : `zhul_${directory.endsWith('taobao.com') ? 'taobao' : '1688'}_${originalName}`,
                policy: directory === '_erp' ? 'skill-version' : 'preserve-local-changes',
            };
        }));
}

export function helperSource(key, erpUrl) {
    const entry = listHelpers(erpUrl).find((helper) => helper.sourceKey === key);
    if (!entry) throw new Error(`未知 helper key：${key}；先运行 helpers.mjs list，必须指定域名/名称`);
    if (entry.host === '<ERP>') throw new Error('ERP helper 需要 --erp <ERP地址>；本工具不读取个人 config.json');
    const markdown = readFileSync(join(HELPERS, `${entry.sourceKey}.md`), 'utf8');
    if (!new RegExp(`^name: "${entry.originalName}"$`, 'm').test(markdown)) throw new Error(`${key} 的 name 与文件名不一致`);
    const source = adaptSource(extractSource(markdown), entry.sourceKey);
    return { ...entry, sha256: hash(source), source, runtimeLoaded: false };
}

export function compareSource(key, saved, erpUrl) {
    const current = helperSource(key, erpUrl);
    let source = saved.replace(/\r\n/g, '\n').trim();
    if (source.includes('```')) source = extractBlock(source);
    if (/^async \(browser, pageId, \w+\) => \{/.test(source)) source = adaptSource(source, key);
    // 不执行注册内容；格式异常、任意业务/注释差异均不当成旧官方版本。
    const actualSha256 = hash(source);
    const status = actualSha256 === current.sha256 ? 'current'
        : (officialHashes[key] || []).includes(actualSha256) ? 'known-official-older' : 'unknown';
    return { sourceKey: key, runtimeName: current.runtimeName, actualSha256, currentSha256: current.sha256,
        status, action: status === 'current' ? 'reuse' : current.policy === 'skill-version' || status === 'known-official-older' ? 'sync' : 'preserve',
        runtimeLoaded: false };
}

function main(args) {
    const command = args.shift();
    let erpUrl;
    const erpIndex = args.indexOf('--erp');
    if (erpIndex !== -1) {
        if (!args[erpIndex + 1] || args[erpIndex + 1].startsWith('--')) throw new Error('--erp 需要 ERP 地址');
        erpUrl = args[erpIndex + 1];
        args.splice(erpIndex, 2);
    }
    let savedFile;
    const fileIndex = args.indexOf('--file');
    if (fileIndex !== -1) {
        if (!args[fileIndex + 1] || args[fileIndex + 1].startsWith('--')) throw new Error('--file 需要已保存源码文件路径');
        savedFile = args[fileIndex + 1];
        args.splice(fileIndex, 2);
    }
    if (command === 'list' && args.length === 0 && !savedFile) {
        console.log(JSON.stringify({ helpers: listHelpers(erpUrl), runtimeLoaded: false }, null, 2));
    } else if (command === 'source' && args.length === 1 && !savedFile) {
        console.log(JSON.stringify(helperSource(args[0], erpUrl), null, 2));
    } else if (command === 'compare' && args.length === 1 && savedFile) {
        console.log(JSON.stringify(compareSource(args[0], readFileSync(savedFile, 'utf8'), erpUrl), null, 2));
    } else {
        throw new Error('用法：helpers.mjs list [--erp <ERP地址>] | source <域名/名称> [--erp <ERP地址>] | compare <域名/名称> --file <源码文件> [--erp <ERP地址>]；不注册运行时 helper');
    }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    try { main(process.argv.slice(2)); }
    catch (error) { console.error(error.message); process.exitCode = 2; }
}
