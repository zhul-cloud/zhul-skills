#!/usr/bin/env node
// 当前买家账号内的接收者/会话映射；不联网、不控制浏览器、不发送消息。
// node contacts.mjs lookup|remember|invalidate|rebind --file <JSON>
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, parseJson, readText } from './config.mjs';

const path = join(DATA_DIR, 'contacts.json');
const platforms = { '淘宝': { type: 'loginNick', source: 'site-nav-login-info-nick', targetType: '3', bizType: '11001' },
    '1688': { type: 'loginId', source: 'conversation-list.currentLoginId', targetType: '8', bizType: '11152' } };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && !!v.trim() && v === v.trim();
const time = (v) => text(v) && !Number.isNaN(Date.parse(v));
const fail = (error, message) => { const e = new Error(message); e.code = error; throw e; };

export function identityProblems(identity, platform = identity?.platform) {
    const problems = [];
    const spec = typeof platform === 'string' && Object.hasOwn(platforms, platform) ? platforms[platform] : null;
    if (!object(identity) || !spec || identity.platform !== platform) return ['identity.platform 必须与本店平台一致'];
    const { account, recipient, buyer } = identity;
    for (const [value, allowed] of [[identity, ['platform', 'account', 'recipient', 'buyer', 'conversationId', 'contact', 'headerName', 'verifiedAt', 'businessIdentity']],
        [account, ['type', 'value', 'source']], [recipient, ['targetId', 'targetType', 'bizType', 'entityType', 'channelType', 'source']],
        [buyer, ['targetId', 'targetType', 'uid', 'displayName', 'source']]]) {
        if (object(value) && Object.keys(value).some((key) => !allowed.includes(key))) problems.push('identity 含合同之外的字段');
    }
    if (!object(account) || account.type !== spec.type || account.source !== spec.source || !text(account.value)) problems.push('identity.account 缺少当前账号具名来源');
    if (!object(recipient) || !text(recipient.targetId) || recipient.targetType !== spec.targetType || recipient.bizType !== spec.bizType
        || recipient.entityType !== 'U' || recipient.channelType !== 3 || recipient.source !== 'conversationIdentifier.target') problems.push('identity.recipient 不符合本平台已核实的接收者契约');
    if (!object(buyer) || !text(buyer.targetId) || buyer.targetType !== spec.targetType || buyer.uid !== buyer.targetId + '@cntaobao'
        || buyer.displayName !== account?.value || buyer.source !== 'self-message') problems.push('identity.buyer 缺少与当前账号一致的 self 消息交叉证据');
    for (const key of ['conversationId', 'contact', 'headerName']) if (!text(identity[key])) problems.push(`identity.${key} 不能为空`);
    if (!time(identity.verifiedAt)) problems.push('identity.verifiedAt 必须是有效时间');
    if (identity.businessIdentity != null) {
        const b = identity.businessIdentity;
        const allowed = ['type', 'value', 'source', 'sourceUrl', 'shopUrl', 'observedAt', 'memberId', 'buyerId', 'buyerIsLogin', 'itemId', 'shopName'];
        if (!object(b) || Object.keys(b).some((key) => !allowed.includes(key)) || b.type !== 'sellerId' || b.value !== recipient?.targetId || !time(b.observedAt)) problems.push('identity.businessIdentity 必须为具名sellerId及独立观察时刻');
        else {
            try {
                const source = new URL(entryUrl(b.sourceUrl, platform));
                const shop = new URL(entryUrl(b.shopUrl, platform));
                if (platform === '1688' && (b.source !== 'window.pageData.globalData.sellerId' || source.origin !== shop.origin
                    || b.buyerIsLogin !== true || b.buyerId !== buyer?.targetId || b.memberId != null && !text(b.memberId))) problems.push('1688商家页具名来源或买家/店铺关联不符');
                if (platform === '淘宝' && (b.source !== 'seller-anchor.memoizedProps.sellerId' || source.hostname !== 'item.taobao.com'
                    || !text(b.itemId) || source.searchParams.get('id') !== b.itemId || !text(b.shopName) || b.memberId != null || b.buyerId != null || b.buyerIsLogin != null)) problems.push('淘宝商家页具名来源或商品关联不符');
            } catch { problems.push('identity.businessIdentity 缺少对应平台的已核实来源/店铺URL'); }
        }
    }
    return problems;
}

function scope(value) {
    const spec = typeof value?.platform === 'string' && Object.hasOwn(platforms, value.platform) ? platforms[value.platform] : null;
    if (!spec || !object(value.account) || value.account.type !== spec.type || value.account.source !== spec.source || !text(value.account.value)) fail('CONTACT_SCOPE', '需要当前页面核实的平台和账号 scope');
    return { platform: value.platform, account: { type: value.account.type, value: value.account.value, source: value.account.source } };
}
const sameScope = (a, b) => a.platform === b.platform && a.account.type === b.account.type && a.account.value === b.account.value && a.account.source === b.account.source;
const sameRecipient = (a, b) => ['targetId', 'targetType', 'bizType', 'entityType', 'channelType', 'source'].every((key) => a?.[key] === b?.[key]);
function entryUrl(value, platform) {
    if (value == null) return null;
    let url;
    try { url = new URL(value); } catch { fail('CONTACT_INPUT', 'entryUrl 必须是已核实的商品或店铺 HTTP(S) 入口'); }
    const host = platform === '淘宝' ? /(^|\.)(taobao\.com|tmall\.com)$/ : /(^|\.)1688\.com$/;
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host.test(url.hostname)) fail('CONTACT_INPUT', 'entryUrl 不属于对应平台或包含凭据');
    return url.href;
}
function load() {
    if (!existsSync(path)) return { revision: null, data: { schemaVersion: 1, bindings: [] } };
    const bytes = readFileSync(path);
    const data = parseJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), path);
    if (!object(data) || data.schemaVersion !== 1 || !Array.isArray(data.bindings) || Object.keys(data).some((key) => !['schemaVersion', 'bindings'].includes(key))) fail('CONTACT_CORRUPT', 'contacts.json 结构无法识别，保留原文件');
    for (const row of data.bindings) {
        if (!object(row) || Object.keys(row).some((key) => !['id', 'identity', 'entryUrl', 'status', 'invalidatedAt', 'reason'].includes(key))
            || !text(row.id) || !['valid', 'invalid'].includes(row.status) || identityProblems(row.identity).length
            || row.entryUrl != null && entryUrl(row.entryUrl, row.identity.platform) !== row.entryUrl
            || row.status === 'invalid' && (!time(row.invalidatedAt) || !text(row.reason))) fail('CONTACT_CORRUPT', 'contacts.json 记录损坏，保留原文件');
    }
    if (new Set(data.bindings.map((r) => r.id)).size !== data.bindings.length) fail('CONTACT_CORRUPT', 'contacts.json 有重复记录ID，保留原文件');
    const active = data.bindings.filter((row) => row.status === 'valid').map(({ identity: i }) => JSON.stringify([i.platform, i.account.type, i.account.value, i.account.source, i.conversationId]));
    if (new Set(active).size !== active.length) fail('CONTACT_CORRUPT', 'contacts.json 有冲突的有效会话绑定，保留原文件');
    return { revision: createHash('sha256').update(bytes).digest('hex'), data };
}

export function contacts(command, input) {
    if (!object(input)) fail('CONTACT_INPUT', '输入必须为JSON对象');
    const currentScope = scope(input);
    if (!['lookup', 'remember', 'invalidate', 'rebind'].includes(command)) fail('CONTACT_INPUT', '只支持 lookup/remember/invalidate/rebind');
    const snapshot = load();
    const own = (row) => sameScope(row.identity, currentScope);
    if (command === 'lookup') {
        const url = entryUrl(input.entryUrl, input.platform);
        if (!input.recipient && !url) fail('CONTACT_INPUT', 'lookup 必须指定接收者或已核实入口，不能按同名推断');
        const matches = snapshot.data.bindings.filter((row) => own(row) && row.status === 'valid'
            && (!input.recipient || sameRecipient(row.identity.recipient, input.recipient)) && (!url || row.entryUrl === url));
        return { ok: true, revision: snapshot.revision, matches, action: matches.length ? 'verify-current-page' : 'discover-read-only' };
    }
    if (!Object.hasOwn(input, 'expectedRevision') || input.expectedRevision !== snapshot.revision) fail('CONTACT_CONFLICT', '映射已变化，请重读后合并，不覆盖旧副本');
    let verified;
    if (command !== 'invalidate') {
        verified = input.identity;
        const problems = identityProblems(verified, input.platform);
        if (problems.length || !sameScope(verified, currentScope)) fail('CONTACT_INPUT', problems.join('；') || '验证结果账号与scope不符');
    }
    if (command === 'remember' && input.bindingId !== undefined) fail('CONTACT_INPUT', 'remember 不接受旧bindingId，请用显式rebind');
    const previous = command === 'remember' ? null : snapshot.data.bindings.find((row) => row.id === input.bindingId && own(row));
    if (command !== 'remember' && !previous) fail('CONTACT_NOT_FOUND', '本账号scope没有指定的绑定');
    if (command === 'rebind') {
        if (!sameRecipient(previous.identity.recipient, verified.recipient) || previous.identity.buyer.uid !== verified.buyer.uid) fail('CONTACT_REBIND_IDENTITY', '只允许相同已核实接收者及买家UID重绑；不同客服须重新验证入口');
        if (snapshot.data.bindings.some((row) => row.id !== previous.id && own(row) && row.status === 'valid' && row.identity.conversationId === verified.conversationId)) fail('CONTACT_EXISTS', '新会话已有有效映射，请先核对冲突，不创建两个有效绑定');
        const before = previous.identity.businessIdentity, after = verified.businessIdentity;
        if (before && after && (before.type !== after.type || before.value !== after.value || before.memberId && after.memberId && before.memberId !== after.memberId)) fail('CONTACT_BUSINESS_CONFLICT', '独立商家页证据冲突，保留旧映射');
        if (before && !after) verified = { ...verified, businessIdentity: before };
    }
    if (command === 'remember') {
        const conflict = snapshot.data.bindings.find((row) => own(row) && row.status === 'valid' && row.identity.conversationId === verified.conversationId);
        if (conflict) fail('CONTACT_EXISTS', '已有此会话映射，请只读核验后显式rebind，不隐式覆盖');
    }
    const url = command === 'invalidate' ? null : entryUrl(input.entryUrl ?? previous?.entryUrl, input.platform);
    if (command === 'invalidate' && !text(input.reason)) fail('CONTACT_INPUT', 'invalidate 需要明确reason');
    mkdirSync(DATA_DIR, { recursive: true });
    const lock = join(DATA_DIR, '.contacts.lock');
    const temporary = join(DATA_DIR, `.contacts-${randomUUID()}.tmp`);
    let locked = false;
    try {
        try { writeFileSync(lock, '', { flag: 'wx', mode: 0o600 }); locked = true; }
        catch (error) { if (error.code === 'EEXIST') fail('CONTACT_BUSY', '另一操作正修改映射；保留锁，不自动恢复'); throw error; }
        const latest = load();
        if (latest.revision !== input.expectedRevision) fail('CONTACT_CONFLICT', '映射在写入前变化，未覆盖');
        const data = latest.data;
        const now = new Date().toISOString();
        if (previous) {
            const row = data.bindings.find((row) => row.id === previous.id);
            row.status = 'invalid'; row.invalidatedAt = now; row.reason = command === 'invalidate' ? input.reason : '只读核验后重绑';
        }
        let row;
        if (verified) { row = { id: randomUUID(), identity: verified, entryUrl: url, status: 'valid' }; data.bindings.push(row); }
        const bytes = JSON.stringify(data, null, 2) + '\n';
        writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        renameSync(temporary, path);
        return { ok: true, revision: createHash('sha256').update(bytes).digest('hex'), binding: row || null, invalidatedId: previous?.id ?? null };
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
        if (locked) unlinkSync(lock);
    }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    try {
        const [command, flag, file, ...extra] = process.argv.slice(2);
        if (flag !== '--file' || !file || extra.length) fail('CONTACT_INPUT', '用法：contacts.mjs lookup|remember|invalidate|rebind --file <JSON>');
        console.log(JSON.stringify(contacts(command, parseJson(readText(file, file), file)), null, 2));
    } catch (error) { console.log(JSON.stringify({ ok: false, error: error.code || 'CONTACT_DATA', message: error.message })); process.exitCode = 2; }
}
