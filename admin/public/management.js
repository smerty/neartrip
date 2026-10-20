(() => {
    const el = id => document.getElementById(id);
    let editingUser = null, users = [], securityLoaded = false, securityData = null;
    const pending = new Set();
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    async function api(url, options) {
        const response = await fetch(url, options);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed');
        return data;
    }
    function message(id, text, error = false) {
        el(id).textContent = text; el(id).className = error ? 'text-danger' : 'text-success';
    }
    function cell(row, text) { const td = document.createElement('td'); td.textContent = text; row.appendChild(td); return td; }
    function button(parent, label, action, key) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-sm btn-outline-secondary me-1';
        b.textContent = label; if (key) b.dataset.focusKey = key;
        b.addEventListener('click', async () => {
            b.disabled = true;
            try { await action(); } catch (error) { message(location.hash === '#users' ? 'userMessage' : 'securityMessage', error.message, true); }
            finally { b.disabled = false; }
        }); parent.appendChild(b);
    }
    const bytes = n => {
        if (n < 1024) return n + ' B'; const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
        return (n / 1024 ** i).toFixed(1) + ' ' + ['B','KB','MB','GB','TB'][i];
    };
    const date = n => n ? new Date(n).toLocaleString() : '—';
    const duration = n => Math.floor(n / 3600) + 'h ' + Math.floor(n % 3600 / 60) + 'm';
    function empty(body, count, text) { if (!body.children.length) { const row = document.createElement('tr'); const td = cell(row, text); td.colSpan = count; body.appendChild(row); } }
    function editUser(user) {
        editingUser = user?.username ?? null;
        el('userForm').reset(); el('userName').value = editingUser || ''; el('userName').readOnly = Boolean(user);
        el('userPassword').value = ''; el('userPassword').required = !user; el('userActive').checked = user?.active !== false;
        el('userFormTitle').textContent = user ? 'Edit rover user' : 'Add rover user';
        el('userForm').hidden = false; el(user ? 'userPassword' : 'userName').focus();
    }
    async function loadUsers() {
        const data = await api('/api/users'); users = data.users;
        el('userMode').textContent = data.mode === 'accounts' ? 'Individual rover accounts are active.' :
            data.mode === 'shared' ? 'Shared rover credentials are active. Adding the first user replaces that shared login.' :
            'Anonymous rover access is active. Adding the first user will require an individual login for new connections.';
        const body = el('usersTable').querySelector('tbody'), focus = document.activeElement?.dataset?.focusKey;
        body.replaceChildren();
        for (const u of users) {
            const row = document.createElement('tr'); cell(row, u.username + (u.owner ? ' · owner: ' + u.owner : ' · standalone'));  cell(row, u.active ? 'Enabled' : 'Disabled');
            const actions = cell(row, '');
            button(actions, 'Edit', () => editUser(u), u.username + ':edit');
            button(actions, u.active ? 'Disable' : 'Enable', async () => {
                await api('/api/users/' + encodeURIComponent(u.username), json('PUT', { active: !u.active })); await loadUsers();
            }, u.username + ':toggle');
            button(actions, 'Delete', async () => {
                if (!confirm('Delete rover user ' + u.username + '?')) return;
                await api('/api/users/' + encodeURIComponent(u.username), { method: 'DELETE' }); await loadUsers();
            }, u.username + ':delete');
            body.appendChild(row);
        }
        empty(body, 3, 'No individual rover users configured.');
        if (focus && body.parentElement.contains(document.activeElement) === false) restore(body, focus, el('addUserBtn'));
    }
    function restore(body, key, fallback) {
        const target = [...body.querySelectorAll('button')].find(b => b.dataset.focusKey === key);
        (target || fallback).focus({ preventScroll: true });
    }
    async function loadStats() {
        const data = await api('/api/stats');
        el('statsSince').textContent = 'In-memory counters since ' + date(data.startedAt) + '. Updated ' + date(data.updatedAt) + '.';
        const sum = (rows, field) => rows.reduce((n, row) => n + row[field], 0);
        const cards = [[sum(data.bases, 'active'), 'Connected direct bases'], [sum(data.clients, 'active'), 'Active rover sessions'],
            [bytes(sum(data.bases, 'bytesReceived')), 'Direct corrections received'], [bytes(sum(data.clients, 'bytesSent')), 'Corrections delivered']];
        el('statsCards').replaceChildren();
        for (const [value, label] of cards) {
            const card = document.createElement('div'); card.className = 'console-metric';
            const strong = document.createElement('strong'), small = document.createElement('span');
            strong.textContent = value; small.textContent = label; card.append(strong, small); el('statsCards').appendChild(card);
        }
        for (const [id, rows, publisher] of [['baseStats', data.bases, true], ['clientStats', data.clients, false]]) {
            const body = el(id).querySelector('tbody'); body.replaceChildren();
            for (const c of rows) {
                const row = document.createElement('tr');
                const values = [c.key, c.sessions, c.active, bytes(publisher ? c.bytesReceived : c.bytesSent)];
                if (!publisher) values.push(bytes(c.bytesReceived));
                values.push(duration(c.connectedSeconds), date(c.lastSeen)); values.forEach(v => cell(row, v)); body.appendChild(row);
            }
            empty(body, publisher ? 6 : 7, 'No activity observed since core startup.');
        }
        message('statsMessage', '');
    }
    function renderSecurity() {
        if (!securityData) return;
        const body = el('ipTable').querySelector('tbody'), focus = document.activeElement?.dataset?.focusKey;
        body.replaceChildren();
        const rows = securityData.addresses.filter(a => el('showAllIps').checked || a.ban || a.authenticationFailures >= 3 || a.malformedRequests >= 10 || a.blockedConnections);
        for (const a of rows) {
            const row = document.createElement('tr');
            const ban = a.ban ? a.ban + (a.until ? ' until ' + date(a.until) : '') : a.activeAuthenticated ? 'Authenticated client active' : 'Observe only';
            [a.ip, a.connections, a.authenticationFailures, a.malformedRequests, a.blockedConnections,
                a.successfulConnections + ' / ' + a.activeAuthenticated, ban, date(a.lastSeen)].forEach(v => cell(row, v));
            const actions = cell(row, '');
            button(actions, 'Review', () => {
                el('banIp').value = a.ip; el('banReason').value = ''; el('banIp').focus();
            }, a.ip + ':review');
            if (a.ban === 'permanent' || a.ban === 'temporary') button(actions, 'Remove manual ban', async () => {
                await api('/api/security/ban', json('POST', { ip: a.ip, kind: 'unban' })); await loadSecurity();
            }, a.ip + ':unban');
            body.appendChild(row);
        }
        empty(body, 9, 'No suspicious or banned IPs. Successful clients are hidden by default.');
        if (focus) restore(body, focus, el('banIp'));
        el('securityFreshness').textContent = securityData.updatedAt ? 'Listener observations updated ' + date(securityData.updatedAt) : 'Live IP activity unavailable; saved policy can still be managed.';
    }
    async function loadSecurity() {
        securityData = await api('/api/security');
        if (!securityLoaded) {
            const s = securityData.settings;
            el('autoSoftBan').checked = s.autoSoftBan;
            for (const name of ['failureThreshold','windowSeconds','softBanSeconds']) el(name).value = s[name];
            el('allowlistedIps').value = s.allowlistedIps.join('\n'); securityLoaded = true;
        }
        renderSecurity();
    }
    async function page() {
        const name = location.hash.slice(1);
        const loaders = { users: loadUsers, statistics: loadStats, security: loadSecurity };
        if (!loaders[name] || pending.has(name)) return;
        pending.add(name);
        try { await loaders[name](); } catch (error) { message(({ users: 'userMessage', statistics: 'statsMessage', security: 'securityMessage' })[name], error.message, true); }
        finally { pending.delete(name); }
    }
    document.addEventListener('DOMContentLoaded', () => {
        el('addUserBtn').addEventListener('click', () => editUser(null));
        el('cancelUserBtn').addEventListener('click', () => { el('userForm').hidden = true; });
        el('userForm').addEventListener('submit', async event => {
            event.preventDefault(); if (!el('userForm').reportValidity()) return;
            try {
                await api(editingUser ? '/api/users/' + encodeURIComponent(editingUser) : '/api/users',
                    json(editingUser ? 'PUT' : 'POST', { username: el('userName').value.trim(), password: el('userPassword').value, active: el('userActive').checked }));
                el('userPassword').value = ''; el('userForm').hidden = true; message('userMessage', 'Rover user saved. New logins use the updated credentials.'); await loadUsers();
            } catch (error) { message('userMessage', error.message, true); }
        });
        el('policyForm').addEventListener('submit', async event => {
            event.preventDefault(); if (!el('policyForm').reportValidity()) return;
            const s = { autoSoftBan: el('autoSoftBan').checked, allowlistedIps: el('allowlistedIps').value.split(/[\s,]+/).filter(Boolean) };
            for (const name of ['failureThreshold','windowSeconds','softBanSeconds']) s[name] = Number(el(name).value);
            try { await api('/api/security', json('PUT', s)); message('securityMessage', 'IP policy saved; the listener reloads it within a second.'); await loadSecurity(); }
            catch (error) { message('securityMessage', error.message, true); }
        });
        el('banForm').addEventListener('submit', async event => {
            event.preventDefault(); if (!el('banForm').reportValidity()) return;
            const ip = el('banIp').value.trim(), kind = el('banKind').value;
            if (kind === 'permanent' && !confirm('Permanently block NTRIP connections from ' + ip + '? Shared clients behind this IP will also be affected.')) return;
            try {
                await api('/api/security/ban', json('POST', { ip, kind, reason: el('banReason').value }));
                if (kind === 'exempt') el('allowlistedIps').value = [...new Set([...el('allowlistedIps').value.split(/[\s,]+/).filter(Boolean), ip])].join('\n');
                message('securityMessage', 'IP action saved; the listener reloads it within a second.'); await loadSecurity();
            } catch (error) { message('securityMessage', error.message, true); }
        });
        el('showAllIps').addEventListener('change', renderSecurity);
        window.addEventListener('hashchange', page); page();
        setInterval(() => { if (['#statistics','#security'].includes(location.hash)) page(); }, 5000);
    });
})();
