/**
 * NearTRIP admin process.
 *
 * The NTRIP listener is the Rust binary. This process serves the admin UI
 * and starts that binary unless NEARTRIP_DISABLE_CORE is set.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('./utils/logger');
const configManager = require('./utils/config');
const adminServer = require('./admin/adminServer');

let shuttingDown = false;
let coreProcess = null;

function loadConfig() {
    try {
        const config = configManager.getConfig();
        logger.info('Configuration loaded successfully');
        return config;
    } catch (error) {
        logger.error('Failed to load configuration:', error);
        console.error('Error: Could not load config.json. Please ensure it exists and is valid JSON.');
        process.exit(1);
    }
}

function coreBinary() {
    const override = process.env.NEARTRIP_BIN;
    if (override) {
        // Resolve path overrides from the launch directory. spawn() below
        // changes cwd, which would otherwise make ./bin/core miss the file.
        // A bare command name is left for PATH lookup.
        if (path.isAbsolute(override) || override.includes('/') || override.includes('\\')) {
            return path.resolve(override);
        }
        return override;
    }
    const candidates = [
        path.join(__dirname, 'target', 'release', 'neartrip'),
        path.join(__dirname, 'target', 'debug', 'neartrip'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return 'neartrip';
}

function startCore() {
    const bin = coreBinary();
    const root = __dirname;
    logger.info(`Starting Rust core: ${bin}`);
    // The admin UI reads logs/sessions.json next to this file. The core must
    // use that same directory even when this process was started elsewhere.
    const child = spawn(bin, [], {
        cwd: root,
        stdio: 'inherit',
        env: {
            ...process.env,
            NEARTRIP_CONFIG: path.join(root, 'config.json'),
            NEARTRIP_SESSIONS: path.join(root, 'logs', 'sessions.json'),
            NEARTRIP_SOURCES: path.join(root, 'logs', 'sources.json'),
        },
    });
    child.on('error', (error) => {
        logger.error(`Failed to start Rust core (${bin}): ${error.message}`);
        logger.error('Build it with: cargo build --release');
        process.exit(1);
    });
    child.on('exit', (code, signal) => {
        if (shuttingDown) {
            return;
        }
        logger.error(`Rust core exited (${signal || code})`);
        process.exit(code === null ? 1 : code);
    });
    return child;
}

function startAdmin(config) {
    const adminPort = config.adminPort || 3000;
    const adminUser = config.adminUsername || 'admin';
    const adminPass = config.adminPassword || 'admin';
    adminServer.initAdminServer({
        port: adminPort,
        username: adminUser,
        password: adminPass,
    });
    logger.info(`Admin interface available at http://localhost:${adminPort}`);
}

function shutdown() {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    logger.info('Shutting down...');
    if (coreProcess) {
        coreProcess.kill('SIGTERM');
    }
    process.exit(0);
}

function startServer() {
    const config = loadConfig();
    startAdmin(config);
    if (!process.env.NEARTRIP_DISABLE_CORE) {
        coreProcess = startCore();
    }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) {
    startServer();
}

module.exports = { startServer };
