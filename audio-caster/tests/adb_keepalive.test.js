const AdbKeepAlive = require('../adb_keepalive');

describe('AdbKeepAlive', () => {
  let fakeHardware;
  let service;

  beforeEach(() => {
    jest.useFakeTimers();
    fakeHardware = {
      isActuallyOn: jest.fn(),
      getAdbDevices: jest.fn(),
      checkScreenState: jest.fn(),
      runExec: jest.fn(),
    };
    service = new AdbKeepAlive(fakeHardware, '1.2.3.4');
    service.log = jest.fn();
    service.discovery.start = jest.fn();
    service.discovery.stop = jest.fn();
    service.discovery.on = jest.fn();
    service.schedule.isPreAdhanWindow = jest.fn().mockReturnValue(false);
  });

  afterEach(() => {
    service.stopService();
    jest.useRealTimers();
  });

  it('does not query ADB when TV is not awake', async () => {
    fakeHardware.isActuallyOn.mockResolvedValue(false);
    await service.checkAndHeal();
    expect(fakeHardware.getAdbDevices).not.toHaveBeenCalled();
  });

  it('transitions to SLEEPING when TV is offline', async () => {
    fakeHardware.isActuallyOn.mockResolvedValue(false);
    await service.checkAndHeal();
    expect(service.state).toBe('SLEEPING');
    expect(service.discovery.start).toHaveBeenCalled();
  });

  it('transitions to ONLINE when reachable, authorized, and screen ON', async () => {
    fakeHardware.isActuallyOn.mockResolvedValue(true);
    fakeHardware.getAdbDevices.mockResolvedValue(
      'List of devices attached\n1.2.3.4:5555\tdevice'
    );
    fakeHardware.checkScreenState.mockResolvedValue('ON');
    await service.checkAndHeal();
    expect(service.state).toBe('ONLINE');
    expect(service.discovery.stop).toHaveBeenCalled();
  });

  it('repairs ADB when pingable but device missing from list', async () => {
    fakeHardware.isActuallyOn.mockResolvedValue(true);
    fakeHardware.getAdbDevices.mockResolvedValue('List of devices attached\n');
    fakeHardware.runExec.mockImplementation((cmd) => {
      if (String(cmd).includes('adb connect')) return Promise.resolve('connected to 1.2.3.4:5555');
      return Promise.resolve('');
    });
    fakeHardware.checkScreenState.mockResolvedValue('ON');
    await service.checkAndHeal();
    expect(fakeHardware.runExec).toHaveBeenCalledWith('adb disconnect 1.2.3.4:5555');
    expect(fakeHardware.runExec).toHaveBeenCalledWith('adb connect 1.2.3.4:5555');
    expect(service.state).toBe('ONLINE');
  });

  it('handles exceptions during check', async () => {
    fakeHardware.isActuallyOn.mockRejectedValue(new Error('Network Crash'));
    await service.checkAndHeal();
    expect(service.log).toHaveBeenCalledWith('🔥 Error during check: Network Crash');
  });
});
