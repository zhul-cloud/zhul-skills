#!/usr/bin/env node
// 只读、零依赖：按 ERP itemId 和已核商家规划本平台挑店，不发送、不写断点。
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && !!v.trim();
const time = v => text(v) && !Number.isNaN(Date.parse(v));
const fail = message => { throw new Error(`SEARCH_COVERAGE: ${message}`); };
const sameId = (a, b) => String(a) === String(b);
const fullName = name => String(name).trim();
const fixedShop = s => !!(s.sentAt || s.reusedFrom || s.endedAt || s.pendingMessage && s.pendingMessage.state !== 'cancelled');
function identityKey(shop) {
    const b = shop.identity?.businessIdentity;
    const original = b?.type === 'sellerId' && text(b.value) && time(b.observedAt) ? 'id:sellerId:' + b.value : null;
    return original ?? shop.merchantKey ?? null;
}
function matchingShop(shops, subject) {
    const key = identityKey(subject);
    if (key) {
        const exact = shops.filter(s => identityKey(s) === key);
        if (exact.length === 1) return exact[0];
        if (exact.length > 1) {
            const names = exact.filter(s => fullName(s.shop) === fullName(subject.shop));
            return names.length === 1 ? names[0] : undefined;
        }
        // 已核唯一全称可规范化为新发现的稳定 ID；明确不同 ID 不按同名合并。
        if (key !== 'name:' + fullName(subject.shop)) return undefined;
    }
    const names = shops.filter(s => fullName(s.shop) === fullName(subject.shop));
    return names.length === 1 ? names[0] : undefined;
}
function url(value, platform, productId) {
    let u; try { u = new URL(value); } catch { fail('证据需要有效 URL'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) fail('证据 URL 需要无凭据 HTTP(S)');
    const domains = platform === '淘宝' ? ['taobao.com', 'tmall.com'] : ['1688.com'];
    if (!domains.some(d => u.hostname === d || u.hostname.endsWith('.' + d))) fail('证据 URL 不属于本平台');
    if (productId !== undefined && (platform === '淘宝'
        ? !['item.taobao.com', 'detail.tmall.com'].includes(u.hostname) || u.pathname !== '/item.htm' || u.searchParams.get('id') !== productId
        : u.hostname !== 'detail.1688.com' || u.pathname !== `/offer/${productId}.html`)) fail('商品 URL 与 productId 不符');
}

export function planCoverage(run, part, effectiveSettings) {
    const c = part?.searchCoverage;
    if (!object(c) || !text(run?.runId) || c.runId !== run.runId || c.platform !== part.platform
        || !['淘宝', '1688'].includes(part.platform) || !run.platforms?.includes(part.platform)) fail('缺少本 run/平台绑定的 searchCoverage');
    const range = c.shopsPerItem;
    if (!object(range) || !Number.isInteger(range.min) || range.min <= 0 || !Number.isInteger(range.max) || range.max < range.min) fail('shopsPerItem 需要正整数 min <= max');
    const settings = effectiveSettings?.settings ?? effectiveSettings;
    if (settings && (settings.shopsPerItem?.min !== range.min || settings.shopsPerItem?.max !== range.max)) fail('本次配置与平台快照 shopsPerItem 不一致');
    const items = run.items;
    if (!Array.isArray(items) || !items.length || items.some(i => i.itemId == null || !String(i.itemId).trim() || !text(i.model))
        || new Set(items.map(i => String(i.itemId))).size !== items.length) fail('items 需要独立 itemId 和原型号');
    if (!Array.isArray(c.products) || !Array.isArray(part.shops ?? [])) fail('products/shops 必须为数组');
    const byId = new Map(items.map(i => [String(i.itemId), i]));
    const nameIds = new Map();
    if (new Set(c.products.map(p => p?.productId)).size !== c.products.length) fail('每个 productId 只能保留一份当前 SKU 快照，状态改变须替换旧证据');
    for (const s of part.shops ?? []) {
        const identity = s.identity?.businessIdentity;
        if (identity?.type === 'sellerId' && text(identity.value) && time(identity.observedAt)) {
            const ids = nameIds.get(fullName(s.shop)) ?? new Set(); ids.add(identity.value); nameIds.set(fullName(s.shop), ids);
        }
    }
    for (const p of c.products) {
        if (!object(p) || !/^\d+$/.test(p.productId) || !text(p.skuState) || !time(p.verifiedAt) || !Array.isArray(p.matches)
            || typeof p.eligible !== 'boolean' || !object(p.merchant) || !text(p.merchant.name) || !time(p.merchant.verifiedAt)) fail('商品需 productId/skuState/核验时间/eligible/matches 和已核商家证据');
        url(p.productUrl, part.platform, p.productId); url(p.merchant.sourceUrl, part.platform);
        if (p.merchant.id != null && (!text(p.merchant.id) || p.merchant.idKind !== 'sellerId')) fail('merchant.id 只接受具名 sellerId，不能混用 shopId/memberId');
        if (!p.merchant.id && p.merchant.nameUnique !== true) fail('没有稳定商家 ID 时必须核实全称唯一');
        if (p.merchant.id) {
            const ids = nameIds.get(fullName(p.merchant.name)) ?? new Set(); ids.add(p.merchant.id); nameIds.set(fullName(p.merchant.name), ids);
        }
        if (new Set(p.matches.map(m => String(m?.itemId))).size !== p.matches.length) fail('同一商品 SKU 的 matches.itemId 不能重复');
        for (const m of p.matches) {
            const item = byId.get(String(m?.itemId));
            if (!item || m.model !== item.model || m.quantity !== item.quantity || m.unit !== item.unit || m.description !== item.description) fail('matches 必须绑定原 itemId/model/quantity/unit/description');
            if (!text(m.skuState) || !['exactModel', 'suffix', 'specifications'].every(k => typeof m[k] === 'boolean') || !time(m.verifiedAt)) fail('每个 itemId 需独立型号、后缀、规格、SKU状态及核验时间');
        }
    }
    const keyOf = p => {
        if (p.merchant.id) return 'id:sellerId:' + p.merchant.id;
        const ids = nameIds.get(fullName(p.merchant.name));
        if (ids?.size > 1) fail('商家全称对应多个 ID，不能以名称后备计数');
        return ids?.size === 1 ? 'id:sellerId:' + [...ids][0] : 'name:' + fullName(p.merchant.name);
    };
    const aliases = new Map();
    for (const p of c.products) {
        const key = keyOf(p); const keys = aliases.get(fullName(p.merchant.name)) ?? new Set(); keys.add(key); aliases.set(fullName(p.merchant.name), keys);
    }
    const keyForShop = s => {
        const identity = s.identity?.businessIdentity;
        const priorId = identity?.type === 'sellerId' && text(identity.value) && time(identity.observedAt) ? 'id:sellerId:' + identity.value : null;
        const observed = aliases.get(fullName(s.shop));
        if (priorId) {
            if (s.merchantKey && s.merchantKey !== priorId && s.merchantKey !== 'name:' + fullName(s.shop)) fail('原已核 sellerId 与 merchantKey 冲突');
            if (observed?.size && !observed.has(priorId)) fail('原已核商家身份与当前商品证据冲突');
            return { key: priorId, verified: true };
        }
        if (s.merchantKey) {
            if (s.merchantKey === 'name:' + fullName(s.shop) && nameIds.get(fullName(s.shop))?.size > 1) fail('商家全称对应多个 ID，不能以名称后备计数');
            if (s.merchantKey === 'name:' + fullName(s.shop) && observed?.size === 1) return { key: [...observed][0], verified: true };
            if (!observed?.has(s.merchantKey)) fail('shops.merchantKey 与已核商家/店名不符');
            return { key: s.merchantKey, verified: true };
        }
        if (observed?.size > 1 || nameIds.get(fullName(s.shop))?.size > 1) fail('既有店铺名称对应多个商家 ID，先核原身份');
        if (observed?.size === 1) return { key: [...observed][0], verified: true };
        const bound = time(s.identity?.verifiedAt) && (s.identity.headerName === s.shop || s.identity.contact === s.shop);
        return { key: 'name:' + fullName(s.shop), verified: !!bound };
    };
    const counts = new Map(items.map(i => [String(i.itemId), new Set()]));
    const groups = new Map();
    const nameOwners = new Map();
    const merchantNameConflicts = [];

    for (const s of part.shops ?? []) {
        if (!Array.isArray(s.itemIds) || !s.itemIds.length || new Set(s.itemIds.map(String)).size !== s.itemIds.length
            || s.itemIds.some(id => !byId.has(String(id)))) fail('shops.itemIds 需要本任务无重复 ERP 明细 ID');
        const { key, verified } = keyForShop(s);
        let group = groups.get(key);
        if (!group) { group = { merchantKey: key, shop: s.shop, itemIds: [], productUrls: [], canSendInitial: true, identityUnresolved: !verified }; groups.set(key, group); }
        if (fixedShop(s)) {
            group.canSendInitial = false;
            for (const id of s.itemIds) {
                const original = byId.get(String(id)).itemId;
                if (!group.itemIds.some(x => sameId(x, id))) group.itemIds.push(original);
                if (verified) {
                    const name = fullName(group.shop), owner = nameOwners.get(name);
                    if (!owner || owner === key) { counts.get(String(id)).add(key); nameOwners.set(name, key); }
                    else if (!merchantNameConflicts.some(c => c.shop === name && c.merchantKeys.includes(key)))
                        merchantNameConflicts.push({ shop: name, merchantKeys: [owner, key] });
                }
            }
        }
    }
    for (const p of c.products) {
        if (!p.eligible) continue;
        const key = keyOf(p);
        for (const m of p.matches) {
            if (!m.exactModel || !m.suffix || !m.specifications || m.skuState !== p.skuState) continue;
            const id = String(m.itemId), chosen = counts.get(id), existing = groups.get(key);
            const name = fullName(existing?.shop ?? p.merchant.name), owner = nameOwners.get(name);
            // ERP及历史均按平台+店名关联；同run只选一个同全称商家，不迁移旧身份键或伪造改名。
            if (owner && owner !== key) continue;
            // 原店已发/待核/沿用/结束只保留原 itemIds；新增型号另找商家。
            if (existing && !existing.canSendInitial && !existing.itemIds.some(x => sameId(x, m.itemId))) continue;
            if (!chosen.has(key) && chosen.size >= range.max) continue;
            let group = existing;
            if (!group) { group = { merchantKey: key, shop: p.merchant.name, itemIds: [], productUrls: [], canSendInitial: true }; groups.set(key, group); }
            const original = byId.get(id).itemId;
            if (!group.itemIds.some(x => sameId(x, original))) group.itemIds.push(original);
            if (!group.productUrls.includes(p.productUrl)) group.productUrls.push(p.productUrl);
            chosen.add(key); nameOwners.set(name, key);
        }
    }
    const shops = [...groups.values()].filter(g => g.itemIds.length);
    for (const g of shops) g.itemIds.sort((a, b) => items.findIndex(i => sameId(i.itemId, a)) - items.findIndex(i => sameId(i.itemId, b)));
    const coverage = items.map(i => ({ itemId: i.itemId, model: i.model, count: counts.get(String(i.itemId)).size,
        target: range.max, belowMinimum: counts.get(String(i.itemId)).size < range.min,
        missing: Math.max(0, range.max - counts.get(String(i.itemId)).size) }));
    return { platform: part.platform, coverage, merchantNameConflicts, uncoveredItemIds: coverage.filter(i => i.missing).map(i => i.itemId),
        stopSearch: coverage.every(i => i.missing === 0), shops };
}

// checkpoint/check 允许搜索中先存商品证据；挑店完成后必须保存完整计划，不能漏 itemId。
export function coverageProblems(run, part, effectiveSettings) {
    if (part.searchCoverage === undefined) return [];
    try {
        const plan = planCoverage(run, part, effectiveSettings);
        if ((part.status === 'completed' || part.stages?.repliesDone) && plan.merchantNameConflicts.length) fail('既有同名不同商家无法按旧历史键区分，先核对原记录且不能伪造改名');
        const seen = new Map();
        for (const s of part.shops ?? []) {
            const expected = matchingShop(plan.shops, s);
            // 明确未发的撤销记录可留档；不凭撤销旧记录计覆盖或产生新首发。
            if (!expected && s.pendingMessage?.state === 'cancelled' && !s.sentAt && !s.reusedFrom && !s.endedAt) continue;
            if (!expected || s.itemIds.some(id => !expected.itemIds.some(x => sameId(x, id)))) fail('shops 含未经逐项核验的新增 itemId');
            if (seen.has(expected.merchantKey) && (!fixedShop(s) || !seen.get(expected.merchantKey))) fail('同商家未发送店必须合并为一行，禁止拆开首发');
            seen.set(expected.merchantKey, fixedShop(s));
        }
        if (part.stages?.shopsPicked && !part.skipped) {
            const selected = new Map();
            for (const s of part.shops ?? []) {
                const g = matchingShop(plan.shops, s);
                if (!g) continue;
                const set = selected.get(g.merchantKey) ?? new Set(); s.itemIds.forEach(id => set.add(String(id))); selected.set(g.merchantKey, set);
            }
            if (plan.shops.some(g => g.itemIds.some(id => !selected.get(g.merchantKey)?.has(String(id))))) fail('挑店完成快照缺少计划中的店铺/itemId');
        }
        return [];
    } catch (error) { return [error.message]; }
}

export function coverageTransitionProblems(previous, next) {
    if (!previous || previous.searchCoverage === undefined && next.searchCoverage === undefined) return [];
    if (previous.searchCoverage !== undefined && next.searchCoverage === undefined) return ['SEARCH_COVERAGE: 已启用的覆盖证据不能删除以绕过校验'];
    for (const prior of previous.shops ?? []) {
        if (!fixedShop(prior)) continue;
        const current = matchingShop(next.shops ?? [], prior);
        const m = prior.pendingMessage, n = current?.pendingMessage;
        const cancelledUnsent = !prior.sentAt && !prior.reusedFrom && !prior.endedAt && m?.state === 'pending'
            && n?.state === 'cancelled' && ['messageId', 'kind', 'text', 'preparedAt'].every(k => n[k] === m[k]);
        if (!current || ['sentAt', 'reusedFrom', 'endedAt'].some(k => prior[k] && current[k] !== prior[k])
            || m?.state === 'pending' && (!n || !['messageId', 'kind', 'text', 'preparedAt'].every(k => n[k] === m[k]))
            || !fixedShop(current) && !cancelledUnsent || (prior.itemIds ?? []).length !== (current.itemIds ?? []).length
            || prior.itemIds.some(id => !current.itemIds.some(x => sameId(x, id)))) return ['SEARCH_COVERAGE: 必须保留原已发/待核/沿用/结束店及其完整原 itemIds，不能增删'];
    }
    return [];
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    try {
        const args = process.argv.slice(2);
        if (args.length !== 3) fail('用法：search-coverage.mjs <run.json> <run-平台.json> <本次有效settings.json>');
        const [run, part, settings] = args.map(p => JSON.parse(readFileSync(p, 'utf8')));
        console.log(JSON.stringify(planCoverage(run, part, settings), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 2; }
}
