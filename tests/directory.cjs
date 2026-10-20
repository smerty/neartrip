const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('selected station details follow position updates without repeating map focus', async () => {
    class Element {
        constructor() { this.children = []; this.events = {}; this.attributes = {}; this.style = { setProperty() {} }; this.value = ''; }
        append(...children) { this.children.push(...children); }
        appendChild(child) { this.append(child); }
        replaceChildren() { this.children = []; }
        addEventListener(name, callback) { this.events[name] = callback; }
        setAttribute(name, value) { this.attributes[name] = value; }
        remove() {}
    }
    const elements = new Map(), get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
    let ready, poll, atlas, focusCount = 0;
    let station = { type: 'direct', mountPoint: 'BASE', status: 'waiting', latitude: null, longitude: null, ellipsoidalHeightM: null };
    class NetworkMap {
        constructor() { atlas = this; }
        static key(s) { return s.type + ':' + s.mountPoint; }
        static valid(s) { return Number.isFinite(s.latitude) && Number.isFinite(s.longitude); }
        static color() { return 'green'; }
        setStations() {}
        focusStation() { focusCount++; }
    }
    const context = vm.createContext({ NetworkMap, Date,
        document: { getElementById: get, createElement: () => new Element(), querySelectorAll: () => [], addEventListener(name, callback) { if (name === 'DOMContentLoaded') ready = callback; } },
        fetch: async () => ({ ok: true, status: 200, json: async () => [{ ...station }] }),
        setInterval(callback) { poll = callback; },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/public/directory.js'), 'utf8'), context);
    ready(); await new Promise(setImmediate);
    atlas.onSelect(station);
    assert.match(get('stationDetail').children[1].textContent, /not been reported/);
    station = { ...station, status: 'ready', latitude: 37, longitude: -122, ellipsoidalHeightM: 12.5 };
    await poll();
    assert.equal(get('stationDetail').children[1].textContent, '37.000000, -122.000000');
    assert.equal(get('stationDetail').children[2].textContent, '12.50 m above the ellipsoid');
    station = { ...station, latitude: 38, ellipsoidalHeightM: null };
    await poll();
    assert.equal(get('stationDetail').children[1].textContent, '38.000000, -122.000000');
    assert.equal(get('stationDetail').children.length, 2);
    assert.equal(focusCount, 1);
});
