/**
 * GPS helpers kept for the original JavaScript unit tests.
 * Station selection for live rovers is in the Rust core (`src/geo.rs`).
 */
const geolib = require('geolib');
const logger = require('./logger');
const { CONVERSIONS } = require('./constants');

/**
 * Converts NMEA format coordinates to decimal degrees
 * 
 * @param {number} latlon - Coordinate in NMEA format (DDMM.MMMM)
 * @returns {number} Coordinate in decimal degrees
 * @throws {Error} If the input is not a valid number
 */
function parseLatLon(latlon) {
    if (isNaN(latlon) || latlon === undefined || latlon === null) {
        throw new Error('Invalid coordinate value');
    }
    
    const degree = Math.floor(latlon / 100);
    const minute = latlon - degree * 100;
    return degree + minute / 60;
}

/**
 * Parses a GPGGA NMEA sentence into its components
 * 
 * @param {string} sentence - A GPGGA NMEA sentence
 * @returns {Object|null} Parsed GPGGA data or null if invalid
 */
function parseGPGGA(sentence) {
    if (!sentence || typeof sentence !== 'string') {
        logger.error('Invalid GPGGA sentence: not a string');
        return null;
    }

    try {
        // Split the sentence into data and checksum parts
        const parts = sentence.split('*');
        if (parts.length !== 2) {
            logger.error('Invalid GPGGA format: missing checksum');
            return null;
        }

        const [data, checksum] = parts;

        // Calculate the checksum by XORing all bytes in data
        let calculatedChecksum = 0;
        for (let i = 1; i < data.length; i++) {
            calculatedChecksum ^= data.charCodeAt(i);
        }

        // Convert the calculated checksum into a hexadecimal string
        calculatedChecksum = calculatedChecksum.toString(16).toUpperCase().padStart(2, '0');

        // Compare the calculated checksum with the provided one
        if (calculatedChecksum !== checksum) {
            logger.warn(`Checksum mismatch: calculated ${calculatedChecksum}, received ${checksum}`);
        }

        // Parse the GPGGA fields
        const fields = data.split(',');

        if (fields[0] !== '$GPGGA') {
            logger.warn(`Not a GPGGA sentence: ${fields[0]}`);
            return null;
        }

        // Check if we have enough fields
        if (fields.length < 15) {
            logger.warn('GPGGA sentence has insufficient fields');
            return null;
        }
        
        // Parse coordinates, handling possible empty fields
        let latitude = null;
        let longitude = null;
        
        if (fields[2] && fields[4]) {
            try {
                latitude = parseLatLon(parseFloat(fields[2]));
                longitude = parseLatLon(parseFloat(fields[4]));
            } catch (error) {
                logger.error('Error parsing coordinates:', error);
                return null;
            }
        } else {
            logger.warn('Missing coordinate data in GPGGA sentence');
            return null;
        }

        const time = fields[1];
        const latDirection = fields[3];
        const lonDirection = fields[5];
        const fixQuality = parseInt(fields[6], 10) || 0;
        const numSatellites = parseInt(fields[7], 10) || 0;
        const horizontalDilution = parseFloat(fields[8]) || 0;
        const altitude = parseFloat(fields[9]) || 0;
        const altitudeUnit = fields[10];
        const heightOfGeoid = parseFloat(fields[11]) || 0;
        const heightOfGeoidUnit = fields[12];
        const lastDGPSUpdate = fields[13];
        const DGPSReferenceStationID = fields[14];

        const lat = latDirection === 'N' ? latitude : -latitude;
        const lon = lonDirection === 'E' ? longitude : -longitude;

        return {
            time,
            latitude: lat,
            longitude: lon,
            fixQuality,
            numSatellites,
            horizontalDilution,
            altitude,
            altitudeUnit,
            heightOfGeoid,
            heightOfGeoidUnit,
            lastDGPSUpdate,
            DGPSReferenceStationID
        };
    } catch (error) {
        logger.error('Error parsing GPGGA sentence:', error);
        return null;
    }
}

/**
 * Calculates the distance between two coordinate points
 * 
 * @param {number} user_lat - User latitude in decimal degrees
 * @param {number} user_lon - User longitude in decimal degrees
 * @param {number} station_lat - Station latitude in decimal degrees
 * @param {number} station_lon - Station longitude in decimal degrees
 * @returns {number} Distance in meters
 */
function calculateDistance(user_lat, user_lon, station_lat, station_lon) {
    try {
        return geolib.getDistance(
            { latitude: user_lat, longitude: user_lon },
            { latitude: station_lat, longitude: station_lon }
        );
    } catch (error) {
        logger.error('Error calculating distance:', error);
        return Infinity; // Return Infinity to ensure this station is not selected
    }
}

/**
 * Finds the closest NTRIP station to the user's location
 * 
 * @param {number} user_lat - User latitude in decimal degrees
 * @param {number} user_lon - User longitude in decimal degrees
 * @param {Array<Object>} stations - Array of station objects with latitude and longitude
 * @returns {Object|null} The closest station with distance added, or null if no valid stations
 */
function findClosestStation(user_lat, user_lon, stations) {
    if (!stations || !Array.isArray(stations) || stations.length === 0) {
        logger.error('No valid stations provided');
        return null;
    }

    if (isNaN(user_lat) || isNaN(user_lon)) {
        logger.error(`Invalid coordinates: ${user_lat}, ${user_lon}`);
        return null;
    }

    // Filter only active stations or all if no active flag exists
    const activeStations = stations.filter(station => 
        (station.active === undefined || station.active === true) && 
        !isNaN(station.latitude) && 
        !isNaN(station.longitude)
    );

    if (activeStations.length === 0) {
        logger.warn('No active stations available');
        return null;
    }

    return activeStations.reduce((closestStation, station) => {
        const distance = calculateDistance(user_lat, user_lon, station.latitude, station.longitude);

        logger.info(`Distance to ${station.mountPoint}: ${(distance / CONVERSIONS.METERS_PER_MILE).toFixed(2)} miles`);

        return (!closestStation || distance < closestStation.distance)
            ? { ...station, distance }
            : closestStation;
    }, null);
}

module.exports = {
    parseGPGGA,
    findClosestStation,
    parseLatLon,    // Exported for testing
    calculateDistance // Exported for testing
};
