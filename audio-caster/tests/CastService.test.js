const CastService = require('../services/CastService');
const ChromecastAPI = require('chromecast-api');

jest.mock('chromecast-api', () => {
  return jest.fn().mockImplementation(() => {
    return {
      on: jest.fn(),
      destroy: jest.fn(),
    };
  });
});

describe('CastService', () => {
  let service;
  let mockClient;

  beforeEach(() => {
    mockClient = {
      on: jest.fn(),
      destroy: jest.fn(),
    };
    ChromecastAPI.mockImplementation(() => mockClient);
    service = new CastService();
  });

  it('starts scanner and registers listener', () => {
    service.startScanner();
    expect(ChromecastAPI).toHaveBeenCalled();
    expect(mockClient.on).toHaveBeenCalledWith('device', expect.any(Function));
  });

  it('collects devices and triggers callback', () => {
    const callback = jest.fn();
    service.startScanner(callback);
    
    // Simulate finding a device
    const deviceListener = mockClient.on.mock.calls[0][1];
    const mockDevice = { friendlyName: 'Test Hub' };
    deviceListener(mockDevice);

    expect(service.devices).toContain(mockDevice);
    expect(callback).toHaveBeenCalledWith('Test Hub');
  });

  it('finds device by exact or partial name', () => {
    service.devices = [{ friendlyName: 'Kitchen Display' }, { friendlyName: 'Living Room TV' }];
    
    expect(service.findDevice('Kitchen')).toEqual({ friendlyName: 'Kitchen Display' });
    expect(service.findDevice('Living Room TV')).toEqual({ friendlyName: 'Living Room TV' });
    expect(service.findDevice('Bedroom')).toBeUndefined();
  });

  it('destroys client safely', () => {
    service.startScanner();
    service.destroyScanner();
    expect(mockClient.destroy).toHaveBeenCalled();
    expect(service.client).toBeNull();
  });

  it('handles destroy error gracefully', () => {
    service.client = {
      destroy: () => { throw new Error('Burn'); }
    };
    expect(() => service.destroyScanner()).not.toThrow();
  });
});
