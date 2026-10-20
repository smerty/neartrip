const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('station Edit opens the real form and saves values, original mountpoint, and active status', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../admin/public/index.html'), 'utf8');
    // Resolve only IDs that actually exist in the template, so markup/script drift fails.
    const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, { value: '', checked: false }]));
    const rows = [], requests = [], alerts = [];
    let shown = 0, hidden = 0;
    const station = { mountPoint: 'OLD_BASE', casterHost: 'caster.example.com', casterPort: 2101,
        username: 'user', password: 'password', latitude: 37.8, longitude: -122.2, active: false };
    const context = vm.createContext({
        bootstrap: { Modal: class { show() { shown++; } hide() { hidden++; } } },
        document: {
            getElementById: id => elements.get(id) || null,
            addEventListener() {},
            querySelector: () => ({ innerHTML: '', appendChild(row) { rows.push(row); } }),
            createElement() {
                const handlers = {};
                return { handlers, querySelector(selector) { return { addEventListener(event, fn) { handlers[selector] = fn; } }; } };
            },
        },
        console, alert: message => alerts.push(message),
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, json: async () => [station] };
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../admin/public/admin.js'), 'utf8'), context);
    await context.loadStations();
    rows[0].handlers['.edit-btn']();
    assert.equal(shown, 1);
    assert.equal(elements.get('stationMountPoint').value, 'OLD_BASE');
    assert.equal(elements.get('stationPassword').value, 'password');
    assert.equal(elements.get('stationActive').checked, false);
    elements.get('stationMountPoint').value = 'NEW_BASE';
    elements.get('stationCasterPort').value = '2201';
    elements.get('stationLatitude').value = '38.1';
    await context.saveStation();
    assert.deepEqual(alerts, []);
    const update = requests.find(req => req.options?.method === 'PUT');
    assert.equal(update.url, '/api/stations/OLD_BASE');
    const body = JSON.parse(update.options.body);
    assert.equal(body.mountPoint, 'NEW_BASE');
    assert.equal(body.casterPort, 2201);
    assert.equal(body.latitude, 38.1);
    assert.equal(body.active, false, 'editing must not silently enable a disabled station');
    assert.equal(hidden, 1);
    elements.get('formAction').value = 'add';
    elements.get('stationActive').checked = true;
    await context.saveStation();
    const create = requests.find(req => req.options?.method === 'POST');
    assert.equal(create.url, '/api/stations');
    assert.equal(JSON.parse(create.options.body).active, true);
});
