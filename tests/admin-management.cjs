const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const management = require('../utils/management');

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neartrip-console-'));
    const configFile = path.join(dir, 'config.json');
    let config = {
        mountPoint: 'NEAR', stations: [{ mountPoint: 'RELAY', latitude: 38, longitude: -122,
            casterHost: 'private-upstream', casterPort: 2101, username: 'upstream-user', password: 'upstream-secret' }],
        sources: [{ mountPoint: 'DIRECT', latitude: 37, longitude: -122, username: 'base-private', password: 'base-secret' }],
        users: [], adminPassword: 'web-secret',
    };
    fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    let snapshot = { updatedAt: Date.now(), stats: { startedAt: Date.now(), clients: [{ key: 'login:private-rover' }], bases: [] },
        security: [{ ip: '192.0.2.44', authenticationFailures: 30 }] };
    const configListeners = new Set();
    const configManager = { subscribeConfig(fn) { configListeners.add(fn); return () => configListeners.delete(fn); }, CONFIG_FILE_PATH: configFile, getConfig: () => config,
        reloadConfig() { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); for (const fn of configListeners) fn(config); return config; } };
    const context = vm.createContext({
        __dirname: path.resolve(__dirname, '../admin'), module: { exports: {} }, setInterval, clearInterval,
        require(name) {
            if (name === '../utils/config') return configManager;
            if (name === '../utils/logger') return { info() {}, debug() {}, error() {} };
            if (name === '../utils/management') return { ...management,
                setupManagement(app, manager, save) { management.setupManagement(app, manager, save, () => snapshot); } };
            if (name === 'morgan') return () => (_req, _res, next) => next();
            if (name === '../utils/sources') return require('../utils/sources');
            if (name === '../package.json') return { version: 'test' };
            return require(name);
        },
        process,
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../admin/adminServer.js'), 'utf8'), context);
    const { server } = context.module.exports.initAdminServer({ port: 0, username: 'admin', password: 'console-secret' });
    return {
        config: () => config, reload(config) { fs.writeFileSync(configFile, JSON.stringify(config)); configManager.reloadConfig(); }, setSnapshot(value) { snapshot = value; },
        async request(url, { auth = false, method = 'GET', body, cookie, csrf } = {}) {
            const headers = {};
            if (cookie) headers.Cookie = cookie;
            if (csrf) headers['X-CSRF-Token'] = csrf;
            if (auth) headers.Authorization = 'Basic ' + Buffer.from('admin:console-secret').toString('base64');
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            const response = await fetch('http://127.0.0.1:' + server.address().port + url, {
                method, headers, body: body === undefined ? undefined : JSON.stringify(body),
            });
            const text = await response.text();
            return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
                cookie: response.headers.get('set-cookie')?.split(';')[0], cache: response.headers.get('cache-control') };
        },
        async close() { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); },
    };
}
test('station directory requires member or admin authentication and exposes only base metadata', async () => {
    const api = fixture();
    try {
        assert.equal((await api.request('/api/public/stations')).status, 401);
        assert.match((await api.request('/index.html')).body, /Contact your network administrator/); // fetch follows redirect to login
        const page = await api.request('/', { auth: true });
        assert.equal(page.status, 200); assert.match(page.body, /Precision starts nearby/);
        const directory = await api.request('/api/public/stations', { auth: true });
        assert.equal(directory.status, 200); assert.equal(directory.body.length, 2);
        const serialized = JSON.stringify(directory.body);
        for (const secret of ['base-secret', 'base-private', 'upstream-secret', 'upstream-user', 'private-upstream', 'private-rover', '192.0.2.44', 'bytesSent']) {
            assert.ok(!serialized.includes(secret), secret);
        }
        for (const url of ['/admin', '/admin.js', '/sources.js', '/management.js', '/api/config', '/api/users', '/api/stats', '/api/security', '/api/connections']) {
            assert.equal((await api.request(url)).status, 401, url);
        }
        assert.equal((await api.request('/api/users', { method: 'POST', body: { username: 'x', password: 'y' } })).status, 401);
        assert.equal(api.config().users.length, 0);
        assert.equal((await api.request('/admin', { auth: true })).status, 200);
        const stats = await api.request('/api/stats', { auth: true });
        assert.equal(stats.status, 200); assert.equal(stats.cache, 'no-store');
        assert.equal(stats.body.clients[0].key, 'login:private-rover');
        api.setSnapshot(null);
        assert.equal((await api.request('/api/stats', { auth: true })).status, 503);
    } finally { await api.close(); }
});
test('rover users can be created, rotated, disabled and removed without disclosing passwords or reopening anonymous access', async () => {
    const api = fixture();
    const options = (method, body) => ({ auth: true, method, body });
    try {
        assert.equal((await api.request('/api/users', { auth: true })).body.mode, 'anonymous');
        let response = await api.request('/api/users', options('POST', { username: 'tractor', password: 'first-secret' }));
        assert.equal(response.status, 201); assert.equal(response.body.password, undefined);
        assert.equal((await api.request('/api/users', options('POST', { username: 'tractor', password: 'x' }))).status, 400);
        response = await api.request('/api/users/tractor', options('PUT', { password: '', active: false }));
        assert.equal(response.status, 200); assert.equal(response.body.active, false);
        assert.equal(api.config().users[0].password, 'first-secret');
        assert.equal((await api.request('/api/users/tractor', options('PUT', { password: 'rotated' }))).status, 200);
        assert.equal(api.config().users[0].password, 'rotated');
        assert.ok(!JSON.stringify((await api.request('/api/users', { auth: true })).body).includes('rotated'));
        assert.equal((await api.request('/api/users/tractor', options('DELETE'))).status, 409);
        assert.equal((await api.request('/api/users', options('POST', { username: 'survey', password: 'second' }))).status, 201);
        assert.equal((await api.request('/api/users/tractor', options('DELETE'))).status, 200);
        assert.equal(api.config().users[0].username, 'survey');
        for (const username of ['.', '..', 'invalid:name', '<script>']) {
            assert.equal((await api.request('/api/users', options('POST', { username, password: 'x' }))).status, 400);
        }
    } finally { await api.close(); }
});
test('IP policy defaults to observation, validates thresholds, and supports explicit permanent, temporary and exemption actions', async () => {
    const api = fixture();
    const post = body => api.request('/api/security/ban', { auth: true, method: 'POST', body });
    try {
        let response = await api.request('/api/security', { auth: true });
        assert.equal(response.body.settings.autoSoftBan, false); assert.equal(response.body.settings.failureThreshold, 20);
        assert.equal((await api.request('/api/security', { auth: true, method: 'PUT', body: { failureThreshold: 2 } })).status, 400);
        assert.equal((await api.request('/api/security', { auth: true, method: 'PUT',
            body: { autoSoftBan: true, allowlistedIps: ['2001:0db8:0:0:0:0:0:1'] } })).status, 200);
        assert.deepEqual(api.config().security.allowlistedIps, ['2001:db8::1']);
        assert.equal((await post({ ip: '::ffff:192.0.2.1', kind: 'permanent', reason: 'reviewed' })).status, 200);
        assert.equal(api.config().security.permanentBans[0].ip, '192.0.2.1');
        assert.equal((await post({ ip: '192.0.2.1', kind: 'exempt' })).status, 200);
        assert.equal(api.config().security.permanentBans.length, 1, 'auto exemptions do not override manual bans');
        assert.equal((await post({ ip: '192.0.2.1', kind: 'unban' })).status, 200);
        assert.equal(api.config().security.permanentBans.length, 0);
        assert.equal((await post({ ip: '192.0.2.1', kind: 'temporary' })).status, 200);
        assert.ok(api.config().security.temporaryBans[0].until > Date.now());
        assert.equal((await post({ ip: 'not-an-ip', kind: 'permanent' })).status, 400);
        assert.equal((await post({ ip: '192.0.2.1', kind: 'invalid' })).status, 400);
    } finally { await api.close(); }
});
test('operations snapshots expire and management rejects invalid accounts and policies', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neartrip-ops-'));
    try {
        const file = path.join(dir, 'operations.json');
        fs.writeFileSync(file, JSON.stringify({ updatedAt: 10000, stats: { clients: [] } }));
        assert.ok(management.operations(file, 10001));
        assert.equal(management.operations(file, 15000), null);
        fs.writeFileSync(file, '{'); assert.equal(management.operations(file), null);
        assert.ok(management.validateManagement({ users: [{ username: 'x', password: '' }] }));
        assert.ok(management.validateManagement({ security: { autoSoftBan: 'true' } }));
        assert.equal(management.validateManagement({ users: [{ username: 'x', password: 'y' }], security: {} }), null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('members own rover credentials, cannot reach admin data, and lose sessions and rover access when disabled', async () => {
    const api = fixture(), admin = (method, body) => ({ auth: true, method, body });
    try {
        assert.equal((await api.request('/api/members', admin('POST', { username: 'alice', password: 'long-member-password' }))).status, 201);
        assert.equal((await api.request('/api/members', admin('POST', { username: 'bob', password: 'another-long-password' }))).status, 201);
        assert.ok(api.config().members[0].passwordHash); assert.equal(api.config().members[0].password, undefined);
        assert.equal((await api.request('/api/member/login', { method: 'POST', body: { username: 'alice', password: 'wrong' } })).status, 401);
        const login = await api.request('/api/member/login', { method: 'POST', body: { username: 'alice', password: 'long-member-password' } });
        assert.equal(login.status, 200); const cookie = login.cookie;
        const me = await api.request('/api/member/me', { cookie }); const csrf = me.body.csrf;
        assert.equal(me.body.username, 'alice');
        assert.equal((await api.request('/', { cookie })).status, 200);
        assert.equal((await api.request('/api/public/stations', { cookie })).status, 200);
        for (const url of ['/api/members', '/api/config', '/api/stats', '/api/security', '/api/users', '/admin']) assert.equal((await api.request(url, { cookie })).status, 401, url);
        assert.equal((await api.request('/api/member/rovers', { cookie, method: 'POST', body: {} })).status, 403);
        const rover = await api.request('/api/member/rovers', { cookie, csrf, method: 'POST', body: { owner: 'bob' } });
        assert.equal(rover.status, 201); assert.equal(api.config().users[0].owner, 'alice'); assert.ok(rover.body.password);
        const list = await api.request('/api/member/rovers', { cookie }); assert.equal(list.body.users[0].password, undefined);
        const bob = await api.request('/api/member/login', { method: 'POST', body: { username: 'bob', password: 'another-long-password' } });
        const bobCsrf = (await api.request('/api/member/me', { cookie: bob.cookie })).body.csrf;
        assert.equal((await api.request('/api/member/rovers', { cookie: bob.cookie })).body.users.length, 0);
        assert.equal((await api.request('/api/member/rovers/' + rover.body.username, { cookie: bob.cookie, csrf: bobCsrf, method: 'PUT', body: { rotate: true } })).status, 404);
        const rotated = await api.request('/api/member/rovers/' + rover.body.username, { cookie, csrf, method: 'PUT', body: { rotate: true } });
        assert.notEqual(rotated.body.password, rover.body.password);
        await api.request('/api/members/alice', admin('PUT', { active: false }));
        assert.equal((await api.request('/api/member/me', { cookie })).status, 401);
        assert.equal((await api.request('/api/public/stations', { cookie })).status, 401);
        assert.equal((await api.request('/api/member/login', { method: 'POST', body: { username: 'alice', password: 'long-member-password' } })).status, 401);
        await api.request('/api/members/alice', admin('PUT', { active: true }));
        assert.equal((await api.request('/api/member/me', { cookie })).status, 401, 're-enabling cannot revive an old session');
        await api.request('/api/members/alice', admin('PUT', { password: 'new-password-for-alice' }));
        assert.equal((await api.request('/api/member/me', { cookie })).status, 401);
        const fresh = await api.request('/api/member/login', { method: 'POST', body: { username: 'alice', password: 'new-password-for-alice' } });
        const freshCsrf = (await api.request('/api/member/me', { cookie: fresh.cookie })).body.csrf;
        await api.request('/api/member/logout', { cookie: fresh.cookie, csrf: freshCsrf, method: 'POST', body: {} });
        assert.equal((await api.request('/api/member/me', { cookie: fresh.cookie })).status, 401);
    } finally { await api.close(); }
});

test('settings saves and disk reloads permanently invalidate member cookies across disable and re-enable', async () => {
    const api = fixture(), admin = (method, body) => ({ auth: true, method, body });
    const login = async () => (await api.request('/api/member/login', { method: 'POST', body: { username: 'alice', password: 'long-member-password' } })).cookie;
    try {
        await api.request('/api/members', admin('POST', { username: 'alice', password: 'long-member-password' }));
        for (const method of ['settings', 'reload']) {
            // Test both a cookie used while disabled and one not used until after re-enable.
            const used = await login(), unused = await login();
            const update = async active => {
                const config = { ...api.config(), members: api.config().members.map(m => ({ ...m, active })) };
                if (method === 'settings') assert.equal((await api.request('/api/config', admin('PUT', config))).status, 200);
                else api.reload(config);
            };
            await update(false);
            assert.equal((await api.request('/api/member/me', { cookie: used })).status, 401);
            await update(true);
            for (const cookie of [used, unused]) assert.equal((await api.request('/api/member/me', { cookie })).status, 401, method);
            assert.equal((await api.request('/api/member/me', { cookie: await login() })).status, 200);
        }
    } finally { await api.close(); }
});

test('operations override resolves from launch cwd for both absolute and relative snapshot paths', () => {
    const { spawnSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neartrip-operations-path-'));
    try {
        const file = path.join(dir, 'custom.json'), snapshot = { updatedAt: Date.now(), stats: { clients: [], bases: [] }, security: [] };
        fs.writeFileSync(file, JSON.stringify(snapshot));
        for (const override of ['custom.json', file]) {
            const script = `const paths = require(${JSON.stringify(path.resolve(__dirname, '../utils/paths'))}); const management = require(${JSON.stringify(path.resolve(__dirname, '../utils/management'))}); process.chdir('/'); console.log(JSON.stringify({file:paths.OPERATIONS_PATH, data:management.operations()}));`;
            const result = spawnSync(process.execPath, ['-e', script], { cwd: dir, env: { ...process.env, NEARTRIP_OPERATIONS: override }, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            const actual = JSON.parse(result.stdout);
            assert.equal(actual.file, file); assert.deepEqual(actual.data, snapshot);
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native login submission cannot place named credentials in a GET URL', () => {
    const html = fs.readFileSync(path.join(__dirname, '../web/public/login.html'), 'utf8');
    const form = html.match(/<form\b[^>]*id="loginForm"[^>]*>/)[0];
    assert.match(form, /method="post"/i);
    assert.match(form, /action="\/login"/i);
});
