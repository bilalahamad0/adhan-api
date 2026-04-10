const AdbKeepAlive = require('../adb_keepalive');

describe('AdbKeepAlive', () => {
  let fakeHardware;
  let service;

  beforeEach(() => {
    fakeHardware = {
      ping: jest.fn(),
      getAdbDevices: jest.fn(),
      startAdbServer: jest.fn(),
      adbCommand: jest.fn(),
      runExec: jest.fn(),
    };
    service = new AdbKeepAlive(fakeHardware, '1.2.3.4', 1000);
    // mute logs for clean output
    service.log = jest.fn();
  });

  afterEach(() => {
    service.stopService();
  });

  it('stops early if TV is not pingable', async () => {
    fakeHardware.ping.mockResolvedValue(false);
    await service.checkAndHeal();
    expect(fakeHardware.getAdbDevices).not.toHaveBeenCalled();
  });

  it('restarts ADB server if devices return null (offline)', async () => {
    fakeHardware.ping.mockResolvedValue(true);
    fakeHardware.getAdbDevices.mockResolvedValue(null);

    await service.checkAndHeal();

    expect(fakeHardware.startAdbServer).toHaveBeenCalled();
    expect(fakeHardware.runExec).not.toHaveBeenCalled(); // Returns early after server start
  });

  it('runs dummy shell date if TV is authorized and connected', async () => {
    fakeHardware.ping.mockResolvedValue(true);
    fakeHardware.getAdbDevices.mockResolvedValue('List of devices attached\\n1.2.3.4:5555 device');

    await service.checkAndHeal();

    expect(fakeHardware.adbCommand).toHaveBeenCalledWith('1.2.3.4', 'shell date');
    expect(fakeHardware.runExec).not.toHaveBeenCalled();
  });

  it('runs force connect sequence if TV is unauthorized', async () => {
    fakeHardware.ping.mockResolvedValue(true);
    fakeHardware.getAdbDevices.mockResolvedValue(
      'List of devices attached\\n1.2.3.4:5555 unauthorized'
    );
    fakeHardware.runExec.mockResolvedValue('already connected');

    await service.checkAndHeal();

    expect(fakeHardware.runExec).toHaveBeenCalledWith('adb disconnect 1.2.3.4:5555');
    expect(fakeHardware.runExec).toHaveBeenCalledWith('adb connect 1.2.3.4:5555');
  });

  it('handles exceptions safely', async () => {
    fakeHardware.ping.mockRejectedValue(new Error('Network Crash'));
    await service.checkAndHeal();
    expect(service.log).toHaveBeenCalledWith('🔥 Unexpected Error during check: Network Crash');
  });
});
