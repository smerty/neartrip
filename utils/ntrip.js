/**
 * NTRIP Communication utilities
 * @module utils/ntrip
 */
const net = require('net');
const logger = require('./logger');
const { HTTP } = require('./constants');

/**
 * Connects to an NTRIP caster using the provided connection parameters and returns a promise that resolves with a net.Socket.
 *
 * @param {string} casterHost - The host of the NTRIP caster.
 * @param {number} casterPort - The port of the NTRIP caster.
 * @param {string} mountPoint - The mount point to connect to.
 * @param {string} [username] - Optional username for authentication.
 * @param {string} [password] - Optional password for authentication.
 * @param {string} [userAgent='NTRIP Client/1.0'] - Optional user agent for the connection.
 * @returns {Promise<net.Socket>} A promise that resolves to a net.Socket when the connection is successful.
 * @throws {Error} If required connection parameters are missing or if a connection error occurs.
 */
function connectToNtripCaster(casterHost, casterPort, mountPoint, username, password, userAgent) {
    logger.debug(`Connecting to NTRIP caster: ${casterHost}:${casterPort}/${mountPoint}`);
    
    // Validate required parameters
    if (!casterHost || !casterPort || !mountPoint) {
        throw new Error('Missing required connection parameters');
    }
    
    const auth = Buffer.from(`${username || ''}:${password || ''}`).toString('base64');
    const headers = [
        `GET /${mountPoint} HTTP/1.1`,
        `Host: ${casterHost}:${casterPort}`,
        HTTP.HEADERS.NTRIP_VERSION,
        `User-Agent: ${userAgent || 'NTRIP Client/1.0'}`,
        HTTP.HEADERS.CONNECTION,
        `Authorization: Basic ${auth}`,
        '',
        ''
    ].join('\r\n');

    return new Promise((resolve, reject) => {
        const casterSocket = net.connect(casterPort, casterHost, function() {
            logger.info(`Connected to caster: ${casterHost}:${casterPort}/${mountPoint}`);
            // Use 'this' to reference the socket inside the callback
            this.write(headers);
            resolve(this);
        });

        // Set up event handlers
        casterSocket.on('error', (error) => {
            logger.error(`Caster connection error (${casterHost}:${casterPort}/${mountPoint}):`, error);
            reject(error);
        });

        // Handle connection timeout
        casterSocket.setTimeout(10000, () => {
            logger.warn(`Connection to ${casterHost}:${casterPort}/${mountPoint} timed out`);
            casterSocket.end();
            reject(new Error('Connection timeout'));
        });
    });
}

/**
 * Generates an NTRIP sourcetable response
 * 
 * @param {string} mountPoint - The mountpoint name
 * @param {string} location - Geographic location description
 * @returns {string} Formatted sourcetable response
 */
function generateSourcetableResponse(mountPoint, location = 'NTRIP Service') {
    return [
        `${HTTP.RESPONSE_TYPES.SOURCETABLE} ${HTTP.OK_STATUS} ${HTTP.OK_MESSAGE}`,
        HTTP.CONTENT_TYPES.TEXT_PLAIN,
        '',
        '',
        `STR;${mountPoint};${location};RTCM 3;;2;GPS;NTRIP;USA;0;0;1;0;none;none;B;N;0;`,
        'ENDSOURCETABLE'
    ].join('\r\n');
}

module.exports = {
    connectToNtripCaster,
    generateSourcetableResponse
};
