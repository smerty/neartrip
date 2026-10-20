/* Shared station atlas. Public callers never provide rover sessions. */
window.NetworkMap = class NetworkMap {
    constructor(container, { admin = false } = {}) {
        this.admin = admin; this.markers = new Map(); this.clients = new Map(); this.fitted = false;
        this.map = L.map(container, { zoomControl: false, preferCanvas: true }).setView([37.8, -98.5], 4);
        const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19,
        }).addTo(this.map);
        this.map.getContainer().classList.add('street-map');
        this.ranges = L.layerGroup(); this.links = L.layerGroup().addTo(this.map);
        L.control.zoom({ position: 'bottomright' }).addTo(this.map);
        L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(this.map);
        L.control.layers({ 'Street map': street },
            { '20 km distance guides': this.ranges, ...(admin ? { 'Client links': this.links } : {}) }, { position: 'topright' }).addTo(this.map);
        this.map.on('baselayerchange', event => {
            this.map.getContainer().classList.toggle('street-map', event.name === 'Street map');
        });
    }
    static valid(s) {
        return Number.isFinite(s.latitude) && Number.isFinite(s.longitude) &&
            Math.abs(s.latitude) <= 90 && Math.abs(s.longitude) <= 180;
    }
    static key(s) { return (s.type || 'direct') + ':' + s.mountPoint; }
    static color(status) {
        return { ready: '#59e3ad', healthy: '#59e3ad', settling: '#f4b35f', detecting: '#f4b35f',
            waiting: '#f4b35f', needs_attention: '#f28579', offline: '#8592a6', unknown: '#8592a6',
            stale: '#f28579', configured: '#8baaff' }[status] || '#8592a6';
    }
    popup(s) {
        const root = document.createElement('div');
        const title = document.createElement('strong'); title.textContent = s.mountPoint; root.appendChild(title);
        for (const text of [
            (s.type === 'upstream' ? 'Upstream relay' : 'Direct base') + ' · ' + s.status.replaceAll('_', ' '),
            s.latitude.toFixed(6) + ', ' + s.longitude.toFixed(6),
            s.ellipsoidalHeightM == null ? '' : s.ellipsoidalHeightM.toFixed(2) + ' m ellipsoidal',
        ].filter(Boolean)) {
            const line = document.createElement('div'); line.textContent = text; root.appendChild(line);
        }
        return root;
    }
    setStations(stations) {
        this.stations = stations;
        const valid = stations.filter(NetworkMap.valid), keys = new Set(valid.map(NetworkMap.key));
        for (const [key, entry] of this.markers) {
            if (!keys.has(key)) { entry.marker.remove(); this.markers.delete(key); }
        }
        this.ranges.clearLayers();
        for (const s of valid) {
            const key = NetworkMap.key(s), color = NetworkMap.color(s.status);
            let entry = this.markers.get(key);
            if (!entry) {
                const marker = L.marker([s.latitude, s.longitude], { title: s.mountPoint, keyboard: true }).addTo(this.map);
                entry = { marker }; this.markers.set(key, entry);
                marker.on('click', () => this.onSelect?.(entry.station));
            }
            entry.station = s; entry.marker.setLatLng([s.latitude, s.longitude]);
            if (entry.color !== color) {
                entry.marker.setIcon(L.divIcon({
                    className: 'network-pin', iconSize: [34, 34], iconAnchor: [17, 17],
                    html: '<span style="--pin-color:' + color + '"><i></i></span>',
                }));
                entry.color = color;
            }
            if (entry.marker.getPopup()) entry.marker.setPopupContent(this.popup(s));
            else entry.marker.bindPopup(this.popup(s));
            L.circle([s.latitude, s.longitude], { radius: 20000, color, weight: 1, opacity: .35,
                dashArray: '5 7', fillColor: color, fillOpacity: .025, interactive: false }).addTo(this.ranges);
        }
        if (!this.fitted && valid.length) { this.fit(); this.fitted = true; }
    }
    setClients(sessions) {
        if (!this.admin) return;
        const active = sessions.filter(s => s.active && s.authenticated && NetworkMap.valid(s));
        const ids = new Set(active.map(s => s.id));
        for (const [id, marker] of this.clients) if (!ids.has(id)) { marker.remove(); this.clients.delete(id); }
        this.links.clearLayers();
        for (const s of active) {
            let marker = this.clients.get(s.id);
            if (!marker) {
                marker = L.marker([s.latitude, s.longitude], {
                    title: s.username || s.clientIp, icon: L.divIcon({ className: 'network-client', html: '<span></span>', iconSize: [18,18] }),
                }).addTo(this.map);
                this.clients.set(s.id, marker);
            }
            marker.setLatLng([s.latitude, s.longitude]);
            const popup = document.createElement('div');
            popup.textContent = (s.username || s.clientIp) + ' · ' + (s.currentStation || 'Waiting for station');
            if (marker.getPopup()) marker.setPopupContent(popup); else marker.bindPopup(popup);
            const base = (this.stations || []).find(b => b.mountPoint === s.currentStation && NetworkMap.valid(b));
            if (base) L.polyline([[base.latitude, base.longitude], [s.latitude, s.longitude]], {
                color: '#87baff', weight: 1.5, opacity: .55, dashArray: '4 7', interactive: false,
            }).addTo(this.links);
        }
    }
    focusStation(s) {
        if (!NetworkMap.valid(s)) return;
        this.map.flyTo([s.latitude, s.longitude], Math.max(this.map.getZoom(), 12), { duration: .6 });
        this.markers.get(NetworkMap.key(s))?.marker.openPopup();
    }
    fit() {
        const positions = (this.stations || []).filter(NetworkMap.valid).map(s => [s.latitude, s.longitude]);
        if (positions.length) this.map.fitBounds(L.latLngBounds(positions), { padding: [55,55], maxZoom: 12 });
    }
};
