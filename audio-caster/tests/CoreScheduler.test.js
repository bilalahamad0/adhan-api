const CoreScheduler = require('../services/CoreScheduler');

describe('CoreScheduler', () => {
  let fakeHardware;
  let fakeMedia;
  let fakeCast;
  let config;
  let scheduler;

  beforeEach(() => {
    fakeHardware = {
      ping: jest.fn(),
      rebootOS: jest.fn(),
      getLocalIp: jest.fn().mockReturnValue('10.0.0.100'),
    };

    fakeMedia = {
      encodeVideoFromImageAndAudio: jest.fn(),
    };

    fakeCast = {
      startScanner: jest.fn(),
      findDevice: jest.fn(),
      setVolume: jest.fn(),
      castMedia: jest.fn(),
    };

    config = {
      serverPort: 3000,
      device: { name: 'Living Room TV', targetVolume: 0.55 },
    };

    scheduler = new CoreScheduler(config, fakeHardware, fakeMedia, fakeCast, 'dummy.json');
    scheduler.log = jest.fn(); // suppress output
  });

  it('aborts execution and reboots if network preflight fails on unmocked gateway', async () => {
    // Override platform for test to hit linux branch
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });

    fakeHardware.ping.mockResolvedValue(false);
    await scheduler.executePreFlightAndCast('Fajr', 'fajr.mp3', null);

    expect(fakeHardware.rebootOS).toHaveBeenCalled();
    expect(fakeMedia.encodeVideoFromImageAndAudio).not.toHaveBeenCalled();

    // Restore platform
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('skips execution if the target time was more than 10 minutes ago (sleep guard)', async () => {
    fakeHardware.ping.mockResolvedValue(true);

    const fakeTimeObj = {
      toMillis: () => Date.now() - 15 * 60 * 1000, // 15 mins ago
      toFormat: jest.fn().mockReturnValue('17:00'),
    };

    await scheduler.executePreFlightAndCast('Dhuhr', 'azan.mp3', fakeTimeObj);

    expect(scheduler.log).toHaveBeenCalledWith(expect.stringContaining('Too late for Dhuhr'));
    expect(fakeMedia.encodeVideoFromImageAndAudio).not.toHaveBeenCalled();
  });

  it('encodes video and triggers cast if all preflights pass', async () => {
    fakeHardware.ping.mockResolvedValue(true);
    fakeMedia.encodeVideoFromImageAndAudio.mockResolvedValue('test.mp4');

    // Simulate scanner instantly finding the device
    fakeCast.startScanner.mockImplementation(async (cb) => {
      await cb('Living Room TV');
    });
    fakeCast.findDevice.mockReturnValue({ id: 'mock-device' });

    await scheduler.executePreFlightAndCast('Maghrib', 'maghrib.mp3', null);

    expect(fakeMedia.encodeVideoFromImageAndAudio).toHaveBeenCalled();
    expect(fakeCast.setVolume).toHaveBeenCalledWith({ id: 'mock-device' }, 0.55);
    expect(fakeCast.castMedia).toHaveBeenCalledWith(
      { id: 'mock-device' },
      expect.stringContaining('http://10.0.0.100:3000/images/generated/maghrib.mp4')
    );
  });
});
