/**
 * Unit tests for GPS utility functions
 */
const gps = require('../utils/gps');

// Mock the logger to prevent console output during tests
jest.mock('../utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}));

describe('GPS Utilities', () => {
  describe('parseLatLon', () => {
    test('should correctly convert DDMM.MMMM to decimal degrees', () => {
      expect(gps.parseLatLon(3730.00)).toBeCloseTo(37.5, 5);
      expect(gps.parseLatLon(12215.00)).toBeCloseTo(122.25, 5);
    });

    test('should throw error for invalid inputs', () => {
      expect(() => gps.parseLatLon(null)).toThrow();
      expect(() => gps.parseLatLon(undefined)).toThrow();
      expect(() => gps.parseLatLon('invalid')).toThrow();
    });
  });

  describe('parseGPGGA', () => {
    test('should correctly parse valid GPGGA sentence', () => {
      const validSentence = '$GPGGA,123519,3723.2475,N,12158.3416,W,1,07,1.0,9.0,M,-34.2,M,,*59';
      const result = gps.parseGPGGA(validSentence);
      
      expect(result).toBeDefined();
      expect(result.time).toBe('123519');
      expect(result.latitude).toBeCloseTo(37.387458, 5);
      expect(result.longitude).toBeCloseTo(-121.972360, 5);
      expect(result.fixQuality).toBe(1);
      expect(result.numSatellites).toBe(7);
    });

    test('should return null for invalid GPGGA sentence', () => {
      expect(gps.parseGPGGA('$GPRMC,123519,A,3723.2475,N,12158.3416,W,0.1,309.62,120598,*10')).toBeNull();
      expect(gps.parseGPGGA('Invalid string')).toBeNull();
      expect(gps.parseGPGGA('')).toBeNull();
      expect(gps.parseGPGGA(null)).toBeNull();
    });

    test('should handle missing coordinate data', () => {
      const missingCoords = '$GPGGA,123519,,N,,W,1,07,1.0,9.0,M,-34.2,M,,*41';
      expect(gps.parseGPGGA(missingCoords)).toBeNull();
    });
  });

  describe('calculateDistance', () => {
    test('should calculate correct distance between two points', () => {
      const distance = gps.calculateDistance(37.5, -122.0, 37.6, -122.1);
      // Distance should be approximately 14km
      expect(distance).toBeGreaterThan(13000);
      expect(distance).toBeLessThan(15000);
    });
  });

  describe('findClosestStation', () => {
    const testStations = [
      { mountPoint: 'Station1', latitude: 37.5, longitude: -122.0 },
      { mountPoint: 'Station2', latitude: 37.6, longitude: -122.1 },
      { mountPoint: 'Station3', latitude: 38.0, longitude: -122.5 }
    ];

    test('should find the closest station', () => {
      const result = gps.findClosestStation(37.55, -122.05, testStations);
      expect(result.mountPoint).toBe('Station2');
      expect(result.distance).toBeDefined();
    });

    test('should handle invalid coordinates', () => {
      expect(gps.findClosestStation(NaN, -122.05, testStations)).toBeNull();
      expect(gps.findClosestStation(37.55, NaN, testStations)).toBeNull();
    });

    test('should handle empty or invalid station list', () => {
      expect(gps.findClosestStation(37.55, -122.05, [])).toBeNull();
      expect(gps.findClosestStation(37.55, -122.05, null)).toBeNull();
      expect(gps.findClosestStation(37.55, -122.05, 'not an array')).toBeNull();
    });

    test('should respect active flag if present', () => {
      const mixedStations = [
        { mountPoint: 'Inactive', latitude: 37.51, longitude: -122.01, active: false },
        { mountPoint: 'Active', latitude: 37.7, longitude: -122.2, active: true }
      ];
      
      const result = gps.findClosestStation(37.52, -122.02, mixedStations);
      expect(result.mountPoint).toBe('Active');
    });
  });
});
