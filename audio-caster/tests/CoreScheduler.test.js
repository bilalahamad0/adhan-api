jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  readFileSync: jest.fn().mockReturnValue('{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn().mockReturnValue([]),
  statSync: jest.fn().mockReturnValue({ size: 1000 }),
}));

jest.mock('chromecast-api', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    destroy: jest.fn(),
  }));
});

jest.mock('ip', () => ({
  address: jest.fn().mockReturnValue('10.0.0.100'),
}));

jest.mock('canvas', () => ({
  createCanvas: jest.fn(() => ({
    getContext: jest.fn(() => ({
      fillRect: jest.fn(), fillStyle: '', font: '', fillText: jest.fn(),
      measureText: jest.fn().mockReturnValue({ width: 100 }),
      drawImage: jest.fn(), textBaseline: '', textAlign: '',
      globalAlpha: 1, shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
      strokeStyle: '', lineWidth: 1,
      save: jest.fn(), restore: jest.fn(), beginPath: jest.fn(), arc: jest.fn(),
      fill: jest.fn(), stroke: jest.fn(), moveTo: jest.fn(), lineTo: jest.fn(),
      closePath: jest.fn(), quadraticCurveTo: jest.fn(), bezierCurveTo: jest.fn(),
      rect: jest.fn(), ellipse: jest.fn(), clip: jest.fn(), setLineDash: jest.fn(), roundRect: jest.fn(),
      createLinearGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
      createRadialGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
    })),
    toBuffer: jest.fn().mockReturnValue(Buffer.from('image')),
  })),
  loadImage: jest.fn().mockResolvedValue({ width: 1280, height: 800 }),
  registerFont: jest.fn(),
}));

jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({ data: {} }),
}));

const CoreScheduler = require('../services/CoreScheduler');

describe('CoreScheduler', () => {
  let fakeHardware;
  let fakeMedia;
  let config;
  let scheduler;

  beforeEach(() => {
    jest.clearAllMocks();

    fakeHardware = {
      ping: jest.fn().mockResolvedValue(true),
      rebootOS: jest.fn(),
      getLocalIp: jest.fn().mockReturnValue('10.0.0.100'),
      isActuallyOn: jest.fn().mockResolvedValue(false),
      getAudioStatus: jest.fn().mockResolvedValue({ isPlaying: false, isMuted: false }),
    };

    fakeMedia = {
      encodeVideoFromImageAndAudio: jest.fn().mockReturnValue({
        promise: Promise.resolve('test.mp4'),
        abort: jest.fn(),
      }),
      getMediaDuration: jest.fn().mockResolvedValue(120),
    };

    config = {
      serverPort: 3000,
      timezone: 'America/Los_Angeles',
      device: { name: 'Living Room TV', targetVolume: 0.55 },
      location: { city: 'TestCity', country: 'US', method: 2, lat: 37.3, lon: -122.0 },
      audio: { fajrCurrent: 'fajr', regularCurrent: 'adhan' },
    };

    scheduler = new CoreScheduler(config, fakeHardware, fakeMedia, null, 'dummy.json');
    scheduler.log = jest.fn();
  });

  it('refuses to cast when SMOKE_DRY_RUN is active', async () => {
    process.env.SMOKE_DRY_RUN = '1';
    try {
      await scheduler.executePreFlightAndCast('Fajr', 'fajr.mp3', null);
      expect(scheduler.log).toHaveBeenCalledWith(
        expect.stringContaining('SMOKE_DRY_RUN active'),
      );
      expect(fakeMedia.encodeVideoFromImageAndAudio).not.toHaveBeenCalled();
    } finally {
      delete process.env.SMOKE_DRY_RUN;
    }
  });

  it('skips execution if the prayer session is already active', async () => {
    scheduler.activeRuns.add('Dhuhr');
    await scheduler.executePreFlightAndCast('Dhuhr', 'azan.mp3', null);

    expect(scheduler.log).toHaveBeenCalledWith(
      expect.stringContaining('Skipping Dhuhr: session already active'),
    );
    expect(fakeMedia.encodeVideoFromImageAndAudio).not.toHaveBeenCalled();
  });

  it('generates dashboard, encodes video, and attempts device discovery', async () => {
    scheduler.discoverDeviceByName = jest.fn().mockResolvedValue(null);

    await scheduler.executePreFlightAndCast('Maghrib', 'maghrib.mp3', null);

    expect(scheduler.log).toHaveBeenCalledWith(
      expect.stringContaining('TRIGGER: Maghrib'),
    );
    expect(fakeMedia.encodeVideoFromImageAndAudio).toHaveBeenCalled();
  });
});
