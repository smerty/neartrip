const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const nameOK = s => typeof s === 'string' && /^[A-Za-z0-9_.@-]{1,64}$/.test(s) && !['.', '..'].includes(s);
async function hashPassword(password) {
    if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 256) throw new Error('Use a password of 12–256 bytes');
    const salt = crypto.randomBytes(16).toString('hex');
    return salt + ':' + (await scrypt(password, salt, 64)).toString('hex');
}
async function verify(password, hash) {
    const [salt, digest] = (hash || '').split(':');
    if (!salt || !digest || typeof password !== 'string' || Buffer.byteLength(password) > 256) return false;
    const actual = await scrypt(password, salt, 64), expected = Buffer.from(digest, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function validateMembers(c) {
    if (c.members !== undefined && !Array.isArray(c.members)) return 'Invalid members';
    const seen = new Set();
    for (const m of c.members || []) {
        if (!m || !nameOK(m.username) || seen.has(m.username) || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(m.passwordHash) || typeof m.active !== 'boolean') return 'Invalid or duplicate member';
        seen.add(m.username);
    }
    for (const u of c.users || []) if (u.owner !== undefined && !seen.has(u.owner)) return 'Rover owner must reference a member';
    return null;
}
function setupMembers(app, manager, save, admin) {
    const sessions = new Map(), attempts = new Map();
    const invalidate = config => {
        for (const [token, session] of sessions) {
            if (!(config.members || []).some(m => m.username === session.username && m.active && m.passwordHash === session.version)) sessions.delete(token);
        }
    };
    const unsubscribe = manager.subscribeConfig?.(invalidate);
    const root = path.join(__dirname, '..', 'web', 'public');
    const safe = m => ({ username: m.username, active: m.active });
    const current = req => {
        const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('neartrip_session='))?.slice(17);
        const session = sessions.get(token);
        if (!session || session.until < Date.now()) { sessions.delete(token); return null; }
        let member;
        try { member = (manager.getConfig().members || []).find(m => m.username === session.username && m.active && m.passwordHash === session.version); }
        catch { sessions.delete(token); return null; }
        if (!member) { sessions.delete(token); return null; }
        return { member, token, csrf: session.csrf };
    };
    const adminMap = req => {
        if (!req.headers.authorization?.startsWith('Basic ')) return false;
        const expected = Buffer.from(admin.username + ':' + admin.password);
        const supplied = Buffer.from(req.headers.authorization.slice(6), 'base64');
        return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    };
    const guard = (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        const session = current(req);
        if (!session && !adminMap(req)) return req.originalUrl.startsWith('/api/') ? res.status(401).json({ error: 'Sign in required' }) : res.redirect('/login');
        req.memberSession = session;
        next();
    };
    const memberGuard = (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        const session = current(req);
        if (!session) return res.status(401).json({ error: 'Sign in required' });
        if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== session.csrf) return res.status(403).json({ error: 'Refresh the page and retry' });
        req.memberSession = session; next();
    };
    app.get('/login', (_req, res) => res.sendFile(path.join(root, 'login.html')));
    app.get('/member-auth.js', (_req, res) => res.sendFile(path.join(root, 'member-auth.js')));
    app.use('/api/member', (req, res, next) => {
        if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
            try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request rejected' }); }
            catch { return res.status(403).json({ error: 'Invalid origin' }); }
        }
        next();
    });
    app.post('/api/member/login', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        // Fixed-window limiter keyed by TCP peer, bounded against address churn.
        const ip = req.socket.remoteAddress, now = Date.now();
        for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
        if (!attempts.has(ip) && attempts.size >= 10000) return res.status(429).json({ error: 'Try again later' });
        const attempt = attempts.get(ip) || { count: 0, until: now + 300000 };
        attempts.set(ip, attempt);
        if (++attempt.count > 20) return res.status(429).json({ error: 'Too many login attempts. Try again in five minutes.' });
        try {
            const m = (manager.getConfig().members || []).find(m => m.username === req.body?.username && m.active);
            // Also run the KDF for unknown accounts.
            const valid = await verify(req.body?.password, m?.passwordHash || '00000000000000000000000000000000:' + '0'.repeat(128));
            if (!m || !valid) return res.status(401).json({ error: 'Invalid login' });
            const latest = (manager.getConfig().members || []).find(x => x.username === m.username && x.active && x.passwordHash === m.passwordHash);
            if (!latest) return res.status(401).json({ error: 'Invalid login' });
            for (const [key, value] of sessions) if (value.until < now) sessions.delete(key);
            if (sessions.size >= 10000) return res.status(503).json({ error: 'Try again later' });
            const token = crypto.randomBytes(32).toString('hex');
            sessions.set(token, { username: m.username, version: m.passwordHash, csrf: crypto.randomBytes(32).toString('hex'), until: now + 8 * 3600000 });
            res.setHeader('Set-Cookie', 'neartrip_session=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800' + (req.secure || process.env.NEARTRIP_SECURE_COOKIES === 'true' ? '; Secure' : ''));
            res.json(safe(m));
        } catch { res.status(400).json({ error: 'Invalid login' }); }
    });
    app.use('/api/member', memberGuard);
    app.get('/api/member/me', (req, res) => res.json({ ...safe(req.memberSession.member), csrf: req.memberSession.csrf }));
    app.post('/api/member/logout', (req, res) => {
        sessions.delete(req.memberSession.token); res.setHeader('Set-Cookie', 'neartrip_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); res.json({ loggedOut: true });
    });
    app.get('/api/member/rovers', (req, res) => {
        const c = manager.getConfig();
        res.json({ mountPoint: c.mountPoint || 'NEAR-Default', port: c.port || 2101,
            users: (c.users || []).filter(u => u.owner === req.memberSession.member.username).map(u => ({ username: u.username, active: u.active !== false })) });
    });
    app.post('/api/member/rovers', (req, res) => {
        const c = manager.getConfig(), owner = req.memberSession.member.username;
        if ((c.users || []).filter(u => u.owner === owner).length >= 10) return res.status(400).json({ error: 'Maximum ten rover credentials per member' });
        const username = 'rover-' + crypto.randomBytes(12).toString('hex'), password = crypto.randomBytes(24).toString('base64url');
        try { save({ ...c, users: [...(c.users || []), { username, password, owner, active: true }] }); res.status(201).json({ username, password }); }
        catch { res.status(400).json({ error: 'Unable to create rover credentials' }); }
    });
    app.put('/api/member/rovers/:username', (req, res) => {
        const c = manager.getConfig(), owner = req.memberSession.member.username;
        const user = (c.users || []).find(u => u.username === req.params.username && u.owner === owner);
        if (!user) return res.status(404).json({ error: 'Rover not found' });
        const password = crypto.randomBytes(24).toString('base64url');
        const updated = { ...user, ...(req.body?.rotate === true ? { password } : {}), ...(typeof req.body?.active === 'boolean' ? { active: req.body.active } : {}) };
        try { save({ ...c, users: c.users.map(u => u === user ? updated : u) }); res.json({ username: updated.username, active: updated.active, ...(req.body?.rotate === true ? { password } : {}) }); }
        catch { res.status(400).json({ error: 'Unable to update rover' }); }
    });
    return { guard, close() { unsubscribe?.(); }, setupAdmin() {
        app.get('/api/members', (_req, res) => res.json((manager.getConfig().members || []).map(safe)));
        const pending = new Set();
        const change = async (req, res, create) => {
            const username = create ? req.body?.username : req.params.username;
            if (!nameOK(username) || pending.has(username)) return res.status(400).json({ error: 'Invalid username or update in progress' });
            pending.add(username);
            try {
                const passwordHash = create || req.body?.password ? await hashPassword(req.body?.password) : null;
                const c = manager.getConfig(), members = c.members || [], existing = members.find(m => m.username === username);
                if (create ? existing : !existing) return res.status(409).json({ error: create ? 'Member already exists' : 'Member not found' });
                if (req.body?.active !== undefined && typeof req.body.active !== 'boolean') throw new Error('Invalid active status');
                const member = { ...(existing || {}), username, active: req.body?.active ?? existing?.active ?? true, ...(passwordHash ? { passwordHash } : {}) };
                save({ ...c, members: create ? [...members, member] : members.map(m => m === existing ? member : m) });
                for (const [key, value] of sessions) if (value.username === username) sessions.delete(key);
                res.status(create ? 201 : 200).json(safe(member));
            } catch (error) { res.status(400).json({ error: error.message }); }
            finally { pending.delete(username); }
        };
        app.post('/api/members', (req, res) => change(req, res, true));
        app.put('/api/members/:username', (req, res) => change(req, res, false));
    } };
}
module.exports = { setupMembers, validateMembers, hashPassword };
