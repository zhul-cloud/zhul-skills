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
export function strategy(value) {
    const s = value?.settings?.inquiryStrategy ?? value?.inquiryStrategy ?? value;
    if (!object(s) || !['initialShopsPerPlatform', 'targetComparableQuotes', 'maxShopsPerPlatform'].every(k => Number.isInteger(s[k]) && s[k] > 0)
        || s.initialShopsPerPlatform > s.maxShopsPerPlatform) fail('inquiryStrategy 需要正整数且首轮数不超过累计上限');
    return Object.fromEntries(['initialShopsPerPlatform', 'targetComparableQuotes', 'maxShopsPerPlatform'].map(k => [k, s[k]]));
}
function validateInquiryPlan(run) {
    if (run.inquiryPlan === undefined) return;
    const p = run.inquiryPlan;
    if (!object(p) || !Array.isArray(p.targets)) fail('主计划轮次、来源修订及逐item/平台累计授权无效');
    const policy = strategy(p.policy);
    const expected = run.items.flatMap(i => run.platforms.map(platform => `${String(i.itemId)}|${platform}`));
    const keys = p.targets.map(t => `${String(t?.itemId)}|${t?.platform}`);
    if (!Number.isSafeInteger(p.round) || p.round < 1 || !time(p.plannedAt) || !object(p.basedOn)
        || run.platforms.some(platform => !Number.isSafeInteger(p.basedOn[platform]) || p.basedOn[platform] < 0)
        || keys.length !== expected.length || new Set(keys).size !== keys.length || expected.some(key => !keys.includes(key))
        || p.targets.some(t => !Number.isSafeInteger(t.totalShops) || t.totalShops < 0 || t.totalShops > policy.maxShopsPerPlatform)) fail('主计划轮次、来源修订及逐item/平台累计授权无效');
}
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
    const items = run.items;
    if (!Array.isArray(items) || !items.length || items.some(i => i.itemId == null || !String(i.itemId).trim() || !text(i.model))
        || new Set(items.map(i => String(i.itemId))).size !== items.length) fail('items 需要独立 itemId 和原型号');
    validateInquiryPlan(run);
    strategy(c.inquiryStrategy);
    const policy = strategy(run.inquiryPlan?.policy ?? c.inquiryStrategy);
    const settings = effectiveSettings?.settings ?? effectiveSettings;
    if (settings && JSON.stringify(strategy(settings)) !== JSON.stringify(policy)) fail('本次配置与平台快照 inquiryStrategy 不一致');
    const target = id => run.inquiryPlan?.targets.find(t => t.platform === part.platform && sameId(t.itemId, id)).totalShops ?? policy.initialShopsPerPlatform;
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
    const occupied = new Map(items.map(i => [String(i.itemId), new Set()]));
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
                occupied.get(String(id)).add(key);
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
            if (!chosen.has(key) && !occupied.get(id).has(key) && occupied.get(id).size >= Math.min(target(id), policy.maxShopsPerPlatform)) continue;
            let group = existing;
            if (!group) { group = { merchantKey: key, shop: p.merchant.name, itemIds: [], productUrls: [], canSendInitial: true }; groups.set(key, group); }
            const original = byId.get(id).itemId;
            if (!group.itemIds.some(x => sameId(x, original))) group.itemIds.push(original);
            if (!group.productUrls.includes(p.productUrl)) group.productUrls.push(p.productUrl);
            chosen.add(key); occupied.get(id).add(key); nameOwners.set(name, key);
        }
    }
    const shops = [...groups.values()].filter(g => g.itemIds.length);
    for (const g of shops) g.itemIds.sort((a, b) => items.findIndex(i => sameId(i.itemId, a)) - items.findIndex(i => sameId(i.itemId, b)));
    const coverage = items.map(i => ({ itemId: i.itemId, model: i.model, count: counts.get(String(i.itemId)).size,
        target: target(i.itemId), belowMinimum: counts.get(String(i.itemId)).size < policy.initialShopsPerPlatform,
        missing: Math.max(0, target(i.itemId) - counts.get(String(i.itemId)).size) }));
    return { platform: part.platform, coverage, merchantNameConflicts, uncoveredItemIds: coverage.filter(i => i.missing).map(i => i.itemId),
        stopSearch: coverage.every(i => i.missing === 0), shops };
}

// checkpoint/check 允许搜索中先存商品证据；挑店完成后必须保存完整计划，不能漏 itemId。
export function coverageProblems(run, part, effectiveSettings) {
    if (part.searchCoverage === undefined) return [];
    // 旧completed快照仅保留历史，不用旧配额算法执行或重开。
    if (!part.searchCoverage.inquiryStrategy) return [];
    try {
        const plan = planCoverage(run, part, effectiveSettings);
        if ((part.status === 'completed' || part.stages?.repliesDone) && plan.merchantNameConflicts.length) fail('既有同名不同商家无法按旧历史键区分，先核对原记录且不能伪造改名');
        const seen = new Map();
        for (const s of part.shops ?? []) {
            const expected = matchingShop(plan.shops, s);
            // 明确未发的撤销记录可留档；不凭撤销旧记录计覆盖或产生新首发。
            if (!expected && s.pendingMessage?.state === 'cancelled' && !s.sentAt && !s.reusedFrom && !s.endedAt) continue;
            // 主计划撤回空位后，真实未发候选仍是合法留档；只有当前授权计划中的候选才能产生首发。
            if (!expected && !fixedShop(s) && s.itemIds.every(id => part.searchCoverage.products.some(p => p.eligible
                && (identityKey(s) === (p.merchant.id ? 'id:sellerId:' + p.merchant.id : 'name:' + fullName(p.merchant.name))
                    || (!identityKey(s) || identityKey(s) === 'name:' + fullName(s.shop)) && fullName(s.shop) === fullName(p.merchant.name))
                && p.matches.some(m => sameId(m.itemId, id) && m.exactModel && m.suffix && m.specifications && m.skuState === p.skuState)))) continue;
            if (!expected || s.itemIds.some(id => !expected.itemIds.some(x => sameId(x, id)))) fail('shops 含未经逐项核验的新增 itemId');
            if (seen.has(expected.merchantKey) && (!fixedShop(s) || !seen.get(expected.merchantKey))) fail('同商家未发送店必须合并为一行，禁止拆开首发');
            seen.set(expected.merchantKey, fixedShop(s));
        }
        if (part.stages?.shopsPicked && !part.skipped && (!run.inquiryPlan || (part.searchCoverage.pickedRound ?? 1) === run.inquiryPlan.round)) {
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
    if (!previous) return [];
    const messages = value => [...(value.shops ?? []), ...(value.incidents ?? [])].map(s => s.pendingMessage).filter(Boolean);
    for (const prior of messages(previous)) if (['confirmed', 'cancelled'].includes(prior.state)
        && messages(next).some(m => m.messageId === prior.messageId && m.state === 'pending')) return ['MESSAGE_TRANSITION: 已确认或已撤销的messageId终态不能回退pending；新消息须新意图ID'];
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
            || (prior.itemIds ?? []).some(id => !current.itemIds?.some(x => sameId(x, id)))) return ['SEARCH_COVERAGE: 必须保留原已发/待核/沿用/结束店及其完整原 itemIds，不能增删'];
    }
    return [];
}

const leadTimes = ['现货', '1-2天', '2-3天', '3-5天', '5-7天', '1-2周', '2-4周', '4-8周', '8周以上'];
const contacted = s => !!(s.sentAt || s.reusedFrom || s.pendingMessage?.state === 'pending');
const merchantKey = s => identityKey(s) ?? 'name:' + fullName(s.shop);
const itemBound = (proof, item) => object(proof) && proof.itemId != null && sameId(proof.itemId, item.itemId)
    && ['model', 'quantity', 'unit', 'description'].every(k => proof[k] === item[k]);
const isCompleted = part => part?.status === 'completed' || part?.stages?.repliesDone || part?.skipped;
const cutoffReached = (run, now) => time(run.deadline) && now >= Date.parse(run.deadline) - 5 * 60000;

export function quoteComparable(shop, quote, item) {
    const c = quote?.comparability;
    return shop.status === '已回复' && !!(shop.sentAt || shop.reusedFrom)
        && !shop.noStockItemIds?.some(id => sameId(id, item.itemId))
        && ['number', 'string'].includes(typeof quote.price) && String(quote.price).trim() !== ''
        && Number.isFinite(Number(quote.price)) && Number(quote.price) >= 0
        && object(c) && c.source === (shop.reusedFrom ? 'history' : 'merchant')
        && (c.source !== 'history' || time(shop.reusedFrom))
        && itemBound(c.item, item) && time(c.verifiedAt) && text(c.sourceText) && c.requirementsMet === true
        && c.taxConfirmed === true && typeof quote.taxIncluded === 'boolean'
        && (!quote.taxIncluded || [3, 13].includes(quote.taxRate))
        && c.shippingConfirmed === true && typeof quote.freeShipping === 'boolean'
        && typeof c.shippingAmount === 'number' && Number.isFinite(c.shippingAmount) && c.shippingAmount >= 0
        && (!quote.freeShipping || c.shippingAmount === 0)
        && quote.condition === '全新原装' && leadTimes.includes(quote.leadTime);
}

export function inquiryFactProblems(run, part) {
    const problems = [];
    for (const s of part.shops ?? []) {
        if (s.noStockItemIds !== undefined && (!Array.isArray(s.noStockItemIds)
            || new Set(s.noStockItemIds.map(String)).size !== s.noStockItemIds.length
            || s.noStockItemIds.some(id => !s.itemIds?.some(x => sameId(x, id))) || s.noStockItemIds.length && !text(s.reply))) problems.push('INQUIRY_FACT: noStockItemIds 需要本店无重复itemId及实际无货回复证据');
        if (s.businessEntity !== undefined) {
            const e = s.businessEntity;
            try {
                if (!object(e) || !text(e.name) || !/^[0-9A-Z]{18}$/.test(e.creditCode) || !time(e.verifiedAt)) fail('businessEntity 需要企业全称/18位creditCode/核验时间');
                url(e.sourceUrl, part.platform);
            } catch (error) { problems.push(error.message); }
        }
        for (const q of s.quotes ?? []) if (q.comparability !== undefined) {
            const c = q.comparability, item = run.items?.find(i => sameId(i.itemId, q.itemId));
            if (!object(c) || !['merchant', 'history'].includes(c.source) || !itemBound(c.item, item ?? {})
                || !time(c.verifiedAt) || !text(c.sourceText) || typeof c.requirementsMet !== 'boolean'
                || typeof c.taxConfirmed !== 'boolean' || typeof c.shippingConfirmed !== 'boolean'
                || c.shippingAmount !== undefined && (typeof c.shippingAmount !== 'number' || !Number.isFinite(c.shippingAmount) || c.shippingAmount < 0)
                || c.source === 'history' && !time(s.reusedFrom)) problems.push('INQUIRY_FACT: comparability 需要当前item需求绑定、商家/历史来源原话、核验时间及真实确认项');
        }
    }
    const exhausted = part.searchCoverage?.exhaustedItems;
    const pickedRound = part.searchCoverage?.pickedRound;
    if (pickedRound !== undefined && (!Number.isSafeInteger(pickedRound) || pickedRound < 1 || run.inquiryPlan && pickedRound > run.inquiryPlan.round)) problems.push('INQUIRY_FACT: pickedRound 必须是已授权的正整数轮次');
    if (exhausted !== undefined && (!Array.isArray(exhausted) || new Set(exhausted.map(i => String(i?.itemId))).size !== exhausted.length
        || exhausted.some(i => !run.items?.some(item => sameId(item.itemId, i?.itemId)) || !text(i.reason) || !time(i.checkedAt)))) problems.push('INQUIRY_FACT: exhaustedItems 需要本任务itemId、候选穷尽原因与核验时间');
    return problems;
}

// 只读地汇总最新平台事实；选中、已联系、有效、等待和授权空位分别展示。
export function inquirySummary(run, parts, policyInput, now = Date.now()) {
    validateInquiryPlan(run);
    const policy = strategy(policyInput ?? run.inquiryPlan?.policy);
    const entities = new Map();
    const coveragePlans = new Map(parts.filter(p => p?.searchCoverage?.inquiryStrategy
        && (p.shops ?? []).some(s => !contacted(s) && !s.endedAt && s.pendingMessage?.state !== 'cancelled')).map(p => [p.platform, planCoverage(run, p)]));
    for (const part of parts) for (const s of part?.shops ?? []) if (s.businessEntity) {
        const e = s.businessEntity, prior = entities.get(e.creditCode);
        if (prior && prior !== e.name.trim()) fail('同信用代码的企业全称冲突，先核验来源');
        entities.set(e.creditCode, e.name.trim());
    }
    const items = run.items.map(item => {
        const valid = new Set(), potential = new Set();
        const platforms = run.platforms.map(platform => {
            const part = parts.find(p => p?.platform === platform);
            const actual = new Set(), selected = new Set(), waiting = new Set();
            const exhausted = part?.searchCoverage?.exhaustedItems?.find(i => sameId(i.itemId, item.itemId));
            const completed = !!isCompleted(part);
            const interrupted = part?.status === 'interrupted' || !!part?.humanHelp
                && (part.humanHelp.status !== 'resolved' || part.humanHelp.verified !== true || !time(part.humanHelp.verifiedAt));
            const totalShops = run.inquiryPlan?.targets?.find(t => t.platform === platform && sameId(t.itemId, item.itemId))?.totalShops ?? policy.initialShopsPerPlatform;
            for (const s of part?.shops ?? []) {
                if (!s.itemIds?.some(id => sameId(id, item.itemId))) continue;
                const allowed = matchingShop(coveragePlans.get(platform)?.shops ?? [], s);
                if (!contacted(s) && !allowed?.itemIds.some(id => sameId(id, item.itemId))) continue;
                const key = merchantKey(s), globalKey = s.businessEntity ? 'entity:' + s.businessEntity.creditCode : platform + ':' + key;
                const cancelled = s.pendingMessage?.state === 'cancelled' && !s.sentAt && !s.reusedFrom;
                if (contacted(s)) actual.add(key);
                if (!cancelled && !s.endedAt) selected.add(key);
                if ((s.quotes ?? []).some(q => sameId(q.itemId, item.itemId) && quoteComparable(s, q, item))) valid.add(globalKey);
                else if (!cancelled && (s.pendingMessage?.state === 'pending' || !s.endedAt && s.status !== '无货'
                    && !s.noStockItemIds?.some(id => sameId(id, item.itemId)))) {
                    waiting.add(key);
                    if (!interrupted && !completed) potential.add(globalKey);
                }
            }
            // 尚在正常找店的已授权空位预留，穷尽/完成/中断不伪装为在等商家。
            const unselected = completed || interrupted || exhausted ? 0 : Math.max(0, totalShops - new Set([...actual, ...selected]).size);
            for (let n = 0; n < unselected; n++) potential.add(`${platform}:reserved:${n}`);
            return { platform, selectedCount: selected.size, contactedCount: actual.size, waitingCount: waiting.size,
                reservedCount: unselected, authorizedTotal: totalShops, exhaustedReason: exhausted?.reason ?? null, completed, interrupted };
        });
        for (const key of valid) potential.delete(key);
        return { itemId: item.itemId, model: item.model, comparableCount: valid.size, waitingCount: potential.size,
            target: policy.targetComparableQuotes, missing: Math.max(0, policy.targetComparableQuotes - valid.size), platforms };
    });
    return { policy, cutoffReached: !!cutoffReached(run, now), stopped: run.userStopped === true, items };
}

export function planInquiry(run, parts, policyInput, now = Date.now()) {
    const policy = strategy(policyInput ?? run.inquiryPlan?.policy);
    const policyChanged = !!run.inquiryPlan && JSON.stringify(policy) !== JSON.stringify(strategy(run.inquiryPlan.policy));
    const summary = inquirySummary(run, parts, policy, now);
    const targets = [], allocations = [];
    for (const item of summary.items) {
        let deficit = Math.max(0, item.missing - item.waitingCount);
        for (const p of item.platforms) {
            let totalShops = policyChanged ? Math.min(policy.maxShopsPerPlatform, Math.max(p.authorizedTotal, policy.initialShopsPerPlatform)) : p.authorizedTotal;
            if (item.comparableCount >= item.target || summary.cutoffReached || summary.stopped) totalShops = Math.min(totalShops, p.contactedCount);
            const pendingSupplement = p.authorizedTotal > policy.initialShopsPerPlatform && (p.waitingCount > 0 || p.reservedCount > 0);
            const mayAdd = !!run.inquiryPlan && deficit > 0 && !summary.cutoffReached && !summary.stopped && !pendingSupplement
                && !p.completed && !p.interrupted && !p.exhaustedReason && totalShops < policy.maxShopsPerPlatform;
            if (mayAdd) { totalShops++; deficit--; allocations.push({ itemId: item.itemId, platform: p.platform, count: 1, reason: '有效报价及在等数量不足目标，补一家未联系新店' }); }
            targets.push({ itemId: item.itemId, platform: p.platform, totalShops });
        }
    }
    const initial = !run.inquiryPlan;
    const changed = initial || policyChanged || allocations.length > 0 || JSON.stringify(targets) !== JSON.stringify(run.inquiryPlan.targets);
    const plan = changed ? { policy, round: (run.inquiryPlan?.round ?? 0) + 1, plannedAt: new Date(now).toISOString(),
        basedOn: Object.fromEntries(run.platforms.map(p => [p, parts.find(part => part?.platform === p)?.revision ?? 0])), targets } : run.inquiryPlan;
    return { plan, changed, allocations, ...summary };
}

// 在受控保存的同一锁内调用，已有意图核验及正常回复不受新计划/迟到报价阻断。
export function inquiryCheckpointProblems(run, parts, previous, next, now = Date.now()) {
    const problems = inquiryFactProblems(run, next);
    if (time(previous?.stages?.shopsPicked) && next.stages?.shopsPicked !== previous.stages.shopsPicked) problems.push('INQUIRY_PLAN: 必须保留首次shopsPicked时刻，补轮使用pickedRound');
    const legacyCompleted = previous && isCompleted(previous) && !previous.searchCoverage?.inquiryStrategy;
    if (legacyCompleted) {
        if (!isCompleted(next) || (previous.shops ?? []).some(prior => {
            if (!fixedShop(prior)) return false;
            const current = matchingShop(next.shops ?? [], prior);
            return !current || (prior.quotes ?? []).some(q => q.price != null && String(q.price).trim() !== ''
                && !(current.quotes ?? []).some(n => sameId(n.itemId, q.itemId) && n.price != null && String(n.price).trim() !== ''));
        }) || (next.shops ?? []).some(s => {
            const prior = matchingShop(previous.shops ?? [], s);
            return !prior || s.sentAt && s.sentAt !== prior.sentAt || s.reusedFrom && s.reusedFrom !== prior.reusedFrom
                || s.pendingMessage?.kind === 'initial' && s.pendingMessage.messageId !== prior.pendingMessage?.messageId;
        })) problems.push('INQUIRY_PLAN: 旧已完成平台不能重开、增店或准备新的首发');
        return problems;
    }
    if (!run.inquiryPlan) {
        const version = String(run.skillVersion ?? '').split('.').map(Number);
        const currentCreation = version[0] > 2 || version[0] === 2 && version[1] >= 13;
        const businessAction = (next.shops ?? []).length > 0 || !!next.searchCoverage || isCompleted(next) && !next.skipped
            || (next.noStock ?? []).length > 0 || (next.incompleteItems ?? []).length > 0;
        const newActivity = (next.shops ?? []).some(s => {
            const prior = matchingShop(previous?.shops ?? [], s);
            return !prior || s.pendingMessage?.state === 'pending' && s.pendingMessage.messageId !== prior.pendingMessage?.messageId
                || s.sentAt && !prior.sentAt && !(prior.pendingMessage?.kind === 'initial' && prior.pendingMessage.state === 'pending');
        });
        return previous === next || !businessAction || !currentCreation && !newActivity && !next.searchCoverage?.inquiryStrategy ? problems
            : [...problems, 'INQUIRY_PLAN: 先由主执行者 plan-inquiry 保存首轮授权，旧未完证据须保留并迁移'];
    }
    if (next.skipped && !(next.shops ?? []).length && !next.searchCoverage) return problems;
    if (!next.searchCoverage?.inquiryStrategy) return previous === next ? problems : [...problems, 'INQUIRY_PLAN: 当前执行必须保留新策略与逐项覆盖证据'];
    const current = parts.filter(p => p?.platform !== next.platform).concat(next);
    const summary = inquirySummary(run, current, run.inquiryPlan.policy, now);
    const beforeSummary = inquirySummary(run, parts, run.inquiryPlan.policy, now);
    for (const item of summary.items) {
        const p = item.platforms.find(p => p.platform === next.platform);
        const oldP = beforeSummary.items.find(i => sameId(i.itemId, item.itemId)).platforms.find(p => p.platform === next.platform);
        if (p.contactedCount > Math.max(run.inquiryPlan.policy.maxShopsPerPlatform, oldP.contactedCount)
            || p.contactedCount > Math.max(p.authorizedTotal, oldP.contactedCount)) problems.push(`INQUIRY_PLAN: itemId ${item.itemId} 超出主计划累计授权/上限`);
    }
    for (const s of next.shops ?? []) {
        const prior = matchingShop(previous?.shops ?? [], s);
        if (s.sentAt && !prior?.sentAt && !(prior?.pendingMessage?.kind === 'initial' && prior.pendingMessage.state === 'pending'
            && prior.pendingMessage.messageId === s.pendingMessage?.messageId)) problems.push('INQUIRY_PLAN: 首发确认必须沿用原已持久化发送意图');
        const sameInitial = prior?.pendingMessage?.kind === 'initial' && s.pendingMessage?.messageId === prior.pendingMessage.messageId;
        const newInitial = s.pendingMessage?.kind === 'initial' && s.pendingMessage.state === 'pending'
            && (!sameInitial || prior.pendingMessage.state !== 'pending');
        if (newInitial && sameInitial && ['confirmed', 'cancelled'].includes(prior.pendingMessage.state)) problems.push('INQUIRY_PLAN: 已确认或已撤销的首发意图不能以相同messageId复活；明确未发且重新授权后需新核验和新messageId');
        if (s.pendingMessage?.kind === 'initial' && !sameInitial && prior && contacted(prior)) problems.push('INQUIRY_PLAN: 已联系商家不能新增另一条首发意图');
        if (!newInitial) continue;
        if (parts.some(p => p?.unavailableReason)) problems.push('INQUIRY_PLAN: 对侧平台记录不可核验，只保留独立结果，不授权新的首发');
        const verifiedPlan = planCoverage(run, { ...next, shops: previous?.shops ?? [] });
        if (!time(next.stages?.shopsPicked) || (next.searchCoverage.pickedRound ?? 1) !== run.inquiryPlan.round
            || verifiedPlan.coverage.some(i => i.missing && !next.searchCoverage.exhaustedItems?.some(e => sameId(e.itemId, i.itemId)))) problems.push('INQUIRY_PLAN: 本轮全部明细挑店结束并保存完整合并计划后才能首发');
        const eligible = matchingShop(verifiedPlan.shops, s);
        if (!eligible?.canSendInitial || eligible.identityUnresolved || s.itemIds.some(id => !eligible.itemIds.some(x => sameId(x, id)))) problems.push('INQUIRY_PLAN: 新首发必须先按商家/当前SKU逐item核验完整挑店计划');
        if (prior && contacted(prior) || s.sentAt || s.reusedFrom) problems.push('INQUIRY_PLAN: 已联系商家不能准备另一条首发');
        if (s.businessEntity && parts.some(p => (p.shops ?? []).some(existing => contacted(existing)
            && existing.businessEntity?.creditCode === s.businessEntity.creditCode))) problems.push('INQUIRY_PLAN: 已核同一企业主体已联系，不能换平台重复首发');
        const helpBlocked = next.humanHelp && (next.humanHelp.status !== 'resolved' || next.humanHelp.verified !== true || !time(next.humanHelp.verifiedAt));
        if (summary.cutoffReached || summary.stopped || next.status === 'interrupted' || helpBlocked || isCompleted(previous)) problems.push('INQUIRY_PLAN: 截止/停止/中断/已完成时不能新首发');
        for (const id of s.itemIds ?? []) {
            const i = beforeSummary.items.find(i => sameId(i.itemId, id));
            if (i?.comparableCount >= i?.target) problems.push(`INQUIRY_PLAN: itemId ${id} 已达有效报价目标，未准备首发的新店停止发送`);
        }
    }
    if (isCompleted(next) && !next.skipped) {
        if ((next.shops ?? []).some(s => s.sentAt && !s.endedAt || s.pendingMessage?.state === 'pending')) problems.push('INQUIRY_PLAN: 已联系会话尚未正常结束，不能完成平台');
        for (const i of summary.items) {
            const p = i.platforms.find(p => p.platform === next.platform);
            if (i.comparableCount < i.target && !summary.cutoffReached && !summary.stopped && !p.exhaustedReason
                && p.contactedCount < run.inquiryPlan.policy.maxShopsPerPlatform) problems.push(`INQUIRY_PLAN: itemId ${i.itemId} 仍有补店可能，等待主执行者补轮或记录真实候选穷尽`);
        }
    }
    return problems;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    try {
        const args = process.argv.slice(2);
        if (args.length !== 3) fail('用法：search-coverage.mjs <run.json> <run-平台.json> <本次有效settings.json>');
        const [run, part, settings] = args.map(p => JSON.parse(readFileSync(p, 'utf8')));
        console.log(JSON.stringify(planCoverage(run, part, settings), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 2; }
}
