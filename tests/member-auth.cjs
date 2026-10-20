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
    let lists = 0, failNext = false, allowDelete = false, deleted = false;
    const list = { port: 2101, mountPoint: 'NEAR', users: [{ username: 'rover-one', active: true }] };
    const context = vm.createContext({
        document: { getElementById: id => elements.get(id), querySelectorAll: () => buttons, createElement: make },
        location: { hostname: 'localhost', assign() {} },
        window: { confirm: () => allowDelete },
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (url.endsWith('/me')) return response({ csrf: 'token' });
            if (options.method === 'DELETE') { deleted = true; return response({ deleted: true }); }
            if (deleted) return response({ ...list, users: [] });
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
    const remove = buttons.filter(button => button.textContent === 'Delete').at(-1);
    await remove.onclick();
    assert.equal(requests.filter(req => req.options.method === 'DELETE').length, 0, 'cancel leaves credentials intact');
    allowDelete = true;
    await remove.onclick();
    const removal = requests.find(req => req.options.method === 'DELETE');
    assert.equal(removal.url, '/api/member/rovers/rover-one');
    assert.equal(removal.options.headers['X-CSRF-Token'], 'token');
    assert.equal(elements.get('rovers').children.length, 0, 'deleted row is removed');
    assert.equal(elements.get('newCredentials').hidden, true, 'deleted credentials are no longer displayed');
    assert.equal(elements.get('newCredentials').textContent, '');
});

function loginPage({ token = '', failure } = {}) {
    const email = { value: 'invited@example.com' }, button = {}, message = {};
    const form = { hidden: false, addEventListener(_event, handler) { this.submit = handler; } };
    const requests = [], redirects = [], historyChanges = [];
    const elements = { loginForm: form, email, message };
    const context = vm.createContext({
        document: { getElementById: id => elements[id], querySelectorAll: () => [button] },
        location: { hash: token ? '#' + token : '', assign(url) { redirects.push(url); } },
        history: { replaceState(...args) { historyChanges.push(args); } },
        fetch: async (url, options) => {
            requests.push({ url, body: JSON.parse(options.body) });
            if (failure && url.endsWith('/verify')) return { ok: false, status: 401, json: async () => ({ error: failure }) };
            return response({ message: 'Check your email' });
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/public/member-auth.js'), 'utf8'), context);
    return { email, button, form, message, requests, redirects, historyChanges };
}
test('emailed magic link signs in automatically and removes its token from the address bar', async () => {
    const page = loginPage({ token: 'a'.repeat(64) });
    assert.equal(page.form.hidden, true);
    assert.equal(page.historyChanges[0][2], '/login');
    assert.equal(page.requests[0].url, '/api/member/verify');
    assert.equal(page.requests[0].body.token, 'a'.repeat(64));
    await new Promise(setImmediate);
    assert.deepEqual(page.redirects, ['/']);
    assert.equal(page.requests.length, 1, 'no second click or email request');
});
test('expired magic link shows a useful error and allows requesting a replacement', async () => {
    const page = loginPage({ token: 'b'.repeat(64), failure: 'Invalid or expired sign-in link' });
    await new Promise(setImmediate);
    assert.equal(page.form.hidden, false);
    assert.match(page.message.textContent, /Invalid or expired.*Request a new sign-in link/);
    assert.deepEqual(page.redirects, []);
    page.form.submit({ preventDefault() {} });
    await new Promise(setImmediate);
    assert.equal(page.requests[1].url, '/api/member/login');
    assert.equal(page.requests[1].body.email, 'invited@example.com');
    assert.equal(page.message.textContent, 'Check your email');
});
test('ordinary login asks for a link without revealing administration navigation', async () => {
    const page = loginPage();
    assert.equal(page.requests.length, 0);
    page.form.submit({ preventDefault() {} });
    await new Promise(setImmediate);
    assert.equal(page.requests[0].url, '/api/member/login');
    const html = fs.readFileSync(path.join(__dirname, '../web/public/login.html'), 'utf8');
    assert.doesNotMatch(html, /href=["']\/admin/);
});
