const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const management = require('../utils/management');

function fixture({ diskWatch = false } = {}) {
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
    let configManager = { subscribeConfig(fn) { configListeners.add(fn); return () => configListeners.delete(fn); }, CONFIG_FILE_PATH: configFile, getConfig: () => config,
        reloadConfig() { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); for (const fn of configListeners) fn(config); return config; } };
    if (diskWatch) {
        const configContext = vm.createContext({ __dirname: path.join(dir, 'utils'), module: { exports: {} },
            require(name) { if (name === './logger') return { info() {}, error() {} }; return require(name); } });
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../utils/config.js'), 'utf8'), configContext);
        configManager = configContext.module.exports;
    }
    const sent = [];
    const context = vm.createContext({
        __dirname: path.resolve(__dirname, '../admin'), module: { exports: {} }, setInterval, clearInterval,
        require(name) {
            if (name === '../utils/members') return { setupMembers(app, manager, save, admin) { return require('../utils/members').setupMembers(app, manager, save, { ...admin, mailer: { async send(email, token) { sent.push({ email, token }); } } }); } };
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
    const { app, server } = context.module.exports.initAdminServer({ port: 0, username: 'admin', password: 'console-secret' });
    return {
        sent,
        async login(username = 'alice') {
            const existing = sent.findLast(m => m.email === username + '@example.com');
            if (!existing || existing.used) {
                let result = await this.request('/api/member/login', { method: 'POST', body: { email: username + '@example.com' } });
                if (result.status === 429) { await new Promise(r => setTimeout(r, 2100)); await this.request('/api/member/login', { method: 'POST', body: { email: username + '@example.com' } }); }
            }
            const mail = sent.findLast(m => m.email === username + '@example.com');
            mail.used = true;
            return this.request('/api/member/verify', { method: 'POST', body: { token: mail.token } });
        },
        proxyTrust: () => app.get('trust proxy'),
        config: () => configManager.getConfig(), diskFile: configFile, onConfig: fn => configManager.subscribeConfig(fn), reload(config) { fs.writeFileSync(configFile, JSON.stringify(config)); configManager.reloadConfig(); }, setSnapshot(value) { snapshot = value; },
        async request(url, { auth = false, method = 'GET', body, cookie, csrf, forwarded } = {}) {
            const headers = {};
            if (forwarded) headers['X-Forwarded-For'] = forwarded;
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
        assert.equal(page.status, 200); assert.match(page.body, /Base stations/);
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
        assert.equal((await api.request('/api/members', admin('POST', { username: 'alice', email: 'alice@example.com' }))).status, 201);
        assert.equal((await api.request('/api/members', admin('POST', { username: 'bob', email: 'bob@example.com' }))).status, 201);
        assert.equal(api.config().members[0].email, 'alice@example.com'); assert.equal(api.config().members[0].password, undefined);
        assert.equal((await api.request('/api/member/verify', { method: 'POST', body: { token: 'bad' } })).status, 401);
        const login = await api.login('alice');
        assert.equal(login.status, 200); const cookie = login.cookie;
        const me = await api.request('/api/member/me', { cookie }); const csrf = me.body.csrf;
        assert.equal(me.body.username, 'alice');
        assert.equal((await api.request('/', { cookie })).status, 200);
        assert.equal((await api.request('/api/public/stations', { cookie })).status, 200);
        for (const url of ['/api/members', '/api/config', '/api/stats', '/api/security', '/api/users', '/admin']) assert.equal((await api.request(url, { cookie })).status, 401, url);
        assert.equal((await api.request('/api/member/rovers', { cookie, method: 'POST', body: {} })).status, 403);
        const rover = await api.request('/api/member/rovers', { cookie, csrf, method: 'POST', body: { owner: 'bob' } });
        assert.equal(rover.status, 201); assert.equal(api.config().users[0].owner, 'alice'); assert.ok(rover.body.password);
        assert.match(rover.body.username, /^rover-[a-f0-9]{8}$/);
        assert.match(rover.body.password, /^[A-Za-z0-9_-]{12}$/);
        const list = await api.request('/api/member/rovers', { cookie }); assert.equal(list.body.users[0].password, undefined);
        const bob = await api.login('bob');
        const bobCsrf = (await api.request('/api/member/me', { cookie: bob.cookie })).body.csrf;
        assert.equal((await api.request('/api/member/rovers', { cookie: bob.cookie })).body.users.length, 0);
        assert.equal((await api.request('/api/member/rovers/' + rover.body.username, { cookie: bob.cookie, csrf: bobCsrf, method: 'PUT', body: { rotate: true } })).status, 404);
        const rotated = await api.request('/api/member/rovers/' + rover.body.username, { cookie, csrf, method: 'PUT', body: { rotate: true } });
        assert.notEqual(rotated.body.password, rover.body.password);
        assert.match(rotated.body.password, /^[A-Za-z0-9_-]{12}$/);
        assert.equal(rotated.body.username, rover.body.username);
        await api.request('/api/members/alice', admin('PUT', { active: false }));
        assert.equal((await api.request('/api/member/me', { cookie })).status, 401);
        assert.equal((await api.request('/api/public/stations', { cookie })).status, 401);
        assert.equal((await api.request('/api/member/login', { method: 'POST', body: { email: 'alice@example.com' } })).status, 200);
        await api.request('/api/members/alice', admin('PUT', { active: true }));
        assert.equal((await api.request('/api/member/me', { cookie })).status, 401, 're-enabling cannot revive an old session');
        await api.request('/api/members/alice', admin('PUT', { password: 'new-password-for-alice' }));
        assert.equal((await api.request('/api/member/me', { cookie })).status, 401);
        const fresh = await api.login();
        const freshCsrf = (await api.request('/api/member/me', { cookie: fresh.cookie })).body.csrf;
        await api.request('/api/member/logout', { cookie: fresh.cookie, csrf: freshCsrf, method: 'POST', body: {} });
        assert.equal((await api.request('/api/member/me', { cookie: fresh.cookie })).status, 401);
    } finally { await api.close(); }
});

test('settings saves and disk reloads permanently invalidate member cookies across disable and re-enable', async () => {
    const api = fixture(), admin = (method, body) => ({ auth: true, method, body });
    const login = async () => (await api.login('alice')).cookie;
    try {
        await api.request('/api/members', admin('POST', { username: 'alice', email: 'alice@example.com' }));
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

test('production watcher reloads disk edits and atomic replacements, invalidating cookies without an explicit reload', async () => {
    const api = fixture({ diskWatch: true });
    const login = async () => (await api.login('alice')).cookie;
    let writePath = api.diskFile;
    async function diskUpdate(config, atomic) {
        let unsubscribe;
        const observed = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { unsubscribe(); reject(new Error('disk change not observed')); }, 3000);
            unsubscribe = api.onConfig(() => { clearTimeout(timer); unsubscribe(); resolve(); });
        });
        if (atomic) { fs.writeFileSync(writePath + '.new', JSON.stringify(config)); fs.renameSync(writePath + '.new', writePath); }
        else fs.writeFileSync(writePath, JSON.stringify(config));
        await observed;
    }
    try {
        await api.request('/api/members', { auth: true, method: 'POST', body: { username: 'alice', email: 'alice@example.com' } });
        for (const mode of [false, true, true, 'symlink']) {
            if (mode === 'symlink') {
                writePath = api.diskFile + '.target';
                fs.renameSync(api.diskFile, writePath); fs.symlinkSync(writePath, api.diskFile);
            }
            const atomic = mode !== false;
            const cookie = await login(), config = JSON.parse(JSON.stringify(api.config()));
            await diskUpdate({ ...config, members: config.members.map(m => ({ ...m, active: false })) }, atomic);
            assert.equal((await api.request('/api/member/me', { cookie })).status, 401);
            assert.equal((await api.request('/api/member/login', { method: 'POST', body: { email: 'alice@example.com' } })).status, 200);
            await diskUpdate(config, atomic);
            assert.equal((await api.request('/api/member/me', { cookie })).status, 401, 're-enable cannot restore the old cookie');
        }
        // Synchronous reads also observe edits before the poll fires.
        const cookie = await login(), config = JSON.parse(JSON.stringify(api.config()));
        fs.writeFileSync(api.diskFile, JSON.stringify({ ...config, members: config.members.map(m => ({ ...m, active: false })) }));
        assert.equal((await api.request('/api/member/rovers', { cookie, method: 'POST', csrf: 'unused', body: {} })).status, 401);
        assert.equal(JSON.parse(fs.readFileSync(api.diskFile)).members[0].active, false);
        fs.writeFileSync(api.diskFile, '{');
        assert.equal((await api.request('/api/member/me', { cookie })).status, 401);
        assert.equal((await api.request('/api/member/login', { method: 'POST', body: { email: 'alice@example.com' } })).status, 400);
        assert.equal(fs.readFileSync(api.diskFile, 'utf8'), '{', 'invalid config must not be replaced with defaults');
        fs.writeFileSync(api.diskFile, JSON.stringify(config));
        assert.equal((await api.request('/api/member/me', { cookie: await login() })).status, 200);
    } finally { await api.close(); }
});


test('trusted proxy clients have independent login budgets and untrusted forwarding cannot spoof IPs', async () => {
    const saved = process.env.NEARTRIP_TRUSTED_PROXIES;
    const run = async mode => {
        const trusted = mode === 'trusted';
        if (trusted) process.env.NEARTRIP_TRUSTED_PROXIES = '127.0.0.1/32';
        else if (mode === 'empty') process.env.NEARTRIP_TRUSTED_PROXIES = '';
        else delete process.env.NEARTRIP_TRUSTED_PROXIES;
        const api = fixture();
        try {
            assert.equal(typeof api.proxyTrust(), trusted ? 'function' : 'boolean');
            if (!trusted) assert.equal(api.proxyTrust(), false, 'forwarded headers stay untrusted by default');
            await api.request('/api/members', { auth: true, method: 'POST', body: { username: 'alice', email: 'alice@example.com' } });
            // Invalid passwords skip the KDF; unique account names isolate IP budgeting.
            for (let i = 0; i < 100; i++) {
                const result = await api.request('/api/member/login', { method: 'POST', forwarded: '192.0.2.1', body: { username: 'unknown' + i } });
                assert.equal(result.status, 200);
            }
            const login = await api.request('/api/member/login', { method: 'POST', forwarded: '192.0.2.2', body: { email: 'alice@example.com' } });
            assert.equal(login.status, 200, 'unset proxy trust must not block every member behind a shared peer');
            if (!trusted) {
                // Hostile forwarding headers remain ignored without proxy trust.
                const ordinary = await api.login('alice');
                assert.equal(ordinary.status, 200);
            }
            if (trusted) {
                // A forged leftmost address cannot bypass the first untrusted hop.
                const forged = await api.request('/api/member/login', { method: 'POST', forwarded: '192.0.2.99, 192.0.2.1', body: { email: 'alice@example.com' } });
                assert.equal(forged.status, 429);
            }
        } finally { await api.close(); }
    };
    try { await run('trusted'); await run('unset'); await run('empty'); }
    finally {
        if (saved === undefined) delete process.env.NEARTRIP_TRUSTED_PROXIES;
        else process.env.NEARTRIP_TRUSTED_PROXIES = saved;
    }
});

test('ten thousand unknown usernames cannot deny a valid member login without proxy configuration', async () => {
    const saved = process.env.NEARTRIP_TRUSTED_PROXIES;
    delete process.env.NEARTRIP_TRUSTED_PROXIES;
    const api = fixture();
    try {
        await api.request('/api/members', { auth: true, method: 'POST', body: { username: 'alice', email: 'alice@example.com' } });
        for (let i = 0; i < 10000; i++) {
            const result = await api.request('/api/member/login', { method: 'POST', body: { username: 'unknown' + i } });
            assert.equal(result.status, 200);
        }
        const login = await api.login('alice');
        assert.equal(login.status, 200);
    } finally {
        await api.close();
        if (saved === undefined) delete process.env.NEARTRIP_TRUSTED_PROXIES;
        else process.env.NEARTRIP_TRUSTED_PROXIES = saved;
    }
});

test('magic links require an invited active email, expire, and are single use', async () => {
    const api = fixture(), now = Date.now;
    try {
        await api.request('/api/members', { auth: true, method: 'POST', body: { username: 'alice', email: 'Alice@example.com' } });
        assert.equal(api.config().members[0].email, 'alice@example.com');
        const request = email => api.request('/api/member/login', { method: 'POST', body: { email } });
        const verify = token => api.request('/api/member/verify', { method: 'POST', body: { token } });
        const unknown = await request('stranger@example.com');
        const invited = await request('ALICE@example.com');
        assert.deepEqual(unknown.body, invited.body);
        assert.equal(api.sent.length, 1);
        await request('alice@example.com');
        assert.equal(api.sent.length, 1, 'email cooldown');
        const token = api.sent[0].token;
        assert.equal((await verify(token)).status, 200);
        assert.equal((await verify(token)).status, 401, 'no token replay');
        await request('alice@example.com');
        const expired = api.sent.at(-1).token;
        Date.now = () => now() + 900001;
        assert.equal((await verify(expired)).status, 401, '15 minute expiry');
        Date.now = now;
        await request('alice@example.com');
        const revoked = api.sent.at(-1).token;
        await api.request('/api/members/alice', { auth: true, method: 'PUT', body: { active: false } });
        await api.request('/api/members/alice', { auth: true, method: 'PUT', body: { active: true } });
        assert.equal((await verify(revoked)).status, 401, 'disable revokes pending link permanently');
    } finally { Date.now = now; await api.close(); }
});

test('members can delete only their own rover credentials and reclaim a full account slot', async () => {
    const api = fixture();
    try {
        for (const username of ['alice', 'bob']) await api.request('/api/members', { auth: true, method: 'POST', body: { username, email: username + '@example.com' } });
        const alice = await api.login('alice'), bob = await api.login('bob');
        const aliceCsrf = (await api.request('/api/member/me', { cookie: alice.cookie })).body.csrf;
        const bobCsrf = (await api.request('/api/member/me', { cookie: bob.cookie })).body.csrf;
        const create = () => api.request('/api/member/rovers', { cookie: alice.cookie, csrf: aliceCsrf, method: 'POST', body: {} });
        const first = await create(), url = '/api/member/rovers/' + first.body.username;
        for (let i = 1; i < 10; i++) assert.equal((await create()).status, 201);
        assert.equal((await create()).status, 400);
        assert.equal((await api.request(url, { method: 'DELETE' })).status, 401);
        assert.equal((await api.request(url, { cookie: alice.cookie, method: 'DELETE' })).status, 403);
        assert.equal((await api.request(url, { cookie: bob.cookie, csrf: bobCsrf, method: 'DELETE' })).status, 404);
        const remove = () => api.request(url, { cookie: alice.cookie, csrf: aliceCsrf, method: 'DELETE' });
        assert.equal((await remove()).status, 200);
        assert.equal(api.config().users.some(u => u.username === first.body.username), false);
        assert.equal((await api.request('/api/member/rovers', { cookie: alice.cookie })).body.users.length, 9);
        assert.equal((await remove()).status, 404);
        assert.equal((await create()).status, 201, 'deletion frees capacity');
        for (const u of [...api.config().users]) await api.request('/api/member/rovers/' + u.username, { cookie: alice.cookie, csrf: aliceCsrf, method: 'DELETE' });
        assert.equal(api.config().users.length, 0);
        assert.equal((await api.request('/api/users', { auth: true })).body.mode, 'accounts', 'members keep anonymous fallback disabled');
    } finally { await api.close(); }
});
