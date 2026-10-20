const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function dashboard(records) {
    const body = { innerHTML: '', rows: [], appendChild(row) { this.rows.push(row); } };
    const summary = {};
    const context = vm.createContext({
        bootstrap: { Modal: class {} },
        document: {
            getElementById(id) { return id === 'connectionSummary' ? summary : {}; },
            addEventListener() {},
            querySelector() { return body; },
            createElement() { return { classList: { add() {} } }; },
        },
        console,
        async fetch() { return { ok: true, async json() { return records; } }; },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../admin/public/admin.js'), 'utf8'), context);
    return { context, body, summary };
}

test('dashboard distinguishes TCP sockets, accepted rovers and streaming rovers', async () => {
    const defaults = { id: 'abc123', connectedAt: '2026-10-18T10:00:00Z', bytesSent: 0, bytesReceived: 0 };
    const ui = dashboard([
        { ...defaults, active: true, status: 'tcp_connected' },
        { ...defaults, active: true, authenticated: true, status: 'awaiting_gga' },
        { ...defaults, active: true, authenticated: true, status: 'streaming', upstreamStatus: 'connected', bytesSent: 4096, latitude: 0, longitude: 0, lastGgaAt: defaults.connectedAt },
        { ...defaults, active: false, authenticated: true, status: 'disconnected', disconnectReason: 'client idle timeout', readIdleTimeoutSecs: 120 },
        { ...defaults, active: true, authenticated: true, status: 'awaiting_upstream', upstreamStatus: 'error', lastUpstreamError: '<script>probe</script>' },
    ]);
    await vm.runInContext('loadConnections()', ui.context);
    assert.equal(ui.summary.textContent, '4 connected sockets · 3 active rovers · 1 streaming');
    assert.match(ui.body.rows[2].innerHTML, /0\.000000/);
    assert.match(ui.body.rows[2].innerHTML, /4 KB/);
    assert.match(ui.body.rows[3].innerHTML, /client idle timeout/);
    assert.match(ui.body.rows[3].innerHTML, /120 s/);
    assert.match(ui.body.rows[4].innerHTML, /&lt;script&gt;probe&lt;\/script&gt;/);
    assert.doesNotMatch(ui.body.rows[4].innerHTML, /<script>/);
});

test('empty history resets counts and renders the correct table width', async () => {
    const ui = dashboard([]);
    await vm.runInContext('loadConnections()', ui.context);
    assert.equal(ui.summary.textContent, '0 connected sockets · 0 active rovers · 0 streaming');
    assert.match(ui.body.innerHTML, /colspan="17"/);
});

function adminApi(coreRecords) {
    const routes = new Map();
    const files = new Map();
    const sessionsFile = path.resolve(__dirname, '../logs/sessions.json');
    if (coreRecords !== undefined) files.set(sessionsFile, JSON.stringify(coreRecords));
    const app = { use() {}, get(route, handler) { routes.set(route, handler); }, post() {}, put() {}, delete() {}, listen() { return { on() {} }; } };
    const express = () => app;
    express.json = () => () => {};
    express.static = () => () => {};
    let purge;
    const context = vm.createContext({
        __dirname: path.resolve(__dirname, '../admin'),
        module: { exports: {} },
        process: { env: {} },
        setInterval(fn) { purge = fn; return { unref() {} }; }, clearInterval() {},
        require(name) {
            if (name === 'express') return express;
            if (['cors', 'morgan', 'express-basic-auth'].includes(name)) return () => () => {};
            if (name === 'path') return path;
            if (name === 'fs') return {
                existsSync(file) { return files.has(file); }, mkdirSync() {},
                readFileSync(file) { if (!files.has(file)) throw new Error('missing'); return files.get(file); },
                writeFileSync(file, value) { files.set(file, value); },
                unlinkSync(file) { files.delete(file); },
            };
            if (name === '../utils/logger') return { info() {}, debug() {}, error() {} };
            if (name === '../utils/config') return {};
            if (name === '../utils/members') return { setupMembers() { return { guard(_req, _res, next) { next(); }, setupAdmin() {} }; } };
            if (name === '../utils/management') return require('../utils/management');
            if (name === '../utils/sources') return require('../utils/sources');
            throw new Error(`Unexpected dependency: ${name}`);
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../admin/adminServer.js'), 'utf8'), context);
    const api = context.module.exports;
    api.initAdminServer();
    return {
        api, purge() { purge(); },
        list() { let result; routes.get('/api/connections')({}, { json(value) { result = JSON.parse(JSON.stringify(value)); } }); return result; },
    };
}

test('connections API returns core diagnostics and sorts active sessions first', () => {
    const records = [
        { id: 'aa', active: false, connectedAt: '2026-10-18T12:00:00Z', disconnectReason: 'core restarted' },
        { id: 'bb', active: true, connectedAt: '2026-10-17T12:00:00Z', status: 'streaming', lastGgaAt: '2026-10-18T12:00:00Z', upstreamStatus: 'connected', bytesSent: 1024 },
    ];
    const admin = adminApi(records);
    assert.deepEqual(admin.list(), [records[1], records[0]]);
});

test('valid empty core snapshot is authoritative over legacy connections', () => {
    const admin = adminApi([]);
    admin.api.trackConnection('cc', { clientIp: '127.0.0.1' });
    assert.deepEqual(admin.list(), []);
});

test('legacy purge preserves connected rovers older than seven days', () => {
    const admin = adminApi();
    admin.api.trackConnection('aa', { connectedAt: '2000-01-01T00:00:00Z' });
    admin.api.trackConnection('bb', { connectedAt: '2000-01-01T00:00:00Z', active: false, disconnectedAt: '2000-01-01T01:00:00Z' });
    admin.purge();
    assert.deepEqual(admin.list().map(row => row.id), ['aa']);
});
