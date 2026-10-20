/**
 * Configuration utility for loading and reloading server configuration
 * @module utils/config
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// Default configuration file path
const CONFIG_FILE_PATH = path.join(__dirname, '..', 'config.json');

// Default configuration values
const DEFAULT_CONFIG = {
    username: "",
    password: "",
    users: [],
    interface: "0.0.0.0",
    port: 2101,
    mountPoint: "NEAR-Default",
    userAgent: "NearTRIP/1.0",
    adminPort: 3000,
    adminUsername: "admin",
    adminPassword: "admin",
    sources: [],
    stations: []
};

// Current configuration
let currentConfig = null;
let loadedPath = CONFIG_FILE_PATH, loadedStamp = null;
function stamp(file) {
    const s = fs.statSync(file, { bigint: true });
    return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}
const listeners = new Set();
function publishConfig(config) {
    currentConfig = config;
    for (const listener of listeners) listener(config);
}
function subscribeConfig(listener) { listeners.add(listener); return () => listeners.delete(listener); }

/**
 * Load configuration from file
 * 
 * @param {string} [filePath=CONFIG_FILE_PATH] - Path to the configuration file
 * @returns {Object} The loaded configuration
 * @throws {Error} If the configuration file cannot be loaded or parsed
 */
function loadConfig(filePath = CONFIG_FILE_PATH) {
    try {
        // Check if the config file exists
        if (!fs.existsSync(filePath)) {
            logger.info(`Configuration file ${filePath} does not exist, creating with defaults`);
            
            // Create directory if it doesn't exist
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            // Write default config to file
            fs.writeFileSync(filePath, JSON.stringify(DEFAULT_CONFIG, null, 4), { mode: 0o600 });
            logger.info(`Default configuration written to ${filePath}`);
            
            // Store and return the default config
            loadedPath = filePath; loadedStamp = stamp(filePath);
            publishConfig({ ...DEFAULT_CONFIG });
            return currentConfig;
        }
        
        // Reading JSON directly also follows atomically replaced symlink targets.
        const before = stamp(filePath);
        const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (before !== stamp(filePath)) throw new Error('Configuration changed during read; retry');
        loadedPath = filePath;
        loadedStamp = before;
        logger.info(`Configuration loaded successfully from ${filePath}`);
        
        // Store as current config
        publishConfig(config);
        
        return config;
    } catch (error) {
        logger.error(`Failed to load configuration from ${filePath}:`, error);
        
        throw new Error(`Could not load configuration file. Error: ${error.message}`);
    }
}

/**
 * Get the current configuration
 * 
 * @returns {Object} The current configuration
 */
function getConfig() {
    if (!currentConfig) {
        return loadConfig();
    }
    // Synchronize before reads/mutations too, so they cannot overwrite a disk
    // edit during the interval before the watcher fires. Fail closed on bad JSON.
    if (stamp(loadedPath) !== loadedStamp) return reloadConfig(loadedPath);
    return currentConfig;
}

/**
 * Reload the configuration from disk
 * 
 * @param {string} [filePath=CONFIG_FILE_PATH] - Path to the configuration file
 * @returns {Object} The reloaded configuration
 * @throws {Error} If the configuration file cannot be loaded or parsed
 */
function reloadConfig(filePath = CONFIG_FILE_PATH) {
    if (!fs.existsSync(filePath)) throw new Error('Configuration file is unavailable');
    logger.info(`Reloading configuration from ${filePath}`);
    return loadConfig(filePath);
}

/**
 * Watch the configuration file for changes and reload automatically
 * 
 * @param {string} [filePath=CONFIG_FILE_PATH] - Path to the configuration file
 * @param {Function} [callback] - Optional callback function to call when config is reloaded
 * @returns {{close: Function}} Watcher cleanup handle
 */
function watchConfig(filePath = CONFIG_FILE_PATH, callback) {
    logger.info(`Setting up config file watch on ${filePath}`);
    
    // Poll the pathname, rather than a file inode: atomic replacement and
    // replacement of a Docker/symlink target must continue to be observed.
    const listener = () => {
        try {
            if (stamp(filePath) === loadedStamp) return;
            const config = reloadConfig(filePath);
            if (typeof callback === 'function') callback(config);
        } catch (error) { logger.error('Error reloading configuration after file change:', error); }
    };
    fs.watchFile(filePath, { persistent: false, interval: 250 }, listener);
    return { close() { fs.unwatchFile(filePath, listener); } };
}

// Initialize by loading the configuration
try {
    loadConfig();
} catch (error) {
    // Log but don't exit - let the server handle startup errors
    logger.error('Failed to load initial configuration:', error);
}

module.exports = {
    subscribeConfig,
    loadConfig,
    getConfig,
    reloadConfig,
    watchConfig,
    CONFIG_FILE_PATH
};
