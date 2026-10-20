const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = data => ({ ok: true, json: async () => data });

test('member actions stay serialized through password rotation and list refresh', async () => {
    const buttons = [], elements = new Map();
    const make = tag => {
        const node = { style: {}, children: [], disabled: false, append(...nodes) { this.children.push(...nodes); }, replaceChildren() { this.children = []; }, focus() {} };
        if (tag === 'button') buttons.push(node);
        return node;
    };
    for (const id of ['message', 'newCredentials', 'rovers', 'connectionInfo', 'createRover', 'logout']) elements.set(id, make(['createRover', 'logout'].includes(id) ? 'button' : 'div'));
    const rotation = deferred(), refresh = deferred();
    const requests = [];
    let lists = 0, failNext = false;
    const list = { port: 2101, mountPoint: 'NEAR', users: [{ username: 'rover-one', active: true }] };
    const context = vm.createContext({
        document: { getElementById: id => elements.get(id), querySelectorAll: () => buttons, createElement: make },
        location: { hostname: 'localhost', assign() {} },
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (url.endsWith('/me')) return response({ csrf: 'token' });
            if (options.method === 'PUT') {
                if (failNext) return { ok: false, status: 500, json: async () => ({ error: 'Rotation failed' }) };
                return rotation.promise;
            }
            if (++lists === 1) return response(list);
            return refresh.promise;
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/public/member-auth.js'), 'utf8'), context);
    await new Promise(setImmediate);
    const rotate = buttons.find(button => button.textContent === 'Rotate password');
    const first = rotate.onclick();
    assert.equal(rotate.disabled, true);
    await rotate.onclick();
    await elements.get('createRover').onclick();
    assert.equal(requests.filter(req => req.options.method !== 'GET').length, 1);
    rotation.resolve(response({ username: 'rover-one', password: 'current-password' }));
    await new Promise(setImmediate);
    assert.equal(elements.get('createRover').disabled, true, 'refresh is still pending');
    await rotate.onclick();
    assert.equal(requests.filter(req => req.options.method === 'PUT').length, 1);
    refresh.resolve(response(list));
    await first;
    assert.match(elements.get('newCredentials').textContent, /current-password/);
    assert.ok(buttons.every(button => !button.disabled));
    assert.equal(elements.get('message').textContent, '');
    failNext = true;
    await buttons.filter(button => button.textContent === 'Rotate password').at(-1).onclick();
    assert.equal(elements.get('message').textContent, 'Rotation failed');
    assert.ok(buttons.every(button => !button.disabled), 'failed requests release the action lock');
});
