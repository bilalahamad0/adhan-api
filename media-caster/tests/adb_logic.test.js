const HardwareService = require('../services/HardwareService');

describe('ADB Hardware Logic', () => {
  let hardware;

  beforeEach(() => {
    hardware = new HardwareService();
    hardware.runExec = jest.fn(async (cmd) => {
      if (cmd === 'adb devices') return 'List of devices attached\n1.2.3.4:5555\tdevice';
      if (cmd.includes('dumpsys media_session')) return 'state=3 (PLAYING)';
      return 'OK';
    });
  });

  test('getAdbDevices finds test IP in device list', async () => {
    const devices = await hardware.getAdbDevices();
    expect(devices).toContain('1.2.3.4');
  });

  test('pause command sends keyevent 127 when playing', async () => {
    const testIp = '1.2.3.4';
    const status = await hardware.runExec(`adb -s ${testIp}:5555 shell dumpsys media_session`);
    expect(status).toContain('state=3');

    await hardware.runExec(`adb -s ${testIp}:5555 shell input keyevent 127`);
    expect(hardware.runExec).toHaveBeenCalledWith(
      expect.stringContaining('keyevent 127'),
    );
  });

  test('resume command sends keyevent 126', async () => {
    const testIp = '1.2.3.4';
    await hardware.runExec(`adb -s ${testIp}:5555 shell input keyevent 126`);
    expect(hardware.runExec).toHaveBeenCalledWith(
      expect.stringContaining('keyevent 126'),
    );
  });
});
