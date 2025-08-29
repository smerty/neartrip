/**
 * Admin server for NearTRIP
 * Provides a web interface for managing stations and viewing connections
 */
const express = require('express');
const basicAuth = require('express-basic-auth');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const configManager = require('../utils/config');

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

    // Enable logging
    app.use(morgan('dev'));

    // Parse JSON bodies
    app.use(express.json());

    // Enable CORS
    app.use(cors());

    // Basic authentication
    app.use(basicAuth({
        users: { [username]: password },
        challenge: true,
        realm: 'NearTRIP Admin'
    }));

    // Serve static files from the admin/public directory
    const publicPath = path.join(__dirname, 'public');
    if (!fs.existsSync(publicPath)) {
        fs.mkdirSync(publicPath, { recursive: true });
    }
    app.use(express.static(publicPath));

    // API endpoints
    setupApiRoutes(app);    // Start server
    const server = app.listen(port, () => {
        logger.info(`Admin server started on http://localhost:${port}`);
    });
    
    // Schedule regular purging of old connections
    // Run every 6 hours (4 times per day)
    setInterval(purgeOldConnections, 6 * 60 * 60 * 1000);
    logger.info(`Connection history purge scheduled every 6 hours (keeping ${CONNECTION_HISTORY_DAYS} days of history)`);

    return { app, server };
}

/**
 * Set up API routes for admin interface
 * 
 * @param {express.Application} app - Express app
 */
function setupApiRoutes(app) {
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
            
            // Enhanced validation
            const errors = [];
            
            if (!newStation.mountPoint || typeof newStation.mountPoint !== 'string') {
                errors.push('Mount point is required and must be a string');
            } else if (!/^[A-Z0-9_-]+$/i.test(newStation.mountPoint.trim())) {
                errors.push('Mount point can only contain letters, numbers, hyphens, and underscores');
            }
            
            if (!newStation.casterHost || typeof newStation.casterHost !== 'string') {
                errors.push('Caster host is required and must be a string');
            } else if (!/^[a-zA-Z0-9.-]+$/.test(newStation.casterHost.trim())) {
                errors.push('Caster host must be a valid hostname or IP address');
            }
            
            if (!newStation.casterPort || typeof newStation.casterPort !== 'number' || 
                newStation.casterPort < 1 || newStation.casterPort > 65535) {
                errors.push('Caster port must be a valid port number (1-65535)');
            }
            
            if (typeof newStation.latitude !== 'number' || isNaN(newStation.latitude) || 
                newStation.latitude < -90 || newStation.latitude > 90) {
                errors.push('Latitude must be a valid number between -90 and 90');
            }
            
            if (typeof newStation.longitude !== 'number' || isNaN(newStation.longitude) || 
                newStation.longitude < -180 || newStation.longitude > 180) {
                errors.push('Longitude must be a valid number between -180 and 180');
            }
            
            if (errors.length > 0) {
                return res.status(400).json({ error: errors.join('; ') });
            }

            const config = configManager.getConfig();
            
            // Check for duplicate mountPoint
            const exists = config.stations.some(s => s.mountPoint === newStation.mountPoint.trim());
            if (exists) {
                return res.status(400).json({ error: 'Station with this mount point already exists' });
            }

            // Clean and set defaults
            newStation.mountPoint = newStation.mountPoint.trim();
            newStation.casterHost = newStation.casterHost.trim();
            newStation.username = newStation.username ? newStation.username.trim() : '';
            newStation.password = newStation.password || '';
            
            // Set active to true by default if not specified
            if (newStation.active === undefined) {
                newStation.active = true;
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
    });    // Get all connections (active and historical)
    app.get('/api/connections', (req, res) => {
        try {
            // Convert to array and sort - active connections first, then by connected time (newest first)
            const connectionsList = Array.from(connections.values())
                .sort((a, b) => {
                    // First sort by active status
                    if (a.active && !b.active) return -1;
                    if (!a.active && b.active) return 1;
                    
                    // Then by connected time (descending - newest first)
                    return new Date(b.connectedAt) - new Date(a.connectedAt);
                });
                
            res.json(connectionsList);
        } catch (error) {
            logger.error('Error fetching connections:', error);
            res.status(500).json({ error: 'Failed to fetch connections' });
        }
    });
    
    // Get NMEA log for a specific connection
    app.get('/api/connections/:id/nmea-log', (req, res) => {
        try {
            const { id } = req.params;
            
            if (!connections.has(id)) {
                return res.status(404).json({ error: 'Connection not found' });
            }
            
            const connection = connections.get(id);
            
            if (!connection.nmeaLogFile || !fs.existsSync(connection.nmeaLogFile)) {
                return res.status(404).json({ error: 'NMEA log not found for this connection' });
            }
            
            // Set headers for file download
            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('Content-Disposition', `attachment; filename="connection-${id}.nmea.log"`);
            
            // Create read stream and pipe to response
            const fileStream = fs.createReadStream(connection.nmeaLogFile);
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
            const { username, password, adminPassword, ...safeConfig } = config;
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
function saveConfig(config) {
    const configPath = configManager.CONFIG_FILE_PATH;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
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
        // Determine the date to compare (either disconnected date or connected date)
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
