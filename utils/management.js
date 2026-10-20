const fs = require('fs');
const { validateMembers } = require('./members');
const net = require('net');
const { OPERATIONS_PATH } = require('./paths');
const { sourceHealth } = require('./sources');

const policyDefaults = { autoSoftBan: false, failureThreshold: 20, windowSeconds: 300, softBanSeconds: 600,
    allowlistedIps: [], permanentBans: [], temporaryBans: [] };
function normalizeIp(value) {
    if (typeof value !== 'string' || !net.isIP(value)) throw new Error('Enter a valid IPv4 or IPv6 address');
    if (net.isIP(value) === 4) return value;
    const normalized = new URL('http://[' + value + ']/').hostname.slice(1, -1);
    const mapped = normalized.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
    if (mapped) {
        const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
        return [high >> 8, high & 255, low >> 8, low & 255].join('.');
    }
    return normalized;
}
function policy(config) {
    const raw = { ...policyDefaults, ...(config.security || {}) };
    return { ...raw, allowlistedIps: [...raw.allowlistedIps], permanentBans: [...raw.permanentBans], temporaryBans: [...raw.temporaryBans] };
}
function validateManagement(config) {
    const memberError = validateMembers(config); if (memberError) return memberError;
    if (config.users !== undefined && !Array.isArray(config.users)) return 'Users must be an array';
    const usernames = new Set();
    for (const u of config.users || []) {
        if (!u || typeof u.username !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(u.username) ||
            ['.', '..'].includes(u.username) || usernames.has(u.username)) return 'Usernames must be unique, 1–64 letters, digits, _, -, @ or .';
        if (typeof u.password !== 'string' || Buffer.byteLength(u.password) < 1 || Buffer.byteLength(u.password) > 256) return 'Each user needs a password of 1–256 bytes';
        if (u.active !== undefined && typeof u.active !== 'boolean') return 'User active status must be a boolean';
        usernames.add(u.username);
    }
    if (config.security !== undefined && (!config.security || typeof config.security !== 'object' || Array.isArray(config.security))) return 'Invalid IP policy';
    const s = { ...policyDefaults, ...(config.security || {}) };
    if (typeof s.autoSoftBan !== 'boolean' ||
        !Number.isInteger(s.failureThreshold) || s.failureThreshold < 10 || s.failureThreshold > 1000 ||
        !Number.isInteger(s.windowSeconds) || s.windowSeconds < 60 || s.windowSeconds > 3600 ||
        !Number.isInteger(s.softBanSeconds) || s.softBanSeconds < 60 || s.softBanSeconds > 86400) return 'Use a threshold of 10–1000, a 60–3600 second window and a 60–86400 second ban';
    if (![s.allowlistedIps, s.permanentBans, s.temporaryBans].every(Array.isArray) ||
        s.allowlistedIps.length + s.permanentBans.length + s.temporaryBans.length > 10000) return 'Invalid IP policy lists';
    try {
        s.allowlistedIps.forEach(normalizeIp);
        for (const ban of [...s.permanentBans, ...s.temporaryBans]) {
            normalizeIp(ban.ip);
            if (typeof ban.reason !== 'string' || ban.reason.length > 200) return 'Ban reasons must be at most 200 characters';
        }
        for (const ban of s.temporaryBans) if (!Number.isSafeInteger(ban.until) || ban.until < 0) return 'Invalid ban expiration';
    } catch (error) { return error.message; }
    return null;
}
function publicStations(config) {
    const direct = sourceHealth(config).filter(s => s.active).map(s => ({
        mountPoint: s.mountPoint, type: 'direct',
        latitude: s.position?.latitude ?? null, longitude: s.position?.longitude ?? null,
        ellipsoidalHeightM: s.position?.ellipsoidalHeightM ?? null,
        status: s.health.status === 'healthy' ? s.onboarding.status : s.health.status,
    }));
    return [...direct, ...(config.stations || []).filter(s => s.active !== false).map(s => ({
        mountPoint: s.mountPoint, type: 'upstream', latitude: s.latitude, longitude: s.longitude,
        ellipsoidalHeightM: null, status: 'configured',
    }))];
}
function operations(file = OPERATIONS_PATH, now = Date.now()) {
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Number.isFinite(value.updatedAt) || now - value.updatedAt < -1000 || now - value.updatedAt >= 5000) return null;
        return value;
    } catch { return null; }
}
function setupManagement(app, configManager, saveConfig, readOperations = operations) {
    const route = (method, url, handler) => app[method](url, (req, res) => {
        try { handler(req, res); } catch (error) { res.status(400).json({ error: error.message }); }
    });
    const save = config => { const error = validateManagement(config); if (error) throw new Error(error); saveConfig(config); };
    const safeUser = u => ({ username: u.username, active: u.active !== false, hasPassword: Boolean(u.password), owner: u.owner ?? null });
    route('get', '/api/users', (_req, res) => {
        const c = configManager.getConfig();
        res.json({ mode: c.users?.length || c.members?.length ? 'accounts' : (c.username || c.password ? 'shared' : 'anonymous'),
            legacyUsername: c.username || null, users: (c.users || []).map(safeUser) });
    });
    route('post', '/api/users', (req, res) => {
        const c = configManager.getConfig(), b = req.body || {};
        const u = { username: b.username, password: b.password, active: b.active ?? true };
        save({ ...c, users: [...(c.users || []), u] }); res.status(201).json(safeUser(u));
    });
    route('put', '/api/users/:username', (req, res) => {
        const c = configManager.getConfig(), b = req.body || {}, users = c.users || [];
        const index = users.findIndex(u => u.username === req.params.username);
        if (index < 0) return res.status(404).json({ error: 'User not found' });
        const u = { ...users[index], password: b.password === undefined || b.password === '' ? users[index].password : b.password,
            active: b.active === undefined ? users[index].active : b.active };
        save({ ...c, users: users.map((item,i) => i === index ? u : item) }); res.json(safeUser(u));
    });
    route('delete', '/api/users/:username', (req, res) => {
        const c = configManager.getConfig(), users = c.users || [];
        if (!users.some(u => u.username === req.params.username)) return res.status(404).json({ error: 'User not found' });
        if (users.length === 1 && !c.members?.length) return res.status(409).json({ error: 'Disable the last account instead. Deleting it would restore shared or anonymous access.' });
        save({ ...c, users: users.filter(u => u.username !== req.params.username) }); res.json({ deleted: true });
    });
    route('get', '/api/stats', (_req, res) => {
        const data = readOperations();
        if (!data?.stats) return res.status(503).json({ error: 'Live statistics are unavailable. Check the core process.' });
        res.json({ updatedAt: data.updatedAt, ...data.stats });
    });
    route('get', '/api/security', (_req, res) => {
        const data = readOperations();
        res.json({ settings: policy(configManager.getConfig()), updatedAt: data?.updatedAt ?? null, addresses: data?.security || [] });
    });
    route('put', '/api/security', (req, res) => {
        const c = configManager.getConfig(), s = policy(c), b = req.body || {};
        for (const field of ['autoSoftBan', 'failureThreshold', 'windowSeconds', 'softBanSeconds', 'allowlistedIps']) {
            if (b[field] !== undefined) s[field] = b[field];
        }
        const error = validateManagement({ ...c, security: s }); if (error) throw new Error(error);
        s.allowlistedIps = s.allowlistedIps.map(normalizeIp);
        save({ ...c, security: s }); res.json(s);
    });
    route('post', '/api/security/ban', (req, res) => {
        const c = configManager.getConfig(), b = req.body || {}, s = policy(c), ip = normalizeIp(b.ip);
        const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 200) : 'Administrator action';
        if (b.kind !== 'exempt') {
            s.permanentBans = s.permanentBans.filter(item => normalizeIp(item.ip) !== ip);
            s.temporaryBans = s.temporaryBans.filter(item => normalizeIp(item.ip) !== ip && item.until > Date.now());
        }
        if (b.kind === 'permanent') s.permanentBans.push({ ip, reason });
        else if (b.kind === 'temporary') s.temporaryBans.push({ ip, reason, until: Date.now() + s.softBanSeconds * 1000 });
        else if (b.kind === 'exempt') s.allowlistedIps = [...new Set([...s.allowlistedIps.map(normalizeIp), ip])];
        else if (b.kind !== 'unban') throw new Error('Invalid ban action');
        save({ ...c, security: s }); res.json({ ip, kind: b.kind });
    });
}
module.exports = { setupManagement, validateManagement, publicStations, operations, normalizeIp, policy };
