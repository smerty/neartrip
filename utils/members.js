const crypto = require('crypto');
const path = require('path');
const { createMailer } = require('./member-mail');
const { LoginLimiter } = require('./login-limiter');
const nameOK = s => typeof s === 'string' && /^[A-Za-z0-9_.@-]{1,64}$/.test(s) && !['.', '..'].includes(s);
const emailOf = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const emailOK = value => /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value) && value.length <= 254;
const versionOf = m => JSON.stringify([m.passwordHash, m.email]);
function validateMembers(c) {
    if (c.members !== undefined && !Array.isArray(c.members)) return 'Invalid members';
    const seen = new Set(), emails = new Set();
    for (const m of c.members || []) {
        if (!m || !nameOK(m.username) || seen.has(m.username) || (m.passwordHash !== undefined && !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(m.passwordHash)) || typeof m.active !== 'boolean') return 'Invalid or duplicate member';
        if (m.email !== undefined && (!emailOK(m.email) || m.email !== emailOf(m.email) || emails.has(m.email))) return 'Invalid or duplicate member email';
        if (!m.email && !m.passwordHash) return 'Member requires an email';
        if (m.email) emails.add(m.email);
        seen.add(m.username);
    }
    for (const u of c.users || []) if (u.owner !== undefined && !seen.has(u.owner)) return 'Rover owner must reference a member';
    return null;
}
function setupMembers(app, manager, save, admin) {
    const sessions = new Map(), limiter = new LoginLimiter(), links = new Map(), mailer = admin.mailer || createMailer();
    const invalidate = config => {
        for (const [token, link] of links) if (!(config.members || []).some(m => m.username === link.username && m.active && versionOf(m) === link.version)) links.delete(token);
        for (const [token, session] of sessions) {
            if (!(config.members || []).some(m => m.username === session.username && m.active && versionOf(m) === session.version)) sessions.delete(token);
        }
    };
    const unsubscribe = manager.subscribeConfig?.(invalidate);
    const root = path.join(__dirname, '..', 'web', 'public');
    const safe = m => ({ username: m.username, email: m.email || '', active: m.active });
    const current = req => {
        const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('neartrip_session='))?.slice(17);
        const session = sessions.get(token);
        if (!session || session.until < Date.now()) { sessions.delete(token); return null; }
        let member;
        try { member = (manager.getConfig().members || []).find(m => m.username === session.username && m.active && versionOf(m) === session.version); }
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
    const digest = token => crypto.createHash('sha256').update(token).digest('hex');
    app.post('/api/member/login', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const email = emailOf(req.body?.email), now = Date.now();
        let m;
        try { m = (manager.getConfig().members || []).find(m => m.email === email && m.active); }
        catch { return res.status(400).json({ error: 'Unable to read member configuration' }); }
        const attempt = limiter.begin(req.ip, email, { limitIp: admin.clientIpLimits === true, knownAccount: Boolean(m) });
        if (!attempt.finish) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
        try {
            for (const [key, value] of links) if (value.until <= now) links.delete(key);
            if (m && mailer && links.size < 10000 && ![...links.values()].some(v => v.username === m.username && v.sent > now - 60000)) {
                const token = crypto.randomBytes(32).toString('hex'), key = digest(token);
                links.set(key, { username: m.username, version: versionOf(m), until: now + 900000, sent: now });
                try { await mailer.send(email, token); }
                catch { links.delete(key); console.error('Member sign-in email delivery failed'); }
            }
            res.json({ message: 'If this email is invited, a sign-in link will arrive shortly.' });
        } finally { attempt.finish(false); }
    });
    app.post('/api/member/verify', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const raw = req.body?.token;
        if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) return res.status(401).json({ error: 'Invalid or expired sign-in link' });
        const key = digest(raw), link = links.get(key);
        links.delete(key);
        const m = link && link.until > Date.now() && (manager.getConfig().members || []).find(m => m.username === link.username && m.active && versionOf(m) === link.version);
        if (!m) return res.status(401).json({ error: 'Invalid or expired sign-in link' });
        for (const [key, value] of sessions) if (value.until <= Date.now()) sessions.delete(key);
        if (sessions.size >= 10000) return res.status(503).json({ error: 'Try again later' });
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { username: m.username, version: versionOf(m), csrf: crypto.randomBytes(32).toString('hex'), until: Date.now() + 8 * 3600000 });
        res.setHeader('Set-Cookie', 'neartrip_session=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800' + (req.secure || process.env.NEARTRIP_SECURE_COOKIES === 'true' ? '; Secure' : ''));
        res.json(safe(m));
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
        let username;
        do { username = 'rover-' + crypto.randomBytes(4).toString('hex'); }
        while ((c.users || []).some(u => u.username === username));
        const password = crypto.randomBytes(9).toString('base64url');
        try { save({ ...c, users: [...(c.users || []), { username, password, owner, active: true }] }); res.status(201).json({ username, password }); }
        catch { res.status(400).json({ error: 'Unable to create rover credentials' }); }
    });
    app.put('/api/member/rovers/:username', (req, res) => {
        const c = manager.getConfig(), owner = req.memberSession.member.username;
        const user = (c.users || []).find(u => u.username === req.params.username && u.owner === owner);
        if (!user) return res.status(404).json({ error: 'Rover not found' });
        const password = crypto.randomBytes(9).toString('base64url');
        const updated = { ...user, ...(req.body?.rotate === true ? { password } : {}), ...(typeof req.body?.active === 'boolean' ? { active: req.body.active } : {}) };
        try { save({ ...c, users: c.users.map(u => u === user ? updated : u) }); res.json({ username: updated.username, active: updated.active, ...(req.body?.rotate === true ? { password } : {}) }); }
        catch { res.status(400).json({ error: 'Unable to update rover' }); }
    });
    app.delete('/api/member/rovers/:username', (req, res) => {
        const c = manager.getConfig(), owner = req.memberSession.member.username;
        const user = (c.users || []).find(u => u.username === req.params.username && u.owner === owner);
        if (!user) return res.status(404).json({ error: 'Rover not found' });
        try {
            save({ ...c, users: c.users.filter(u => u !== user) });
            res.json({ deleted: true });
        } catch { res.status(400).json({ error: 'Unable to delete rover credentials' }); }
    });
    return { guard, close() { unsubscribe?.(); }, setupAdmin() {
        app.get('/api/members', (_req, res) => res.json((manager.getConfig().members || []).map(safe)));
        const pending = new Set();
        const change = async (req, res, create) => {
            const username = create ? req.body?.username : req.params.username;
            if (!nameOK(username) || pending.has(username)) return res.status(400).json({ error: 'Invalid username or update in progress' });
            pending.add(username);
            try {
                const c = manager.getConfig(), members = c.members || [], existing = members.find(m => m.username === username);
                const email = req.body?.email === undefined ? existing?.email : emailOf(req.body.email);
                if (!emailOK(email)) throw new Error('Enter a valid invited email address');
                if (create ? existing : !existing) return res.status(409).json({ error: create ? 'Member already exists' : 'Member not found' });
                if (req.body?.active !== undefined && typeof req.body.active !== 'boolean') throw new Error('Invalid active status');
                const member = { ...(existing || {}), username, active: req.body?.active ?? existing?.active ?? true, email };
                if (members.some(m => m.username !== username && m.email === email)) throw new Error('Email already invited');
                save({ ...c, members: create ? [...members, member] : members.map(m => m === existing ? member : m) });
                for (const [key, value] of sessions) if (value.username === username) sessions.delete(key);
                for (const [key, value] of links) if (value.username === username) links.delete(key);
                res.status(create ? 201 : 200).json(safe(member));
            } catch (error) { res.status(400).json({ error: error.message }); }
            finally { pending.delete(username); }
        };
        app.post('/api/members', (req, res) => change(req, res, true));
        app.put('/api/members/:username', (req, res) => change(req, res, false));
    } };
}
module.exports = { setupMembers, validateMembers };
