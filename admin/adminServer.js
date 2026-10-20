/**
 * Admin server for NearTRIP
 * Provides a web interface for managing stations and viewing connections
 */
const express = require('express');
const { setupMembers } = require('../utils/members');
const basicAuth = require('express-basic-auth');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const configManager = require('../utils/config');
const { validateSources, publicSource, sourceHealth } = require('../utils/sources');
const { setupManagement, validateManagement, publicStations } = require('../utils/management');

// Store all connections (active and historical) for the admin interface
const connections = new Map();

// How many days to keep connection history (7 days in milliseconds)
const CONNECTION_HISTORY_DAYS = 7;
const CONNECTION_HISTORY_MS = CONNECTION_HISTORY_DAYS * 24 * 60 * 60 * 1000;

// Directory for storing per-connection NMEA logs
const connectionLogsDir = path.join(__dirname, '..', 'logs', 'connections');

// Ensure connection logs directory exists
if (!fs.existsSync(connectionLogsDir)) {
    fs.mkdirSync(connectionLogsDir, { recursive: true });
}

/**
 * Initialize the admin server
 * 
 * @param {Object} options - Options for the admin server
 * @param {number} options.port - Port to listen on
 * @param {string} options.username - Username for basic auth
 * @param {string} options.password - Password for basic auth
 * @returns {express.Application} The Express app
 */
function initAdminServer(options = {}) {
    const { 
        port = 3000, 
        username = 'admin', 
        password = 'admin'
    } = options;

    const app = express();
    // Addresses/CIDRs only. Never trust arbitrary forwarded headers or hop counts.
    const trustedProxies = (process.env.NEARTRIP_TRUSTED_PROXIES || '').split(',').map(s => s.trim()).filter(Boolean);
    if (trustedProxies.length) {
        const net = require('net');
        const proxies = new net.BlockList();
        for (const entry of trustedProxies) {
            const [address, bits, extra] = entry.split('/');
            const version = net.isIP(address);
            if (!version || extra !== undefined || (bits !== undefined &&
                (!/^\d+$/.test(bits) || Number(bits) > (version === 4 ? 32 : 128)))) {
                throw new Error('NEARTRIP_TRUSTED_PROXIES must contain proxy IP addresses or CIDRs');
            }
            if (bits === undefined) proxies.addAddress(address, version === 4 ? 'ipv4' : 'ipv6');
            else proxies.addSubnet(address, Number(bits), version === 4 ? 'ipv4' : 'ipv6');
        }
        app.set('trust proxy', address => {
            // Canonicalize mapped IPv4 without enabling Express's subnet matcher.
            const ip = require('../utils/management').normalizeIp(address);
            return proxies.check(ip, net.isIP(ip) === 4 ? 'ipv4' : 'ipv6');
        });
    }
    const configWatcher = configManager.watchConfig?.();

    // Enable logging
    app.use(morgan('dev'));

    // Parse JSON bodies
    app.use(express.json());

    // Enable CORS
    app.use(cors());

    const memberAccess = setupMembers(app, configManager, saveConfig, { username, password, clientIpLimits: trustedProxies.length > 0 });
    app.get(['/', '/rovers', '/api/public/stations', '/index.html', '/rovers.html'], memberAccess.guard);
    app.get('/rovers', (_req, res) => res.sendFile(path.join(__dirname, '..', 'web/public/rovers.html')));
    // Station metadata is available only to authenticated members or admins.
    app.get('/api/public/stations', (_req, res) => {
        res.json(publicStations(configManager.getConfig()));
    });
    app.use(express.static(path.join(__dirname, '..', 'web', 'public')));
    // Basic authentication
    app.use(basicAuth({
        users: { [username]: password },
        challenge: true,
        realm: 'NearTRIP Admin'
    }));

    app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

    // Serve static files from the admin/public directory
    const publicPath = path.join(__dirname, 'public');
    if (!fs.existsSync(publicPath)) {
        fs.mkdirSync(publicPath, { recursive: true });
    }
    app.get('/admin', (_req, res) => res.sendFile(path.join(publicPath, 'index.html')));
    app.use(express.static(publicPath, { index: false }));

    memberAccess.setupAdmin();
    // API endpoints
    setupApiRoutes(app);    // Start server
    const server = app.listen(port, () => {
        logger.info(`Admin server started on http://localhost:${port}`);
    });
    
    // Schedule regular purging of old connections
    // Run every 6 hours (4 times per day)
    const purgeTimer = setInterval(purgeOldConnections, 6 * 60 * 60 * 1000);
    purgeTimer.unref();
    server.on('close', () => { clearInterval(purgeTimer); memberAccess.close?.(); configWatcher?.close(); });
    logger.info(`Connection history purge scheduled every 6 hours (keeping ${CONNECTION_HISTORY_DAYS} days of history)`);

    return { app, server };
}

/**
 * Set up API routes for admin interface
 * 
 * @param {express.Application} app - Express app
 */
function setupApiRoutes(app) {
    setupManagement(app, configManager, saveConfig);
    app.get('/api/sources', (req, res) => {
        res.json(sourceHealth(configManager.getConfig()));
    });
    app.post('/api/sources', (req, res) => {
        const config = configManager.getConfig();
        const source = {
            mountPoint: req.body.mountPoint, username: req.body.username,
            password: req.body.password, latitude: req.body.latitude ?? null,
            longitude: req.body.longitude ?? null, active: req.body.active ?? true,
            settlingSeconds: req.body.settlingSeconds === undefined ? 60 : req.body.settlingSeconds,
            positionToleranceM: req.body.positionToleranceM === undefined ? 5 : req.body.positionToleranceM,
        };
        const next = { ...config, sources: [...(config.sources || []), source] };
        const error = validateSources(next);
        if (error) return res.status(400).json({ error });
        try { saveConfig(next); res.status(201).json(publicSource(source)); }
        catch { res.status(500).json({ error: 'Failed to save publisher' }); }
    });
    app.put('/api/sources/:mountPoint', (req, res) => {
        const config = configManager.getConfig();
        const existing = (config.sources || []).find(s => s.mountPoint === req.params.mountPoint);
        if (!existing) return res.status(404).json({ error: 'Publisher not found' });
        const source = {
            mountPoint: existing.mountPoint,
            username: req.body.username ?? existing.username,
            password: req.body.password === '' || req.body.password === undefined ? existing.password : req.body.password,
            latitude: req.body.latitude === undefined ? existing.latitude : req.body.latitude,
            longitude: req.body.longitude === undefined ? existing.longitude : req.body.longitude,
            active: req.body.active === undefined ? existing.active : req.body.active,
            settlingSeconds: req.body.settlingSeconds === undefined ? (existing.settlingSeconds ?? 60) : req.body.settlingSeconds,
            positionToleranceM: req.body.positionToleranceM === undefined ? (existing.positionToleranceM ?? 5) : req.body.positionToleranceM,
        };
        const next = { ...config, sources: config.sources.map(s => s === existing ? source : s) };
        const error = validateSources(next);
        if (error) return res.status(400).json({ error });
        try { saveConfig(next); res.json(publicSource(source)); }
        catch { res.status(500).json({ error: 'Failed to save publisher' }); }
    });
    app.delete('/api/sources/:mountPoint', (req, res) => {
        const config = configManager.getConfig();
        if (!(config.sources || []).some(s => s.mountPoint === req.params.mountPoint)) {
            return res.status(404).json({ error: 'Publisher not found' });
        }
        try {
            saveConfig({ ...config, sources: config.sources.filter(s => s.mountPoint !== req.params.mountPoint) });
            res.json({ deleted: true });
        } catch { res.status(500).json({ error: 'Failed to delete publisher' }); }
    });

    // Get all stations
    app.get('/api/stations', (req, res) => {
        try {
            const config = configManager.getConfig();
            res.json(config.stations);
        } catch (error) {
            logger.error('Error fetching stations:', error);
            res.status(500).json({ error: 'Failed to fetch stations' });
        }
    });

    // Add a new station
    app.post('/api/stations', (req, res) => {
        try {
            const newStation = req.body;
            
            // Validate required fields
            if (!newStation.mountPoint || !newStation.casterHost || 
                !newStation.casterPort || !newStation.latitude || !newStation.longitude) {
                return res.status(400).json({ error: 'Missing required station fields' });
            }

            const config = configManager.getConfig();
            
            // Check for duplicate mountPoint
            const exists = config.stations.some(s => s.mountPoint === newStation.mountPoint);
            if (exists) {
                return res.status(400).json({ error: 'Station with this mount point already exists' });
            }

            // Set active to true by default if not specified
            if (newStation.active === undefined) {
                newStation.active = true;
            }

            if (validateSources({ ...config, stations: [...config.stations, newStation] })) {
                return res.status(400).json({ error: 'Mountpoint conflicts with a direct source' });
            }
            // Add the new station
            config.stations.push(newStation);
            
            // Save the updated config
            saveConfig(config);
            
            res.status(201).json(newStation);
        } catch (error) {
            logger.error('Error adding station:', error);
            res.status(500).json({ error: 'Failed to add station' });
        }
    });

    // Update a station
    app.put('/api/stations/:mountPoint', (req, res) => {
        try {
            const { mountPoint } = req.params;
            const updatedStation = req.body;
            
            const config = configManager.getConfig();
            
            // Find the station index
            const index = config.stations.findIndex(s => s.mountPoint === mountPoint);
            if (index === -1) {
                return res.status(404).json({ error: 'Station not found' });
            }

            if (validateSources({ ...config, stations: config.stations.map((s, i) => i === index ? updatedStation : s) })) {
                return res.status(400).json({ error: 'Mountpoint conflicts with a direct source' });
            }
            // Update the station
            config.stations[index] = updatedStation;
            
            // Save the updated config
            saveConfig(config);
            
            res.json(updatedStation);
        } catch (error) {
            logger.error('Error updating station:', error);
            res.status(500).json({ error: 'Failed to update station' });
        }
    });

    // Delete a station
    app.delete('/api/stations/:mountPoint', (req, res) => {
        try {
            const { mountPoint } = req.params;
            
            const config = configManager.getConfig();
            
            // Find the station index
            const index = config.stations.findIndex(s => s.mountPoint === mountPoint);
            if (index === -1) {
                return res.status(404).json({ error: 'Station not found' });
            }

            // Remove the station
            const removedStation = config.stations.splice(index, 1)[0];
            
            // Save the updated config
            saveConfig(config);
            
            res.json(removedStation);
        } catch (error) {
            logger.error('Error deleting station:', error);
            res.status(500).json({ error: 'Failed to delete station' });
        }
    });    // Get all connections (active and historical).
    // The Rust core writes logs/sessions.json. The in-memory map remains for
    // anything still tracked inside this process.
    app.get('/api/connections', (req, res) => {
        try {
            res.json(listConnections());
        } catch (error) {
            logger.error('Error fetching connections:', error);
            res.status(500).json({ error: 'Failed to fetch connections' });
        }
    });
    
    // Get NMEA log for a specific connection
    app.get('/api/connections/:id/nmea-log', (req, res) => {
        try {
            const { id } = req.params;
            if (!/^[a-f0-9]+$/i.test(id)) {
                return res.status(400).json({ error: 'Invalid connection id' });
            }

            const connection = findConnection(id);
            if (!connection) {
                return res.status(404).json({ error: 'Connection not found' });
            }

            const logPath = connectionLogPath(id, connection);
            if (!logPath || !fs.existsSync(logPath)) {
                return res.status(404).json({ error: 'NMEA log not found for this connection' });
            }
            
            // Set headers for file download
            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('Content-Disposition', `attachment; filename="connection-${id}.nmea.log"`);
            
            // Create read stream and pipe to response
            const fileStream = fs.createReadStream(logPath);
            fileStream.pipe(res);
        } catch (error) {
            logger.error('Error fetching NMEA log:', error);
            res.status(500).json({ error: 'Failed to fetch NMEA log' });
        }
    });
    
    // Get server info
    app.get('/api/info', (req, res) => {
        try {
            const config = configManager.getConfig();
            const { username, password, users, adminPassword, members, sources, ...safeConfig } = config;
            safeConfig.sources = (sources || []).map(publicSource);
            res.json({
                version: require('../package.json').version,
                config: safeConfig,
                uptime: Math.floor(process.uptime()),
                memoryUsage: process.memoryUsage(),
                nodeVersion: process.version
            });
        } catch (error) {
            logger.error('Error fetching server info:', error);
            res.status(500).json({ error: 'Failed to fetch server info' });
        }
    });

    // Get full configuration
    app.get('/api/config', (req, res) => {
        try {
            const config = configManager.getConfig();
            res.json(config);
        } catch (error) {
            logger.error('Error fetching configuration:', error);
            res.status(500).json({ error: 'Failed to fetch configuration' });
        }
    });

    // Update configuration
    app.put('/api/config', (req, res) => {
        try {
            const newConfig = req.body;
            
            // Validate required fields
            if (!newConfig.mountPoint || !newConfig.stations || !Array.isArray(newConfig.stations)) {
                return res.status(400).json({ error: 'Invalid configuration format' });
            }
            
            const managementError = validateManagement(newConfig);
            if (managementError) return res.status(400).json({ error: managementError });
            const sourceError = validateSources(newConfig);
            if (sourceError) return res.status(400).json({ error: sourceError });
            // Save the new config
            saveConfig(newConfig);
            
            // Get the updated config to return (without sensitive info)
            const config = configManager.getConfig();
            const { adminPassword, ...safeConfig } = config;
            
            res.json(safeConfig);
        } catch (error) {
            logger.error('Error updating configuration:', error);
            res.status(500).json({ error: 'Failed to update configuration' });
        }
    });

    // Reset configuration to defaults
    app.post('/api/config/reset', (req, res) => {
        try {
            // Reset config to default values
            configManager.resetToDefaultConfig();
            
            // Get the updated config to return (without sensitive info)
            const config = configManager.getConfig();
            const { adminPassword, ...safeConfig } = config;
            
            res.json(safeConfig);
        } catch (error) {
            logger.error('Error resetting configuration:', error);
            res.status(500).json({ error: 'Failed to reset configuration' });
        }
    });

    // Reload configuration from disk
    app.post('/api/reload', (req, res) => {
        try {
            // Reload config from disk
            const config = configManager.reloadConfig();
            
            // Return the reloaded config (without sensitive info)
            const { adminPassword, ...safeConfig } = config;
            
            res.json(safeConfig);
        } catch (error) {
            logger.error('Error reloading configuration:', error);
            res.status(500).json({ error: 'Failed to reload configuration' });
        }
    });
}

/**
 * Save the configuration to disk
 * 
 * @param {Object} config - The configuration to save
 */
function coreSessions() {
    const file = path.join(__dirname, '..', 'logs', 'sessions.json');
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function listConnections() {
    const fromCore = coreSessions();
    const list = fromCore || Array.from(connections.values());
    return list.sort((a, b) => {
        if (a.active && !b.active) return -1;
        if (!a.active && b.active) return 1;
        return new Date(b.connectedAt) - new Date(a.connectedAt);
    });
}

function findConnection(id) {
    const fromCore = coreSessions();
    if (fromCore) {
        const match = fromCore.find((session) => session.id === id);
        if (match) {
            return match;
        }
    }
    return connections.get(id);
}

function connectionLogPath(id, connection) {
    const root = path.resolve(__dirname, '..', 'logs', 'connections');
    const expected = path.join(root, `${id}.nmea.log`);
    if (!connection.nmeaLogFile) {
        return fs.existsSync(expected) ? expected : null;
    }
    const requested = path.resolve(__dirname, '..', connection.nmeaLogFile);
    if (requested !== expected) {
        return null;
    }
    return requested;
}

function saveConfig(config) {
    // Docker links config.json into its persistent configuration volume.
    const configPath = fs.realpathSync(configManager.CONFIG_FILE_PATH);
    const error = validateSources(config) || validateManagement(config);
    if (error) throw new Error(error);
    const mode = fs.statSync(configPath).mode & 0o777;
    // A private, unique directory also avoids following a leftover temp symlink.
    const tempDir = fs.mkdtempSync(path.join(path.dirname(configPath), '.neartrip-config-'));
    const temp = path.join(tempDir, 'config.json');
    try {
        fs.writeFileSync(temp, JSON.stringify(config, null, 4), { flag: 'wx', mode });
        fs.renameSync(temp, configPath);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
    configManager.reloadConfig();
    logger.info('Configuration saved successfully');
}

/**
 * Track a new client connection
 * 
 * @param {string} id - Unique ID for the connection
 * @param {Object} connectionInfo - Information about the connection
 */
function trackConnection(id, connectionInfo) {
    const connectionData = {
        id,
        connectedAt: new Date().toISOString(),
        active: true,
        ...connectionInfo,
        bytesSent: 0,
        bytesReceived: 0,
        nmeaLogFile: path.join(connectionLogsDir, `${id}.nmea.log`)
    };
    
    connections.set(id, connectionData);
    logger.debug(`Tracking connection: ${id}`);
    
    // Create empty log file for this connection
    fs.writeFileSync(connectionData.nmeaLogFile, '');
}

/**
 * Update an existing connection
 * 
 * @param {string} id - Unique ID for the connection
 * @param {Object} updates - Updated information about the connection
 */
function updateConnection(id, updates) {
    if (connections.has(id)) {
        const connection = connections.get(id);
        connections.set(id, { ...connection, ...updates });
    }
}

/**
 * Mark a connection as disconnected but keep it in history
 * 
 * @param {string} id - Unique ID for the connection
 */
function removeConnection(id) {
    if (connections.has(id)) {
        const connection = connections.get(id);
        connections.set(id, { 
            ...connection, 
            active: false,
            disconnectedAt: new Date().toISOString()
        });
        logger.debug(`Connection ${id} marked as disconnected`);
    }
}

/**
 * Log NMEA data for a specific connection
 * 
 * @param {string} id - Unique ID for the connection
 * @param {string} nmeaData - NMEA sentence to log
 */
function logConnectionNMEA(id, nmeaData) {
    if (connections.has(id)) {
        const connection = connections.get(id);
        if (connection.nmeaLogFile) {
            fs.appendFileSync(connection.nmeaLogFile, nmeaData + '\n');
        }
    }
}

/**
 * Purge old connections and their logs based on CONNECTION_HISTORY_DAYS
 */
function purgeOldConnections() {
    const cutoffDate = new Date(Date.now() - CONNECTION_HISTORY_MS);
    
    let purgedCount = 0;
    connections.forEach((connection, id) => {
        if (connection.active) return;
        // Retain live sessions regardless of their age.
        const dateToCompare = connection.disconnectedAt 
            ? new Date(connection.disconnectedAt) 
            : new Date(connection.connectedAt);
            
        if (dateToCompare < cutoffDate) {
            // Remove from memory
            connections.delete(id);
            
            // Delete log file if it exists
            if (connection.nmeaLogFile && fs.existsSync(connection.nmeaLogFile)) {
                fs.unlinkSync(connection.nmeaLogFile);
            }
            
            purgedCount++;
        }
    });
    
    if (purgedCount > 0) {
        logger.info(`Purged ${purgedCount} old connections and their logs`);
    }
}

module.exports = {
    initAdminServer,
    trackConnection,
    updateConnection,
    removeConnection,
    logConnectionNMEA
};
