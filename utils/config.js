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
            fs.writeFileSync(filePath, JSON.stringify(DEFAULT_CONFIG, null, 4));
            logger.info(`Default configuration written to ${filePath}`);
            
            // Store and return the default config
            currentConfig = { ...DEFAULT_CONFIG };
            return currentConfig;
        }
        
        // Clear the Node.js require cache for the config file
        // This ensures we get a fresh copy of the file when it changes
        if (require.cache[require.resolve(filePath)]) {
            delete require.cache[require.resolve(filePath)];
        }
        
        // Load the configuration
        const config = require(filePath);
        logger.info(`Configuration loaded successfully from ${filePath}`);
        
        // Store as current config
        currentConfig = config;
        
        return config;
    } catch (error) {
        logger.error(`Failed to load configuration from ${filePath}:`, error);
        
        // If we can't load the config file but it exists, it might be corrupted
        if (fs.existsSync(filePath)) {
            logger.warn(`Configuration file ${filePath} might be corrupted, using default configuration`);
            
            // We'll use the default config in memory but won't overwrite the file
            currentConfig = { ...DEFAULT_CONFIG };
            return currentConfig;
        }
        
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
    logger.info(`Reloading configuration from ${filePath}`);
    return loadConfig(filePath);
}

/**
 * Watch the configuration file for changes and reload automatically
 * 
 * @param {string} [filePath=CONFIG_FILE_PATH] - Path to the configuration file
 * @param {Function} [callback] - Optional callback function to call when config is reloaded
 * @returns {fs.FSWatcher} A file watcher instance
 */
function watchConfig(filePath = CONFIG_FILE_PATH, callback) {
    logger.info(`Setting up config file watch on ${filePath}`);
    
    const watcher = fs.watch(filePath, { persistent: true }, (eventType) => {
        if (eventType === 'change') {
            logger.info(`Configuration file ${filePath} changed`);
            
            try {
                const newConfig = reloadConfig(filePath);
                
                if (callback && typeof callback === 'function') {
                    callback(newConfig);
                }
            } catch (error) {
                logger.error('Error reloading configuration after file change:', error);
                // Continue using previous configuration on error
            }
        }
    });
    
    watcher.on('error', (error) => {
        logger.error(`Error watching config file ${filePath}:`, error);
    });
    
    return watcher;
}

// Initialize by loading the configuration
try {
    loadConfig();
} catch (error) {
    // Log but don't exit - let the server handle startup errors
    logger.error('Failed to load initial configuration:', error);
}

module.exports = {
    loadConfig,
    getConfig,
    reloadConfig,
    watchConfig,
    CONFIG_FILE_PATH
};
