// Publisher configuration and credential-free live health for the admin API.
const fs = require('fs');
const path = require('path');

function validateSources(config) {
    if (config.sources !== undefined && !Array.isArray(config.sources)) return 'Sources must be an array';
    const virtualMount = config.mountPoint === undefined ? 'NEAR-Default' : config.mountPoint;
    const mounts = new Set([virtualMount, ...(config.stations || []).map(s => s.mountPoint)]);
    for (const s of config.sources || []) {
        if (!s || typeof s.mountPoint !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(s.mountPoint) || ['.', '..'].includes(s.mountPoint) || mounts.has(s.mountPoint)) {
            return 'Source mountpoints must be unique, cannot be . or .., and must use letters, digits, _, - or .';
        }
        mounts.add(s.mountPoint);
        if (typeof s.username !== 'string' || typeof s.password !== 'string' || !s.password) return 'Publisher username and a nonempty password are required';
        if (s.active !== undefined && typeof s.active !== 'boolean') return 'Active must be a boolean';
        const settling = s.settlingSeconds === undefined ? 60 : s.settlingSeconds;
        const tolerance = s.positionToleranceM === undefined ? 5 : s.positionToleranceM;
        if (!Number.isInteger(settling) || settling < 0 || settling > 86400) return 'Settling period must be an integer from 0 to 86400 seconds';
        if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 10000) return 'Position tolerance must be greater than 0 and at most 10000 meters';
        const lat = s.latitude, lon = s.longitude;
        if (lat == null && lon == null) continue;
        if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
            typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return 'Enter a valid latitude/longitude pair';
    }
    return null;
}

function publicSource(source) {
    const { password, ...safe } = source;
    return { ...safe, settlingSeconds: source.settlingSeconds ?? 60,
        positionToleranceM: source.positionToleranceM ?? 5,
        active: source.active !== false, hasPassword: Boolean(password) };
}

function sourcePosition(source, detected) {
    if (detected && Number.isFinite(detected.latitude) && Number.isFinite(detected.longitude) &&
        Math.abs(detected.latitude) <= 90 && Math.abs(detected.longitude) <= 180 &&
        Number.isFinite(detected.ellipsoidalHeightM) && [1005, 1006].includes(detected.messageType)) {
        return {
            latitude: detected.latitude, longitude: detected.longitude,
            ellipsoidalHeightM: detected.ellipsoidalHeightM,
            antennaHeightM: Number.isFinite(detected.antennaHeightM) ? detected.antennaHeightM : null,
            stationId: detected.stationId, messageType: detected.messageType, origin: 'rtcm',
        };
    }
    return Number.isFinite(source.latitude) && Number.isFinite(source.longitude) ? {
        latitude: source.latitude, longitude: source.longitude, ellipsoidalHeightM: null,
        antennaHeightM: null, stationId: null, messageType: null, origin: 'configured',
    } : null;
}

function onboardingStatus(source, snapshot) {
    const settings = { settlingSeconds: source.settlingSeconds ?? 60, positionToleranceM: source.positionToleranceM ?? 5 };
    if (source.active === false || !snapshot || !['detecting', 'settling', 'ready', 'needs_attention'].includes(snapshot.status) ||
        snapshot.settlingSeconds !== settings.settlingSeconds || snapshot.positionToleranceM !== settings.positionToleranceM) {
        return { ...settings, status: source.active === false ? 'needs_attention' : 'unknown',
            reason: source.active === false ? 'Publisher disabled' : 'Core onboarding status unavailable',
            elapsedSeconds: 0, remainingSeconds: settings.settlingSeconds };
    }
    return { ...settings, status: snapshot.status, reason: snapshot.reason ?? null,
        elapsedSeconds: snapshot.elapsedSeconds ?? 0, remainingSeconds: snapshot.remainingSeconds ?? settings.settlingSeconds };
}

function sourceHealth(config, file = path.join(__dirname, '..', 'logs', 'sources.json'), now = Date.now()) {
    let snapshot;
    try { snapshot = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const fresh = snapshot && Number.isFinite(snapshot.updatedAt) &&
        now - snapshot.updatedAt >= -1000 && now - snapshot.updatedAt < 5000 && Array.isArray(snapshot.sources);
    return (config.sources || []).map(source => {
        const health = fresh && snapshot.sources.find(s => s.mountPoint === source.mountPoint);
        // Pick fields explicitly; never let a snapshot or config expose credentials.
        return {
            ...publicSource(source),
            position: sourcePosition(source, health?.position),
            onboarding: onboardingStatus(source, health?.onboarding),
            health: {
                status: source.active === false ? 'disabled' : health ? health.status : 'unknown',
                connectedAt: health?.connectedAt ?? null,
                lastDataAt: health?.lastDataAt ?? null,
                bytesReceived: health?.bytesReceived ?? 0,
                subscribers: health?.subscribers ?? 0,
                lastError: health?.lastError ?? null,
                updatedAt: fresh ? snapshot.updatedAt : null,
            },
        };
    });
}

module.exports = { validateSources, publicSource, sourceHealth, sourcePosition, onboardingStatus };
