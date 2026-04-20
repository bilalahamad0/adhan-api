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
      isBluetoothSpeakerConnectedForAudio: jest.fn(),
      requestBluetoothSpeakerConnect: jest.fn(),
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

  it('runs Bluetooth maintenance when ONLINE and TV_BT_SPEAKER_MAC is set', async () => {
    process.env.TV_BT_SPEAKER_MAC = 'AA:BB:CC:DD:EE:FF';
    process.env.TV_BT_POST_CONNECT_WAIT_MS = '0';
    fakeHardware.isActuallyOn.mockResolvedValue(true);
    fakeHardware.getAdbDevices.mockResolvedValue(
      'List of devices attached\n1.2.3.4:5555\tdevice'
    );
    fakeHardware.checkScreenState.mockResolvedValue('ON');
    let btProbe = 0;
    fakeHardware.isBluetoothSpeakerConnectedForAudio.mockImplementation(async () => {
      btProbe += 1;
      if (btProbe === 1) return false;
      return true;
    });
    fakeHardware.requestBluetoothSpeakerConnect.mockResolvedValue(true);
    await service.checkAndHeal();
    expect(fakeHardware.isBluetoothSpeakerConnectedForAudio).toHaveBeenCalledWith(
      '1.2.3.4',
      'AA:BB:CC:DD:EE:FF'
    );
    expect(fakeHardware.requestBluetoothSpeakerConnect).toHaveBeenCalledTimes(1);
    delete process.env.TV_BT_SPEAKER_MAC;
    delete process.env.TV_BT_POST_CONNECT_WAIT_MS;
  });

  it('attempts reconnect when Bluetooth state is unknown', async () => {
    process.env.TV_BT_SPEAKER_MAC = 'AA:BB:CC:DD:EE:FF';
    process.env.TV_BT_POST_CONNECT_WAIT_MS = '0';
    fakeHardware.isActuallyOn.mockResolvedValue(true);
    fakeHardware.getAdbDevices.mockResolvedValue(
      'List of devices attached\n1.2.3.4:5555\tdevice'
    );
    fakeHardware.checkScreenState.mockResolvedValue('ON');
    let btProbe = 0;
    fakeHardware.isBluetoothSpeakerConnectedForAudio.mockImplementation(async () => {
      btProbe += 1;
      if (btProbe === 1) return null;
      return false;
    });
    fakeHardware.requestBluetoothSpeakerConnect.mockResolvedValue(true);
    await service.checkAndHeal();
    expect(fakeHardware.requestBluetoothSpeakerConnect).toHaveBeenCalledWith(
      '1.2.3.4',
      'AA:BB:CC:DD:EE:FF'
    );
    expect(fakeHardware.requestBluetoothSpeakerConnect).toHaveBeenCalledTimes(2);
    delete process.env.TV_BT_SPEAKER_MAC;
    delete process.env.TV_BT_POST_CONNECT_WAIT_MS;
  });

  it('logBluetoothConfigSummary reports disabled when MAC missing', () => {
    delete process.env.TV_BT_SPEAKER_MAC;
    service.logBluetoothConfigSummary();
    expect(service.log).toHaveBeenCalledWith(
      expect.stringMatching(/🔊 BT: Auto-reconnect DISABLED/),
    );
  });

  it('does not run Bluetooth reconnect when TV_BT_SPEAKER_MAC is missing', async () => {
    delete process.env.TV_BT_SPEAKER_MAC;
    fakeHardware.isActuallyOn.mockResolvedValue(true);
    fakeHardware.getAdbDevices.mockResolvedValue(
      'List of devices attached\n1.2.3.4:5555\tdevice'
    );
    fakeHardware.checkScreenState.mockResolvedValue('ON');
    await service.checkAndHeal();
    expect(fakeHardware.isBluetoothSpeakerConnectedForAudio).not.toHaveBeenCalled();
    expect(fakeHardware.requestBluetoothSpeakerConnect).not.toHaveBeenCalled();
  });
});
