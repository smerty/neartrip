/* Direct publisher controls. Health refresh never replaces an open form. */
(() => {
    let sources = [];
    let editing = null;
    let loading = false;
    const el = id => document.getElementById(id);
    const message = (text, error = false) => {
        el('sourceMessage').textContent = text;
        el('sourceMessage').className = error ? 'text-danger' : 'text-success';
    };
    async function api(url, options) {
        const response = await fetch(url, options);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed');
        return data;
    }
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const endpoint = mount => '/api/sources/' + encodeURIComponent(mount);
    function button(cell, label, action) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm btn-outline-secondary me-1';
        btn.textContent = label;
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try { await action(); } catch (error) { message(error.message, true); }
            finally { btn.disabled = false; }
        });
        cell.appendChild(btn);
    }
    function edit(source) {
        editing = source?.mountPoint ?? null;
        el('sourceForm').reset();
        el('sourceFormTitle').textContent = source ? 'Edit Publisher' : 'Add Publisher';
        el('sourceMount').value = source?.mountPoint ?? '';
        el('sourceMount').readOnly = Boolean(source);
        el('sourceUsername').value = source?.username ?? '';
        el('sourcePassword').value = '';
        el('sourcePassword').required = !source;
        el('sourceLatitude').value = source?.latitude ?? '';
        el('sourceLongitude').value = source?.longitude ?? '';
        el('sourceActive').checked = source?.active !== false;
        el('sourceSettling').value = source?.settlingSeconds ?? 60;
        el('sourceTolerance').value = source?.positionToleranceM ?? 5;
        el('sourceForm').hidden = false;
        el(source ? 'sourceUsername' : 'sourceMount').focus();
    }
    async function load() {
        if (loading) return;
        loading = true;
        try {
            sources = await api('/api/sources');
            const body = el('sourcesTable').querySelector('tbody');
            body.replaceChildren();
            for (const source of sources) {
                const row = document.createElement('tr');
                const h = source.health;
                const position = source.position;
                const location = !position ? 'Waiting for RTCM 1005/1006' :
                    position.latitude.toFixed(6) + ', ' + position.longitude.toFixed(6) +
                    (position.ellipsoidalHeightM == null ? '' : '\n' + position.ellipsoidalHeightM.toFixed(2) + ' m ellipsoidal') +
                    (position.antennaHeightM == null ? '' : '\nAntenna height: ' + position.antennaHeightM.toFixed(4) + ' m') +
                    (position.origin === 'rtcm' ? '\nRTCM ' + position.messageType : '\nManual fallback');
                const age = h.lastDataAt == null ? '—' : Math.max(0, Math.floor((Date.now() - h.lastDataAt) / 1000)) + 's ago';
                const values = [source.mountPoint, location, h.status, '', age, h.bytesReceived.toLocaleString() + ' B', h.subscribers];
                for (const value of values) {
                    const cell = document.createElement('td');
                    cell.textContent = value;
                    row.appendChild(cell);
                }
                row.children[1].style.whiteSpace = 'pre-line';
                row.children[1].style.minWidth = '180px';
                row.children[4].className = 'text-nowrap';
                row.children[5].className = 'text-nowrap';
                const statusCell = row.children[2];
                statusCell.textContent = '';
                const badge = document.createElement('span');
                const colors = { healthy: 'success', stale: 'warning', waiting: 'info', offline: 'danger', disabled: 'secondary', unknown: 'secondary' };
                badge.className = 'badge text-bg-' + (colors[h.status] || 'secondary');
                badge.textContent = h.status;
                statusCell.appendChild(badge);
                if (h.lastError || h.status === 'unknown') {
                    const detail = document.createElement('small');
                    detail.className = 'd-block text-muted';
                    detail.textContent = h.lastError || 'Core health unavailable';
                    statusCell.appendChild(detail);
                }
                const admission = source.onboarding || { status: 'unknown', reason: 'Core onboarding status unavailable' };
                const admissionCell = row.children[3];
                admissionCell.style.minWidth = '180px';
                admissionCell.style.maxWidth = '220px';
                const admissionBadge = document.createElement('span');
                admissionBadge.className = 'badge text-bg-' + ({ ready: 'success', settling: 'info', detecting: 'secondary', needs_attention: 'warning' }[admission.status] || 'secondary');
                admissionBadge.textContent = { ready: 'Ready', settling: 'Settling', detecting: 'Detecting', needs_attention: 'Needs attention', unknown: 'Unknown' }[admission.status] || 'Unknown';
                admissionCell.appendChild(admissionBadge);
                const progress = document.createElement('small');
                progress.className = 'd-block text-muted';
                progress.textContent = admission.status === 'settling' ? admission.remainingSeconds + 's remaining of ' + admission.settlingSeconds + 's' :
                    admission.status === 'ready' ? 'Eligible for nearest selection' : admission.reason || '';
                admissionCell.appendChild(progress);
                const actions = document.createElement('td');
                actions.className = 'text-nowrap';
                button(actions, 'Edit', () => edit(source));
                button(actions, source.active ? 'Disable' : 'Enable', async () => {
                    await api(endpoint(source.mountPoint), json('PUT', { active: !source.active }));
                    message('Publisher updated. The core reloads changes within a second.');
                    await load();
                });
                button(actions, 'Delete', async () => {
                    if (!confirm('Delete publisher ' + source.mountPoint + '? Its upload will be disconnected.')) return;
                    await api(endpoint(source.mountPoint), { method: 'DELETE' });
                    if (editing === source.mountPoint) el('sourceForm').hidden = true;
                    message('Publisher deleted.');
                    await load();
                });
                row.appendChild(actions);
                body.appendChild(row);
            }
            if (!sources.length) {
                const cell = document.createElement('td');
                cell.colSpan = 8;
                cell.textContent = 'No direct publishers configured.';
                const row = document.createElement('tr');
                row.appendChild(cell);
                body.appendChild(row);
            }
        } catch (error) { message('Could not refresh publisher health: ' + error.message, true); }
        finally { loading = false; }
    }
    document.addEventListener('DOMContentLoaded', () => {
        el('addSourceBtn').addEventListener('click', () => edit(null));
        el('cancelSourceBtn').addEventListener('click', () => { el('sourceForm').hidden = true; });
        el('sourceForm').addEventListener('submit', async event => {
            event.preventDefault();
            if (!el('sourceForm').reportValidity()) return;
            const latitude = el('sourceLatitude').value;
            const longitude = el('sourceLongitude').value;
            if ((latitude === '') !== (longitude === '')) { message('Enter both coordinates or leave both blank.', true); return; }
            const data = {
                mountPoint: el('sourceMount').value.trim(), username: el('sourceUsername').value,
                password: el('sourcePassword').value,
                latitude: latitude === '' ? null : Number(latitude),
                longitude: longitude === '' ? null : Number(longitude),
                active: el('sourceActive').checked,
                settlingSeconds: Number(el('sourceSettling').value),
                positionToleranceM: Number(el('sourceTolerance').value),
            };
            el('saveSourceBtn').disabled = true;
            try {
                await api(editing ? endpoint(editing) : '/api/sources', json(editing ? 'PUT' : 'POST', data));
                el('sourceForm').hidden = true;
                el('sourcePassword').value = '';
                message('Publisher saved. The core reloads changes within a second.');
                await load();
            } catch (error) { message(error.message, true); }
            finally { el('saveSourceBtn').disabled = false; }
        });
        load();
        setInterval(load, 5000);
    });
})();
