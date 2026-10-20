(() => {
    const el = id => document.getElementById(id);
    let stations = [], filter = 'all', selected = null, map, loading = false;
    const rows = new Map();
    const ready = s => s.status === 'ready';
    const onboarding = s => ['settling', 'detecting', 'waiting', 'needs_attention'].includes(s.status);
    function select(station) {
        selected = NetworkMap.key(station);
        map?.focusStation(station);
        renderDetail(station);
        for (const [key, row] of rows) row.button.setAttribute('aria-pressed', String(key === selected));
    }
    function renderDetail(station) {
        const detail = el('stationDetail'); detail.replaceChildren(); detail.hidden = false;
        const title = document.createElement('strong'); title.textContent = station.mountPoint; detail.appendChild(title);
        const text = document.createElement('div');
        text.textContent = NetworkMap.valid(station) ? station.latitude.toFixed(6) + ', ' + station.longitude.toFixed(6) : 'Position has not been reported yet.';
        detail.appendChild(text);
        if (station.ellipsoidalHeightM != null) {
            const height = document.createElement('div'); height.textContent = station.ellipsoidalHeightM.toFixed(2) + ' m above the ellipsoid'; detail.appendChild(height);
        }
    }
    function render() {
        const query = el('stationSearch').value.toLowerCase().trim();
        const visible = stations.filter(s => s.mountPoint.toLowerCase().includes(query) &&
            (filter === 'all' || (filter === 'ready' ? ready(s) : filter === 'onboarding' ? onboarding(s) : ['offline', 'stale', 'unknown'].includes(s.status))));
        const keys = new Set(stations.map(NetworkMap.key));
        for (const [key, row] of rows) {
            if (!keys.has(key)) {
                if (document.activeElement === row.button) el('stationSearch').focus();
                row.button.remove(); rows.delete(key);
                if (key === selected) { selected = null; el('stationDetail').hidden = true; }
            }
        }
        const visibleKeys = new Set(visible.map(NetworkMap.key));
        for (const s of stations) {
            const key = NetworkMap.key(s);
            let row = rows.get(key);
            if (!row) {
                const button = document.createElement('button'); button.className = 'station-card'; button.type = 'button';
                const type = document.createElement('span'); type.className = 'station-type';
                const title = document.createElement('strong'), badge = document.createElement('span'), position = document.createElement('small');
                badge.className = 'station-badge'; button.append(type, title, badge, position);
                row = { button, type, title, badge, position }; rows.set(key, row);
                button.addEventListener('click', () => select(row.station)); el('stationList').appendChild(button);
            }
            row.station = s; row.button.hidden = !visibleKeys.has(key); row.button.setAttribute('aria-pressed', String(key === selected));
            row.type.textContent = s.type; row.title.textContent = s.mountPoint;
            row.badge.textContent = s.status.replaceAll('_', ' '); row.badge.style.setProperty('--status-color', NetworkMap.color(s.status));
            row.position.textContent = NetworkMap.valid(s) ? s.latitude.toFixed(4) + '° / ' + s.longitude.toFixed(4) + '°' : 'Waiting for position';
        }
        el('emptyDirectory')?.remove();
        if (!visible.length) { const empty = document.createElement('p'); empty.id = 'emptyDirectory'; empty.className = 'empty-stations';
            empty.textContent = stations.length ? 'No stations match your filters.' : 'The network is waiting for its first base station.';
            el('stationList').appendChild(empty); }
        el('resultCount').textContent = visible.length + ' shown';
        el('totalBases').textContent = stations.length;
        el('readyBases').textContent = stations.filter(ready).length;
        el('settlingBases').textContent = stations.filter(onboarding).length;
        map?.setStations(visible);
        const station = stations.find(s => NetworkMap.key(s) === selected);
        if (station) renderDetail(station);
    }
    async function load() {
        if (loading) return; loading = true;
        try {
            const response = await fetch('/api/public/stations');
            if (response.status === 401) { location.assign('/login'); return; }
            if (!response.ok) throw new Error('Station directory is unavailable');
            stations = await response.json(); render();
            el('directoryError').hidden = true;
            el('lastRefresh').textContent = 'Updated ' + new Date().toLocaleTimeString();
        } catch (error) {
            el('directoryError').textContent = error.message; el('directoryError').hidden = false;
            el('lastRefresh').textContent = 'Network update unavailable';
        } finally { loading = false; }
    }
    document.addEventListener('DOMContentLoaded', () => {
        try { map = new NetworkMap('networkMap'); map.onSelect = select; } catch {
            el('networkMap').textContent = 'Map tiles are unavailable. The station directory is still accessible.';
        }
        el('stationSearch').addEventListener('input', render);
        document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
            filter = button.dataset.filter;
            document.querySelectorAll('[data-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
            render();
        }));
        el('fitNetwork').addEventListener('click', () => map?.fit());
        el('fullMap').addEventListener('click', async () => {
            try {
                if (document.fullscreenElement) await document.exitFullscreen();
                else await el('networkMap').parentElement.requestFullscreen();
            } catch { el('lastRefresh').textContent = 'Fullscreen is unavailable in this browser'; }
        });
        document.addEventListener('fullscreenchange', () => map?.map.invalidateSize());
        load(); setInterval(load, 5000);
    });
})();
