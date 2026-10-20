(() => {
    let csrf, busy = false;
    const message = document.getElementById('message');
    async function api(path, method = 'GET', body) {
        const res = await fetch('/api/member/' + path, { method, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await res.json();
        if (!res.ok) { if (res.status === 401 && !['login', 'verify'].includes(path)) location.assign('/login'); throw new Error(data.error || 'Request failed'); }
        return data;
    }
    async function run(fn) {
        if (busy) return;
        busy = true;
        document.querySelectorAll('button').forEach(button => { button.disabled = true; });
        try { message.textContent = ''; await fn(); }
        catch (e) { message.textContent = e.message; }
        finally {
            busy = false;
            document.querySelectorAll('button').forEach(button => { button.disabled = false; });
        }
    }
    const login = document.getElementById('loginForm');
    if (login) {
        const token = location.hash.slice(1);
        if (token) {
            history.replaceState(null, '', '/login');
            const button = login.querySelector('button');
            login.querySelector('#email').required = false;
            button.textContent = 'Confirm sign in';
            login.addEventListener('submit', e => { e.preventDefault(); run(async () => { await api('verify', 'POST', { token }); location.assign('/'); }); });
        } else login.addEventListener('submit', e => { e.preventDefault(); run(async () => { const result = await api('login', 'POST', { email: document.getElementById('email').value }); document.getElementById('message').textContent = result.message; }); });
        return;
    }
    const secret = data => { const el = document.getElementById('newCredentials'); el.hidden = false; el.textContent = 'Username: ' + data.username + '\nPassword: ' + data.password + '\nCopy now — this password will not be displayed again.'; el.focus(); };
    async function load() {
        const data = await api('rovers'), root = document.getElementById('rovers'); root.replaceChildren();
        document.getElementById('connectionInfo').textContent = 'Caster: ' + location.hostname + ' · Port: ' + data.port + ' · Nearest mountpoint: ' + data.mountPoint;
        for (const rover of data.users) {
            const row = document.createElement('div'); row.style.cssText = 'padding:24px 0;border-bottom:1px solid #394353';
            const title = document.createElement('p'); title.textContent = rover.username + ' · ' + (rover.active ? 'Enabled' : 'Disabled'); row.append(title);
            for (const [label, body] of [['Rotate password', { rotate: true }], [rover.active ? 'Disable' : 'Enable', { active: !rover.active }]]) {
                const button = document.createElement('button'); button.className = 'map-tool'; button.textContent = label; button.disabled = busy;
                button.onclick = () => run(async () => { const result = await api('rovers/' + encodeURIComponent(rover.username), 'PUT', body); if (result.password) secret(result); await load(); }); row.append(button);
            }
            root.append(row);
        }
    }
    run(async () => { csrf = (await api('me')).csrf; await load(); });
    document.getElementById('createRover').onclick = () => run(async () => { secret(await api('rovers', 'POST', {})); await load(); });
    document.getElementById('logout').onclick = () => run(async () => { await api('logout', 'POST', {}); location.assign('/login'); });
})();
