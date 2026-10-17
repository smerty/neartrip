const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const tick = () => new Promise(resolve => setImmediate(resolve));

function dashboard(hash = '') {
    const elements = new Map();
    const events = {};
    const sections = ['stations', 'connections', 'map', 'settings'];
    function element(id) {
        if (!elements.has(id)) elements.set(id, {
            style: {}, value: '', listeners: {},
            classList: { add() {}, remove() {}, toggle() {} },
            addEventListener(event, fn) { this.listeners[event] = fn; },
        });
        return elements.get(id);
    }
    const links = sections.map(id => ({
        ...element(`link-${id}`),
        getAttribute() { return `#${id}`; },
    }));
    const requests = [];
    let failConfig = false;
    const config = { mountPoint: 'EXISTING-MOUNT', stations: [{ mountPoint: 'BASE' }] };
    const location = {
        _hash: hash,
        get hash() { return this._hash; },
        set hash(value) {
            const next = String(value).startsWith('#') ? String(value) : `#${value}`;
            if (next === this._hash) return;
            this._hash = next;
            if (events.hashchange) events.hashchange();
        },
    };
    const context = vm.createContext({
        bootstrap: { Modal: class {} },
        document: {
            getElementById: element,
            addEventListener(event, fn) { events[event] = fn; },
            querySelectorAll(selector) { return selector.startsWith('#stations') ? sections.map(element) : links; },
            querySelector(selector) { return links.find(link => selector.includes(`"${link.getAttribute()}"`)); },
        },
        history: {
            replaceState(_state, _title, url) {
                location.hash = String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : url;
            },
        },
        window: {
            location,
            addEventListener(event, fn) { events[event] = fn; },
        },
        setInterval() {}, setTimeout,
        console: { error() {} },
        async fetch(url) {
            requests.push(url);
            if (url === '/api/info') throw new Error('Server info unavailable');
            assert.equal(url, '/api/config');
            return { ok: !failConfig, async json() { return config; } };
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../admin/public/admin.js'), 'utf8'), context);
    // The tests exercise real navigation and config loading; unrelated widgets are stubs.
    vm.runInContext('initMap = () => {}; loadStations = () => {}; loadConnections = () => {};', context);
    events.DOMContentLoaded();
    return {
        element, config, requests,
        click(id) { const link = links.find(link => link.getAttribute() === `#${id}`); link.listeners.click.call(link, { preventDefault() {} }); },
        fail(value) { failConfig = value; },
    };
}

test('opening Settings loads existing config and revisiting preserves edits', async () => {
    const ui = dashboard();
    await tick();
    assert.equal(ui.requests.includes('/api/config'), false);
    ui.click('settings');
    await tick();
    assert.deepEqual(JSON.parse(ui.element('configEditor').value), ui.config);
    ui.element('configEditor').value = 'unsaved edits';
    ui.click('stations');
    ui.click('settings');
    await tick();
    assert.equal(ui.element('configEditor').value, 'unsaved edits');
    assert.equal(ui.requests.filter(url => url === '/api/config').length, 1);
});

test('direct Settings URL loads config even when server info fails', async () => {
    const ui = dashboard('#settings');
    await tick();
    assert.deepEqual(JSON.parse(ui.element('configEditor').value), ui.config);
});

test('failed initial fetch can retry and Cancel explicitly reloads config', async () => {
    const ui = dashboard();
    ui.fail(true);
    ui.click('settings');
    await tick();
    assert.match(ui.element('configEditor').value, /Error loading configuration/);
    ui.fail(false);
    ui.click('stations');
    ui.click('settings');
    await tick();
    assert.deepEqual(JSON.parse(ui.element('configEditor').value), ui.config);
    ui.element('configEditor').value = 'unsaved edits';
    ui.element('cancelConfigBtn').listeners.click();
    await tick();
    assert.deepEqual(JSON.parse(ui.element('configEditor').value), ui.config);
});
