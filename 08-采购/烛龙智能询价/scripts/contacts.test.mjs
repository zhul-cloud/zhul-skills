import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityProblems } from './contacts.mjs';

const script = fileURLToPath(new URL('./contacts.mjs', import.meta.url));
const identity = (platform = '淘宝', extra = {}) => ({ platform,
    account: { type: platform === '淘宝' ? 'loginNick' : 'loginId', value: '匿名买家', source: platform === '淘宝' ? 'site-nav-login-info-nick' : 'conversation-list.currentLoginId' },
    recipient: { targetId: 'seller-test', targetType: platform === '淘宝' ? '3' : '8', bizType: platform === '淘宝' ? '11001' : '11152', entityType: 'U', channelType: 3, source: 'conversationIdentifier.target' },
    buyer: { targetId: 'buyer-test', targetType: platform === '淘宝' ? '3' : '8', uid: 'buyer-test@cntaobao', displayName: '匿名买家', source: 'self-message' },
    conversationId: 'opaque-conversation-a', contact: '匿名店', headerName: '匿名店', verifiedAt: '2026-10-18T02:00:00.000Z', businessIdentity: null, ...extra });
function fixture(t) {
    const root = mkdtempSync(join(dirname(script), '.contacts-test-'));
    const home = join(root, 'home'); mkdirSync(home);
    const data = join(home, '.zhul-trade-sourcing'); mkdirSync(data);
    const sentinels = ['config.json', 'settings.json', 'records.jsonl', 'processed-tasks.jsonl'];
    for (const name of sentinels) writeFileSync(join(data, name), `sentinel:${name}`);
    t.after(() => {
        for (const name of sentinels) assert.equal(readFileSync(join(data, name), 'utf8'), `sentinel:${name}`);
        assert.ok(resolve(root).startsWith(resolve(dirname(script)) + '\\') || resolve(root).startsWith(resolve(dirname(script)) + '/'));
        rmSync(root, { recursive: true, force: true });
    });
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { env, encoding: 'utf8' });
    assert.equal(resolve(probe.stdout), resolve(home));
    const call = (command, request) => {
        const file = join(root, 'request.json'); writeFileSync(file, JSON.stringify(request));
        const result = spawnSync(process.execPath, [script, command, '--file', file], { env, encoding: 'utf8', timeout: 5000 });
        return { status: result.status, ...JSON.parse(result.stdout) };
    };
    const scope = (value) => ({ platform: value.platform, account: value.account });
    const remember = (value, revision = null, extra = {}) => call('remember', { ...scope(value), identity: value, expectedRevision: revision, ...extra });
    return { root, data, cache: join(data, 'contacts.json'), call, scope, remember };
}
test('lookup无命中不创建cache，且与配置/ERP地址/业务记录无关', (t) => {
    const f = fixture(t), i = identity();
    const out = f.call('lookup', { ...f.scope(i), recipient: i.recipient });
    assert.equal(out.ok, true); assert.equal(out.matches.length, 0); assert.equal(out.revision, null);
    assert.equal(existsSync(f.cache), false);
});
test('平台白名单拒绝原型属性和其他非法平台，且不创建映射文件', (t) => {
    const f = fixture(t);
    for (const platform of ['constructor', 'toString', '__proto__', 'valueOf', '', '淘宝 ', '其他平台']) {
        // 继承属性没有平台契约；故意省略类型字段，防止 undefined === undefined 放行。
        const invalid = identity('淘宝', { platform, account: { value: '匿名买家' },
            recipient: { targetId: 'seller-test', entityType: 'U', channelType: 3, source: 'conversationIdentifier.target' },
            buyer: { targetId: 'buyer-test', uid: 'buyer-test@cntaobao', displayName: '匿名买家', source: 'self-message' } });
        assert.ok(identityProblems(invalid).length, platform);
        assert.equal(f.remember(invalid).error, 'CONTACT_SCOPE', platform);
        assert.equal(f.call('lookup', { ...f.scope(invalid), recipient: invalid.recipient }).error, 'CONTACT_SCOPE', platform);
        assert.equal(existsSync(f.cache), false, platform);
    }
});
test('remember/lookup严格按平台和买家scope隔离，允许同接收者多会话', (t) => {
    const f = fixture(t), first = identity();
    const a = f.remember(first); assert.equal(a.ok, true);
    const b = f.remember(identity('淘宝', { conversationId: 'opaque-conversation-b' }), a.revision); assert.equal(b.ok, true);
    assert.equal(f.call('lookup', { ...f.scope(first), recipient: first.recipient }).matches.length, 2);
    for (const changed of [identity('1688'), identity('淘宝', { account: { ...first.account, value: '另一买家' } })]) {
        assert.equal(f.call('lookup', { ...f.scope(changed), recipient: changed.recipient }).matches.length, 0);
    }
});
test('remember禁止借bindingId使其他商家失效', (t) => {
    const f = fixture(t), first = identity(); const a = f.remember(first);
    const bytes = readFileSync(f.cache, 'utf8');
    const other = identity('淘宝', { recipient: { ...first.recipient, targetId: 'other-seller' }, conversationId: 'other-chat' });
    assert.equal(f.remember(other, a.revision, { bindingId: a.binding.id }).error, 'CONTACT_INPUT');
    assert.equal(readFileSync(f.cache, 'utf8'), bytes);
});
test('rebind同receiver新conversation保留失效旧项，异receiver拒绝', (t) => {
    const f = fixture(t), first = identity(); const a = f.remember(first);
    const next = identity('淘宝', { conversationId: 'new-chat' });
    const changed = { ...next, recipient: { ...next.recipient, targetId: 'other-seller' } };
    const request = { ...f.scope(first), bindingId: a.binding.id, expectedRevision: a.revision };
    assert.equal(f.call('rebind', { ...request, identity: changed }).error, 'CONTACT_REBIND_IDENTITY');
    const b = f.call('rebind', { ...request, identity: next }); assert.equal(b.ok, true);
    const rows = JSON.parse(readFileSync(f.cache, 'utf8')).bindings;
    assert.equal(rows[0].status, 'invalid'); assert.equal(rows[1].identity.conversationId, 'new-chat');
});
test('rebind不能碰撞另一有效conversation，旧revision和锁均拒绝写入', (t) => {
    const f = fixture(t), first = identity(); const a = f.remember(first);
    const second = identity('淘宝', { conversationId: 'second' }); const b = f.remember(second, a.revision);
    assert.equal(f.call('rebind', { ...f.scope(first), bindingId: a.binding.id, expectedRevision: b.revision, identity: second }).error, 'CONTACT_EXISTS');
    assert.equal(f.remember(identity('淘宝', { conversationId: 'third' }), a.revision).error, 'CONTACT_CONFLICT');
    writeFileSync(join(f.data, '.contacts.lock'), 'other owner');
    assert.equal(f.remember(identity('淘宝', { conversationId: 'third' }), b.revision).error, 'CONTACT_BUSY');
    assert.equal(readFileSync(join(f.data, '.contacts.lock'), 'utf8'), 'other owner');
});
test('损坏数据不清空，身份未知字段及矛盾UID不可持久化', (t) => {
    const f = fixture(t), first = identity();
    for (const value of [{ ...first, unexpectedSecret: 'must not persist' }, { ...first, buyer: { ...first.buyer, uid: 'different@cntaobao' } }]) {
        assert.equal(f.remember(value).ok, false); assert.equal(existsSync(f.cache), false);
    }
    writeFileSync(f.cache, '{broken');
    assert.equal(f.call('lookup', { ...f.scope(first), recipient: first.recipient }).ok, false);
    assert.equal(readFileSync(f.cache, 'utf8'), '{broken');
});
test('invalidate只影响当前scope所指行，失效不是删除', (t) => {
    const f = fixture(t), first = identity(); const a = f.remember(first);
    const out = f.call('invalidate', { ...f.scope(first), bindingId: a.binding.id, expectedRevision: a.revision, reason: '只读核验已失效' });
    assert.equal(out.ok, true);
    assert.equal(f.call('lookup', { ...f.scope(first), recipient: first.recipient }).matches.length, 0);
    assert.equal(JSON.parse(readFileSync(f.cache, 'utf8')).bindings.length, 1);
});
test('typed sellerId来源关联受校验，同receiver重绑保留旧证据观察时刻', (t) => {
    const f = fixture(t); const businessIdentity = { type: 'sellerId', value: 'seller-test', source: 'window.pageData.globalData.sellerId',
        sourceUrl: 'https://anonymous-store.1688.com/', shopUrl: 'https://anonymous-store.1688.com/', observedAt: '2026-10-17T02:00:00.000Z',
        buyerId: 'buyer-test', buyerIsLogin: true, memberId: 'opaque-member-test' };
    const first = identity('1688', { businessIdentity }); assert.deepEqual(identityProblems(first), []);
    assert.ok(identityProblems(identity('1688', { businessIdentity: { ...businessIdentity, value: 'wrong' } })).length);
    const a = f.remember(first); assert.equal(a.ok, true);
    const next = identity('1688', { conversationId: 'new-chat' });
    const b = f.call('rebind', { ...f.scope(first), bindingId: a.binding.id, expectedRevision: a.revision, identity: next });
    assert.equal(b.ok, true); assert.deepEqual(b.binding.identity.businessIdentity, businessIdentity);
});
