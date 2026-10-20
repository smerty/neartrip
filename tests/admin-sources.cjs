const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { validateSources, sourceHealth, publicSource } = require('../utils/sources');

const base = { mountPoint: 'BASE', username: 'publisher', password: 'secret', latitude: 0, longitude: 0, active: true };
test('publisher validation accepts zero coordinates and rejects collisions and invalid pairs', () => {
    const config = { mountPoint: 'NEAR', stations: [], sources: [base] };
    assert.equal(validateSources(config), null);
    assert.equal(validateSources({ ...config, sources: [{ ...base, latitude: null, longitude: null }] }), null);
    for (const source of [
        { ...base, mountPoint: 'NEAR' }, { ...base, latitude: 91 },
        { ...base, mountPoint: '.' }, { ...base, mountPoint: '..' },
        { ...base, longitude: null }, { ...base, latitude: '0' },
        { ...base, password: '' }, { ...base, mountPoint: 'bad\r\nSTR' },
        { ...base, active: 'false' },
    ]) assert.ok(validateSources({ ...config, sources: [source] }));
    assert.ok(validateSources({ ...config, sources: [base, base] }));
    assert.ok(validateSources({ ...config, stations: [{ mountPoint: 'BASE' }] }));
});

test('health snapshots expire and publisher API data excludes passwords', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neartrip-health-'));
    try {
        const file = path.join(dir, 'sources.json');
        const config = { sources: [base] };
        assert.equal(sourceHealth(config, file, 10000)[0].health.status, 'unknown');
        fs.writeFileSync(file, JSON.stringify({
            updatedAt: 10000,
            sources: [{ mountPoint: 'BASE', status: 'healthy', lastDataAt: 9999, bytesReceived: 42, subscribers: 2, password: 'bad' }],
        }));
        const health = sourceHealth(config, file, 10001)[0];
        assert.equal(health.health.status, 'healthy');
        assert.equal(health.health.subscribers, 2);
        assert.equal(health.health.bytesReceived, 42);
        assert.equal(health.hasPassword, true);
        assert.ok(!JSON.stringify(health).includes('secret'));
        assert.ok(!JSON.stringify(health).includes('bad'));
        assert.equal(sourceHealth(config, file, 15000)[0].health.status, 'unknown');
        assert.equal(sourceHealth({ sources: [{ ...base, active: false }] }, file, 15000)[0].health.status, 'disabled');
        fs.writeFileSync(file, '{');
        assert.equal(sourceHealth(config, file, 10000)[0].health.status, 'unknown');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function apiFixture(realConfigPath, realFs = fs) {
    const routes = new Map();
    let config = { mountPoint: 'NEAR', stations: [], sources: [], adminPassword: 'admin-secret' };
    if (realConfigPath) config = JSON.parse(fs.readFileSync(realConfigPath, 'utf8'));
    let saved;
    const app = { use() {}, listen() { return { on() {} }; } };
    for (const verb of ['get', 'put', 'post', 'delete']) app[verb] = (route, fn) => routes.set(verb + route, fn);
    const express = () => app;
    express.json = express.static = () => () => {};
    const context = vm.createContext({
        __dirname: path.resolve(__dirname, '../admin'), module: { exports: {} },
        setInterval() { return { unref() {} }; }, clearInterval() {},
        require(name) {
            if (name === 'express') return express;
            if (['cors', 'morgan', 'express-basic-auth'].includes(name)) return () => () => {};
            if (name === 'path') return path;
            if (name === 'fs') return realConfigPath ? realFs : {
                realpathSync(file) { return file; },
                statSync() { return { mode: 0o600 }; },
                mkdtempSync(prefix) { return prefix + 'test'; }, rmSync() {},
                existsSync() { return true; }, writeFileSync(_p, value) { saved = JSON.parse(value); },
                renameSync() {},
            };
            if (name === '../utils/logger') return { info() {}, debug() {}, error() {} };
            if (name === '../utils/config') return {
                getConfig() { return config; }, CONFIG_FILE_PATH: realConfigPath || '/tmp/neartrip-test-config.json',
                reloadConfig() { config = realConfigPath ? JSON.parse(fs.readFileSync(realConfigPath, 'utf8')) : saved; },
            };
            if (name === '../utils/sources') return { validateSources, publicSource, sourceHealth: cfg => cfg.sources.map(publicSource) };
            if (name === '../package.json') return { version: 'test' };
            throw new Error('Unexpected dependency: ' + name);
        },
        process,
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../admin/adminServer.js'), 'utf8'), context);
    context.module.exports.initAdminServer();
    return {
        request(method, route, body = {}, mountPoint = 'BASE') {
            let code = 200, data;
            routes.get(method + route)({ body, params: { mountPoint } }, {
                status(value) { code = value; return this; },
                json(value) { data = JSON.parse(JSON.stringify(value)); },
            });
            return { code, data };
        },
        config() { return config; },
    };
}

test('publisher routes create, edit, disable and delete without returning secrets', () => {
    const api = apiFixture();
    assert.equal(api.request('post', '/api/sources', { ...base, mountPoint: 'NEAR' }).code, 400);
    let result = api.request('post', '/api/sources', base);
    assert.equal(result.code, 201);
    assert.equal(result.data.password, undefined);
    assert.equal(api.request('post', '/api/sources', base).code, 400);
    result = api.request('put', '/api/sources/:mountPoint', { password: '', latitude: 1, longitude: 2, active: false });
    assert.equal(result.code, 200);
    assert.equal(result.data.active, false);
    assert.equal(api.config().sources[0].password, 'secret');
    result = api.request('put', '/api/sources/:mountPoint', { password: 'rotated' });
    assert.equal(result.code, 200);
    assert.equal(api.config().sources[0].password, 'rotated');
    assert.ok(!JSON.stringify(api.request('get', '/api/sources').data).includes('rotated'));
    assert.ok(!JSON.stringify(api.request('get', '/api/info').data).includes('rotated'));
    const invalid = { ...api.config(), sources: [{ ...base, latitude: 999 }] };
    assert.equal(api.request('put', '/api/config', invalid).code, 400);
    assert.equal(api.config().sources[0].password, 'rotated');
    assert.equal(api.request('delete', '/api/sources/:mountPoint').code, 200);
    assert.equal(api.config().sources.length, 0);
    assert.equal(api.request('put', '/api/sources/:mountPoint', { active: true }).code, 404);
    assert.equal(api.request('delete', '/api/sources/:mountPoint').code, 404);
});


test('publisher edits preserve Docker config symlinks and persist in the volume target', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neartrip-config-link-'));
    try {
        const target = path.join(dir, 'volume-config.json');
        const link = path.join(dir, 'config.json');
        fs.writeFileSync(target, JSON.stringify({ mountPoint: 'NEAR', stations: [], sources: [] }));
        fs.symlinkSync(target, link);
        const api = apiFixture(link);
        assert.equal(api.request('post', '/api/sources', base).code, 201);
        assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
        assert.equal(JSON.parse(fs.readFileSync(target)).sources[0].mountPoint, 'BASE');
        assert.equal(api.request('put', '/api/sources/:mountPoint', { active: false }).code, 200);
        assert.equal(JSON.parse(fs.readFileSync(target)).sources[0].active, false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('RTCM position takes precedence while manual coordinates remain an unsaved fallback', () => {
    const { sourcePosition } = require('../utils/sources');
    const detected = {
        latitude: 37.123, longitude: -122.456, ellipsoidalHeightM: 101.25,
        antennaHeightM: 1.2, stationId: 42, messageType: 1006,
        password: 'never-return',
    };
    assert.equal(sourcePosition(base, detected).origin, 'rtcm');
    assert.equal(sourcePosition(base, detected).latitude, 37.123);
    assert.equal(sourcePosition(base, detected).ellipsoidalHeightM, 101.25);
    assert.ok(!JSON.stringify(sourcePosition(base, detected)).includes('never-return'));
    assert.equal(sourcePosition(base, null).origin, 'configured');
    assert.equal(sourcePosition(base, null).latitude, 0);
    assert.equal(sourcePosition({ latitude: null, longitude: null }, null), null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neartrip-position-'));
    try {
        const file = path.join(dir, 'sources.json');
        fs.writeFileSync(file, JSON.stringify({ updatedAt: 10000, sources: [{ mountPoint: 'BASE', position: detected, status: 'healthy' }] }));
        const result = sourceHealth({ sources: [base] }, file, 10001)[0];
        assert.equal(result.position.origin, 'rtcm');
        assert.equal(result.latitude, 0, 'manual configuration must not be replaced');
        assert.equal(sourceHealth({ sources: [base] }, file, 15000)[0].position.origin, 'configured');
        assert.equal(sourceHealth({ sources: [{ ...base, latitude: null, longitude: null }] }, file, 15000)[0].position, null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('onboarding settings validate, persist, and invalidate mismatched health snapshots', () => {
    const api = apiFixture();
    for (const value of [-1, 0.5, 86401, null, '60']) {
        assert.equal(api.request('post', '/api/sources', { ...base, settlingSeconds: value }).code, 400);
    }
    assert.equal(api.config().sources.length, 0);
    const created = api.request('post', '/api/sources', base);
    assert.equal(created.data.settlingSeconds, 60);
    assert.equal(created.data.positionToleranceM, 5);
    assert.equal(api.request('put', '/api/sources/:mountPoint', { settlingSeconds: 120, positionToleranceM: 2.5 }).code, 200);
    assert.equal(api.config().sources[0].settlingSeconds, 120);
    assert.equal(api.config().sources[0].positionToleranceM, 2.5);
    for (const value of [0, -1, 10001, null, '5']) {
        assert.equal(api.request('put', '/api/sources/:mountPoint', { positionToleranceM: value }).code, 400);
    }
    assert.equal(api.config().sources[0].positionToleranceM, 2.5);
    const { onboardingStatus } = require('../utils/sources');
    const ready = { status: 'ready', settlingSeconds: 60, positionToleranceM: 5, elapsedSeconds: 60, remainingSeconds: 0 };
    assert.equal(onboardingStatus(base, ready).status, 'ready');
    assert.equal(onboardingStatus({ ...base, settlingSeconds: 120 }, ready).status, 'unknown');
    assert.equal(onboardingStatus(base, undefined).status, 'unknown');
    assert.equal(onboardingStatus({ ...base, active: false }, ready).status, 'needs_attention');
    assert.equal(api.request('put', '/api/sources/:mountPoint', { settlingSeconds: 0 }).code, 200);
});

test('dashboard renders onboarding countdown and preserves edited settling settings during refresh', async () => {
    class Element {
        constructor() {
            this.children = []; this.listeners = {}; this.style = {};
            this.value = ''; this.checked = false; this.hidden = true; this.disabled = false;
            this.textContent = '';
        }
        appendChild(child) { this.children.push(child); }
        replaceChildren() { this.children = []; }
        addEventListener(event, fn) { this.listeners[event] = fn; }
        reset() {}
        focus() {}
        reportValidity() { return true; }
        querySelector() { return body; }
    }
    const elements = new Map(), body = new Element();
    const element = id => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    const source = {
        ...publicSource(base), position: null,
        health: { status: 'healthy', lastDataAt: Date.now(), bytesReceived: 12, subscribers: 0 },
        onboarding: { status: 'settling', settlingSeconds: 60, remainingSeconds: 45 },
    };
    let start, refresh;
    const mutations = [];
    const context = vm.createContext({
        document: {
            getElementById: element,
            createElement() { return new Element(); },
            addEventListener(_event, fn) { start = fn; },
        },
        setInterval(fn) { refresh = fn; },
        Date, confirm() { return true; },
        async fetch(_url, options) {
            if (options) mutations.push(JSON.parse(options.body));
            return { ok: true, async json() { return options ? {} : [source]; } };
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../admin/public/sources.js'), 'utf8'), context);
    const tick = () => new Promise(resolve => setImmediate(resolve));
    start();
    await tick();
    assert.equal(body.children[0].children.length, 8);
    const onboarding = body.children[0].children[3];
    assert.equal(onboarding.children[0].textContent, 'Settling');
    assert.equal(onboarding.children[1].textContent, '45s remaining of 60s');
    const edit = body.children[0].children[7].children[0];
    await edit.listeners.click();
    assert.equal(element('sourceSettling').value, 60);
    element('sourceSettling').value = '120';
    element('sourceTolerance').value = '2.5';
    await refresh();
    assert.equal(element('sourceSettling').value, '120');
    await element('sourceForm').listeners.submit({ preventDefault() {} });
    assert.equal(mutations[0].settlingSeconds, 120);
    assert.equal(mutations[0].positionToleranceM, 2.5);
    assert.equal(mutations[0].password, '');
    assert.equal(element('sourceForm').hidden, true);
    source.onboarding = { status: 'needs_attention', reason: 'Reported position changed' };
    await refresh();
    assert.equal(body.children[0].children[3].children[0].textContent, 'Needs attention');
    assert.equal(body.children[0].children[3].children[1].textContent, 'Reported position changed');
});


test('config saves keep credentials private before and after atomic replacement', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neartrip-private-config-'));
    try {
        const target = path.join(dir, 'volume-config.json');
        const link = path.join(dir, 'config.json');
        fs.writeFileSync(target, JSON.stringify({ mountPoint: 'NEAR', stations: [], sources: [] }), { mode: 0o600 });
        fs.symlinkSync(target, link);
        const stale = target + '.tmp';
        fs.writeFileSync(stale, 'unrelated stale temporary file', { mode: 0o644 });
        let writes = 0;
        const watchedFs = { ...fs, writeFileSync(file, text, options) {
            assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
            assert.equal(options.mode, 0o600, 'restrict permissions before writing credentials');
            assert.equal(options.flag, 'wx');
            fs.writeFileSync(file, text, options);
            assert.equal(fs.statSync(file).mode & 0o777, 0o600);
            writes++;
        }};
        const api = apiFixture(link, watchedFs);
        assert.equal(api.request('post', '/api/sources', base).code, 201);
        assert.equal(api.request('put', '/api/sources/:mountPoint', { password: 'rotated' }).code, 200);
        assert.equal(writes, 2);
        assert.equal(fs.statSync(target).mode & 0o777, 0o600);
        assert.ok(fs.lstatSync(link).isSymbolicLink());
        assert.equal(fs.readFileSync(stale, 'utf8'), 'unrelated stale temporary file');
        assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'volume-config.json', 'volume-config.json.tmp']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('publisher APIs reject reserved dot mountpoints without saving them', () => {
    const api = apiFixture();
    for (const mountPoint of ['.', '..']) {
        assert.equal(api.request('post', '/api/sources', { ...base, mountPoint }).code, 400);
        assert.equal(api.request('put', '/api/config', { mountPoint: 'NEAR', stations: [], sources: [{ ...base, mountPoint }] }).code, 400);
    }
    assert.equal(api.config().sources.length, 0);
    assert.equal(api.request('post', '/api/sources', { ...base, mountPoint: 'base.v1' }).code, 201);
});


test('publisher creation reserves the core default when the virtual mountpoint is omitted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neartrip-default-mount-'));
    try {
        const file = path.join(dir, 'config.json');
        const original = JSON.stringify({ stations: [], sources: [] });
        fs.writeFileSync(file, original);
        const api = apiFixture(file);
        const result = api.request('post', '/api/sources', { ...base, mountPoint: 'NEAR-Default' });
        assert.equal(result.code, 400);
        assert.equal(api.config().sources.length, 0);
        assert.equal(fs.readFileSync(file, 'utf8'), original, 'rejected configuration must not be saved');
        assert.equal(api.request('post', '/api/sources', base).code, 201);
        assert.equal(api.config().sources[0].mountPoint, 'BASE');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the publisher form and API accept sub-centimeter tolerances during unrelated edits', () => {
    const html = fs.readFileSync(path.join(__dirname, '../admin/public/index.html'), 'utf8');
    const input = html.match(/<input\b[^>]*\bid="sourceTolerance"[^>]*>/)[0];
    const minimum = Number(input.match(/\bmin="([^"]+)"/)?.[1] ?? -Infinity);
    const maximum = Number(input.match(/\bmax="([^"]+)"/)?.[1] ?? Infinity);
    for (const tolerance of [0.005, 0.000001]) {
        assert.ok(tolerance >= minimum && tolerance <= maximum, 'form must accept a valid server tolerance');
        const api = apiFixture();
        assert.equal(api.request('post', '/api/sources', { ...base, positionToleranceM: tolerance }).code, 201);
        const result = api.request('put', '/api/sources/:mountPoint', { username: 'new-publisher' });
        assert.equal(result.code, 200);
        assert.equal(result.data.positionToleranceM, tolerance);
        assert.equal(api.config().sources[0].username, 'new-publisher');
        assert.equal(api.request('put', '/api/sources/:mountPoint', { positionToleranceM: 0 }).code, 400);
    }
});

test('publisher refresh preserves keyboard action focus without stealing focus from forms', async () => {
    let document;
    class Element {
        constructor() {
            this.children = []; this.listeners = {}; this.style = {};
            this.value = ''; this.hidden = false; this.disabled = false;
        }
        appendChild(child) { child.parentNode = this; this.children.push(child); }
        replaceChildren() {
            for (let node = document.activeElement; node; node = node.parentNode) {
                if (node === this) { document.activeElement = document.body; break; }
            }
            this.children = [];
        }
        addEventListener(event, fn) { this.listeners[event] = fn; }
        querySelector() { return body; }
        focus(options) { document.activeElement = this; this.focusOptions = options; }
        reset() {}
    }
    const elements = new Map(), body = new Element();
    const element = id => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    document = {
        body: new Element(), activeElement: null,
        getElementById: element,
        createElement() { return new Element(); },
        addEventListener(_event, fn) { start = fn; },
    };
    const source = mountPoint => ({
        ...publicSource({ ...base, mountPoint }),
        position: null, health: { status: 'healthy', lastDataAt: null, bytesReceived: 0, subscribers: 0 },
        onboarding: { status: 'ready' },
    });
    let records = [source('A'), source('B'), source('C')];
    let start, refresh, pendingResponse;
    const context = vm.createContext({
        document, Date, confirm() { return true; },
        setInterval(fn) { refresh = fn; },
        async fetch() {
            if (pendingResponse) await new Promise(resolve => { pendingResponse = resolve; });
            return { ok: true, async json() { return records; } };
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../admin/public/sources.js'), 'utf8'), context);
    start();
    await new Promise(resolve => setImmediate(resolve));
    const action = (row, column) => body.children[row].children[7].children[column];
    action(1, 1).focus();
    await refresh();
    assert.equal(document.activeElement, action(1, 1));
    assert.equal(document.activeElement.focusOptions.preventScroll, true);

    // Preserve semantic Toggle action when its label and row order change.
    records = [source('C'), source('A'), { ...source('B'), active: false }];
    await refresh();
    assert.equal(document.activeElement, action(2, 1));
    assert.equal(document.activeElement.textContent, 'Enable');

    records = [source('C'), source('A')];
    await refresh();
    assert.equal(document.activeElement, action(1, 1), 'deleted final row falls back to previous publisher');
    records = [source('C')];
    action(0, 2).focus();
    await refresh();
    assert.equal(document.activeElement, action(0, 2));
    records = [];
    await refresh();
    assert.equal(document.activeElement, element('addSourceBtn'));

    records = [source('A'), source('B'), source('C')];
    await refresh();
    action(1, 0).focus();
    records = [source('A'), source('C')];
    await refresh();
    assert.equal(document.activeElement, action(1, 0), 'deleted middle row continues at next publisher');

    element('sourceForm').hidden = false;
    element('sourceUsername').focus();
    await refresh();
    assert.equal(document.activeElement, element('sourceUsername'));

    // Focus may move after the refresh starts but before its response arrives.
    action(0, 0).focus();
    pendingResponse = true;
    const refreshing = refresh();
    element('sourcePassword').focus();
    pendingResponse();
    pendingResponse = null;
    await refreshing;
    assert.equal(document.activeElement, element('sourcePassword'));
});
