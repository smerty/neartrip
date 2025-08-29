/**
 * Constants used throughout the NearTRIP application
 * @module utils/constants
 */

// HTTP and protocol constants
const HTTP = {
  OK_STATUS: 200,
  OK_MESSAGE: 'OK',
  HEADERS: {
    NTRIP_VERSION: 'Ntrip-Version: Ntrip/2.0',
    CONNECTION: 'Connection: keep-alive',
  },
  RESPONSE_TYPES: {
    SOURCETABLE: 'SOURCETABLE',
    ICY: 'ICY'
  },
  CONTENT_TYPES: {
    TEXT_PLAIN: 'Content-Type: text/plain',
  }
};

// NTRIP protocol constants
const NTRIP = {
  REQUEST_TYPES: {
    ROOT: 'GET / ',
    MOUNTPOINT: 'GET /',
    GPGGA: '$GPGGA'
  },
  SOURCETABLE_END: 'ENDSOURCETABLE'
};

// File paths for logs
const FILES = {
  NMEA_LOG: 'logs/nmea.log',
};

// Conversion constants
const CONVERSIONS = {
  METERS_PER_MILE: 1609.344
};

module.exports = {
  HTTP,
  NTRIP,
  FILES,
  CONVERSIONS
};
