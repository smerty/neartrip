/**
 * Unit tests for NTRIP utility functions
 */
const ntrip = require('../utils/ntrip');
const net = require('net');

// Mock dependencies
jest.mock('../utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}));

// Mock the net module
jest.mock('net', () => {
  const mockSocket = {
    on: jest.fn().mockImplementation(function(event, callback) {
      // Store callbacks for triggering later
      if (!this.eventCallbacks) this.eventCallbacks = {};
      this.eventCallbacks[event] = callback;
      return this;
    }),
    setTimeout: jest.fn().mockImplementation(function(timeout, callback) {
      this.timeoutCallback = callback;
      return this;
    }),
    write: jest.fn(),
    end: jest.fn(),
    // Helper to trigger events in tests
    triggerEvent: function(event, ...args) {
      if (this.eventCallbacks && this.eventCallbacks[event]) {
        this.eventCallbacks[event](...args);
      }
    },
    triggerTimeout: function() {
      if (this.timeoutCallback) {
        this.timeoutCallback();
      }
    }
  };
  
  return {
    connect: jest.fn().mockImplementation((port, host, callback) => {
      // Store the callback to call later, but don't call it immediately
      mockSocket._connectionCallback = callback;
      return mockSocket;
    }),
    Socket: jest.fn().mockImplementation(() => mockSocket),
    _getMockSocket: () => mockSocket
  };
});

describe('NTRIP Utilities', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  describe('connectToNtripCaster', () => {
    test('should connect to NTRIP caster and write headers', async () => {
      const connectPromise = ntrip.connectToNtripCaster(
        'test.caster.com',
        2101,
        'TEST',
        'user',
        'pass',
        'TestAgent/1.0'
      );
      
      // Simulate successful connection
      const mockSocket = net._getMockSocket();
      mockSocket._connectionCallback.call(mockSocket);
      
      const casterSocket = await connectPromise;
      
      expect(net.connect).toHaveBeenCalledWith(2101, 'test.caster.com', expect.any(Function));
      expect(casterSocket.write).toHaveBeenCalledWith(expect.stringContaining('GET /TEST HTTP/1.1'));
      expect(casterSocket.write).toHaveBeenCalledWith(expect.stringContaining('Authorization: Basic'));
    });

    test('should throw an error for missing required parameters', () => {
      expect(() => ntrip.connectToNtripCaster(null, 2101, 'TEST', 'user', 'pass', 'Agent'))
        .toThrow('Missing required connection parameters');
    });

    test('should handle connection errors', async () => {
      const connectPromise = ntrip.connectToNtripCaster(
        'test.caster.com',
        2101,
        'TEST',
        'user',
        'pass',
        'TestAgent/1.0'
      );
      
      // Simulate an error
      net._getMockSocket().triggerEvent('error', new Error('Connection refused'));
      
      await expect(connectPromise).rejects.toThrow('Connection refused');
    });

    test('should handle connection timeout', async () => {
      const connectPromise = ntrip.connectToNtripCaster(
        'test.caster.com',
        2101,
        'TEST',
        'user',
        'pass',
        'TestAgent/1.0'
      );
      
      // Simulate a timeout
      net._getMockSocket().triggerTimeout();
      
      await expect(connectPromise).rejects.toThrow('Connection timeout');
    });
  });

  describe('generateSourcetableResponse', () => {
    test('should generate a valid sourcetable response', () => {
      const response = ntrip.generateSourcetableResponse('TEST', 'Test Location');
      
      expect(response).toContain('SOURCETABLE 200 OK');
      expect(response).toContain('STR;TEST;Test Location;');
      expect(response).toContain('ENDSOURCETABLE');
    });

    test('should use default location if not provided', () => {
      const response = ntrip.generateSourcetableResponse('TEST');
      
      expect(response).toContain('STR;TEST;NTRIP Service;');
    });
  });
});
