(() => {
    const el = id => document.getElementById(id);
    let editing = null;
    const message = error => { el('memberMessage').textContent = error; };
    async function api(url, method = 'GET', body) {
        const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Request failed'); return data;
    }
    function reset() { editing = null; el('memberForm').reset(); el('memberName').disabled = false; el('memberPassword').required = true; el('memberTitle').textContent = 'Create member'; }
    async function load() {
        const members = await api('/api/members'), root = el('memberList'); root.replaceChildren();
        for (const m of members) {
            const row = document.createElement('p'), name = document.createElement('span'); name.textContent = m.username + ' · ' + (m.active ? 'Enabled ' : 'Disabled '); row.append(name);
            const edit = document.createElement('button'); edit.className = 'btn btn-sm btn-outline-primary'; edit.textContent = 'Edit';
            edit.onclick = () => { editing = m.username; el('memberName').value = m.username; el('memberName').disabled = true; el('memberPassword').value = ''; el('memberPassword').required = false; el('memberActive').checked = m.active; el('memberTitle').textContent = 'Edit member'; el('memberActive').focus(); }; row.append(edit); root.append(row);
        }
        if (!members.length) root.textContent = 'No member accounts yet. Create the first account below.';
    }
    el('memberCancel').onclick = reset;
    el('memberForm').onsubmit = async e => {
        e.preventDefault(); const button = e.submitter; button.disabled = true;
        try { await api('/api/members' + (editing ? '/' + encodeURIComponent(editing) : ''), editing ? 'PUT' : 'POST', { username: el('memberName').value, password: el('memberPassword').value, active: el('memberActive').checked }); reset(); await load(); message('Member saved.'); }
        catch (error) { message(error.message); } finally { button.disabled = false; }
    };
    const refresh = () => { if (location.hash === '#users') load().catch(e => message(e.message)); };
    window.addEventListener('hashchange', refresh); reset(); refresh();
})();
