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

  afterEach(() => {
    // Scheduling tests arm real node-schedule jobs (for a future date). Cancel
    // them so their long-timeout handles don't keep the Jest process alive.
    if (scheduler && Array.isArray(scheduler._scheduledJobs)) {
      scheduler._scheduledJobs.forEach((j) => { try { j.cancel(); } catch (_) { /* ignore */ } });
    }
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

  // The chromecast-api file is lib/device.js (lowercase). Capital 'Device'
  // resolves on case-insensitive macOS but THROWS on the Pi's case-sensitive
  // Linux fs, silently killing the warm-cache path. A mocked unit test can't
  // catch that (and passes either way on macOS), so guard the source string —
  // this fails on every platform if the capital form is reintroduced.
  it('requires the chromecast Device class by its real lowercase path', () => {
    const realFs = jest.requireActual('fs');
    const p = require('path').join(__dirname, '..', 'services', 'CoreScheduler.js');
    const src = realFs.readFileSync(p, 'utf8');
    expect(src).toContain("require('chromecast-api/lib/device')");
    expect(src).not.toMatch(/require\('chromecast-api\/lib\/Device'\)/);
  });

  // Both morning scenes share one implementation, so the Adhan-safety contract is
  // exercised against both. SCENES maps the scene key to its expected surface.
  describe.each([
    ['sunrise', { runKey: 'Sunrise', label: 'Sunrise', file: 'sunrise.mp4' }],
    ['ishraq', { runKey: 'Ishraq', label: 'Ishraq', file: 'ishraq.mp4' }],
  ])('morning scene: %s', (sceneKey, meta) => {
    let fakeDevice;

    // castScene dwells for the length of the clip before releasing the device,
    // so drive it with fake timers rather than waiting ~14s of real time per test.
    const runCast = (label = '7:22 AM') => {
      const pending = scheduler.castScene(sceneKey, label);
      // Attach a handler up front: without it, a rejection landing mid-advance
      // is unhandled at that instant and fails the run before we can assert.
      pending.catch(() => {});
      return (async () => {
        await jest.advanceTimersByTimeAsync(60_000);
        return pending;
      })();
    };

    beforeEach(() => {
      jest.useFakeTimers();
      config.sunrise = { enabled: true, clipSeconds: 12, prebakeSec: 600, offsetSec: 0 };
      config.ishraq = { enabled: true, clipSeconds: 12, prebakeSec: 600, offsetSec: 1200 };
      fakeMedia.encodeSceneClip = jest.fn().mockReturnValue({
        promise: Promise.resolve(meta.file),
        abort: jest.fn(),
      });
      fakeDevice = {
        friendlyName: 'Living Room TV',
        getReceiverStatus: jest.fn((cb) => cb(null, { volume: { level: 0.7 } })),
        setVolume: jest.fn((v, cb) => cb && cb()),
        play: jest.fn((m, cb) => cb && cb()),
        stop: jest.fn((cb) => cb && cb()),
        close: jest.fn(),
      };
      scheduler.discoverDeviceByName = jest.fn().mockResolvedValue(fakeDevice);
      scheduler.ensureSceneClip = jest.fn().mockResolvedValue(`/images/generated/${meta.file}`);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('does nothing when disabled', async () => {
      config[sceneKey].enabled = false;
      await runCast();
      expect(scheduler.discoverDeviceByName).not.toHaveBeenCalled();
    });

    it('yields to an active prayer run rather than contending for the device', async () => {
      scheduler.activeRuns.add('Fajr');
      await runCast();
      expect(scheduler.log).toHaveBeenCalledWith(
        expect.stringContaining('another cast is active'),
      );
      expect(scheduler.discoverDeviceByName).not.toHaveBeenCalled();
    });

    // The clip is silent, so there is no level to set — and never calling
    // setVolume is the only way to guarantee the next Adhan can't inherit a
    // wrong one, since it reads the live volume as its "original".
    it('never touches the display volume', async () => {
      await runCast();
      expect(fakeDevice.setVolume).not.toHaveBeenCalled();
      expect(fakeDevice.play).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'video/mp4' }),
        expect.any(Function),
      );
    });

    it('casts its own clip file and labelled metadata', async () => {
      await runCast();
      const [media] = fakeDevice.play.mock.calls[0];
      expect(media.metadata.title).toBe(`${meta.label} · 7:22 AM`);
      expect(media.url).toContain(`/images/generated/${meta.file}`);
    });

    it('releases the device even when play fails', async () => {
      fakeDevice.play = jest.fn((m, cb) => cb(new Error('cast boom')));
      await expect(runCast()).rejects.toThrow('cast boom');
      expect(fakeDevice.close).toHaveBeenCalled();
      expect(fakeDevice.setVolume).not.toHaveBeenCalled();
      expect(scheduler.activeRuns.has(meta.runKey)).toBe(false);
    });

    it('clears its active run on success so it never blocks a later prayer', async () => {
      await runCast();
      expect(scheduler.activeRuns.has(meta.runKey)).toBe(false);
    });

    it('reports a double-trigger as already casting, not as another cast', async () => {
      scheduler.activeRuns.add(meta.runKey);
      await runCast();
      expect(scheduler.log).toHaveBeenCalledWith(expect.stringContaining('already casting'));
      expect(scheduler.log).not.toHaveBeenCalledWith(expect.stringContaining('another cast is active'));
    });

    // A second Device joins the SAME receiver session, so stop() would cut off an
    // in-flight Adhan. This shouldn't be reachable (a prayer holds activeRuns from
    // T-5min through the Dua), but the guard is cheap next to the downside.
    it('never stops the receiver if a prayer took over mid-cast', async () => {
      scheduler.ensureSceneClip = jest.fn().mockImplementation(async () => {
        scheduler.activeRuns.add('Fajr'); // prayer starts after our guard passed
        return `/images/generated/${meta.file}`;
      });
      await runCast();
      expect(fakeDevice.stop).not.toHaveBeenCalled();
      // close() still runs: it drops only our own socket, so skipping it would leak.
      expect(fakeDevice.close).toHaveBeenCalled();
      expect(scheduler.activeRuns.has(meta.runKey)).toBe(false); // still releases its own slot
    });

    // The watchdog must not fire while discovery is still within its own budget:
    // finish() is one-shot, so an early fire disarms the real cleanup.
    it('does not arm the watchdog until discovery has returned', async () => {
      let releaseDiscovery;
      scheduler.discoverDeviceByName = jest.fn(
        () => new Promise((resolve) => { releaseDiscovery = () => resolve(fakeDevice); }),
      );

      const pending = scheduler.castScene(sceneKey, '7:22 AM');
      pending.catch(() => {});

      // Discovery's own budget is 60s; the watchdog window is clipSeconds+25 = 37s.
      // Push past 37s while discovery is still legitimately in flight.
      await jest.advanceTimersByTimeAsync(45_000);
      expect(scheduler.activeRuns.has(meta.runKey)).toBe(true); // finish() must not have fired
      expect(fakeDevice.close).not.toHaveBeenCalled();

      releaseDiscovery();
      await jest.advanceTimersByTimeAsync(60_000);
      await pending;

      // Cleanup ran exactly once, at the end — not during discovery.
      expect(fakeDevice.play).toHaveBeenCalledTimes(1);
      expect(fakeDevice.close).toHaveBeenCalledTimes(1);
    });

    it('never records a playback event (it would break the adhan success streak)', async () => {
      const fakeLogger = { startEvent: jest.fn(), recordFailed: jest.fn(), recordPlayed: jest.fn() };
      scheduler.playbackLogger = fakeLogger;
      await runCast();
      expect(fakeLogger.startEvent).not.toHaveBeenCalled();
      expect(fakeLogger.recordFailed).not.toHaveBeenCalled();
      expect(fakeLogger.recordPlayed).not.toHaveBeenCalled();
    });

    it('never touches the TV for a decorative clip', async () => {
      await runCast();
      expect(fakeHardware.getAudioStatus).not.toHaveBeenCalled();
      expect(fakeHardware.isActuallyOn).not.toHaveBeenCalled();
    });

    describe('_scheduleMorningScene', () => {
      const entry = { timings: { Sunrise: '07:22 (PST)' } };
      const { DateTime } = require('luxon');
      const tomorrow = () => DateTime.now().setZone('America/Los_Angeles').plus({ days: 1 });

      beforeEach(() => { scheduler._scheduledJobs = []; });

      it('arms a bake job and a cast job', () => {
        scheduler._scheduleMorningScene(tomorrow(), entry, scheduler.log, sceneKey);
        expect(scheduler._scheduledJobs).toHaveLength(2);
      });

      it('arms nothing when disabled', () => {
        config[sceneKey].enabled = false;
        scheduler._scheduleMorningScene(tomorrow(), entry, scheduler.log, sceneKey);
        expect(scheduler._scheduledJobs).toHaveLength(0);
      });

      it('skips a schedule entry with no Sunrise timing', () => {
        scheduler._scheduleMorningScene(tomorrow(), { timings: {} }, scheduler.log, sceneKey);
        expect(scheduler._scheduledJobs).toHaveLength(0);
        expect(scheduler.log).toHaveBeenCalledWith(expect.stringContaining('no sunrise timing'));
      });

      it('skips an unparseable timing rather than throwing', () => {
        scheduler._scheduleMorningScene(tomorrow(), { timings: { Sunrise: 'not-a-time' } }, scheduler.log, sceneKey);
        expect(scheduler._scheduledJobs).toHaveLength(0);
      });

      it('skips a cast time that already passed today', () => {
        const yesterday = DateTime.now().setZone('America/Los_Angeles').minus({ days: 1 });
        scheduler._scheduleMorningScene(yesterday, entry, scheduler.log, sceneKey);
        expect(scheduler._scheduledJobs).toHaveLength(0);
      });
    });
  });

  // Cross-scene properties that a per-scene loop can't express.
  describe('sunrise + ishraq together', () => {
    const { DateTime } = require('luxon');
    const entry = { timings: { Sunrise: '07:22 (PST)' } };
    const tomorrow = () => DateTime.now().setZone('America/Los_Angeles').plus({ days: 1 });

    beforeEach(() => {
      config.sunrise = { enabled: true, clipSeconds: 12, prebakeSec: 600, offsetSec: 0 };
      config.ishraq = { enabled: true, clipSeconds: 12, prebakeSec: 600, offsetSec: 1200 };
      scheduler._scheduledJobs = [];
    });

    it('ishraq is scheduled after sunrise by its offset', () => {
      scheduler._scheduleMorningScene(tomorrow(), entry, scheduler.log, 'sunrise');
      scheduler._scheduleMorningScene(tomorrow(), entry, scheduler.log, 'ishraq');
      // 2 jobs each (bake + cast). The ishraq cast fires 20 min after the sunrise cast.
      const casts = scheduler._scheduledJobs
        .map((j) => j.nextInvocation())
        .map((d) => new Date(d).getTime())
        .sort((a, b) => a - b);
      const spanMin = (casts[casts.length - 1] - casts[0]) / 60000;
      // sunrise bake(-10) .. sunrise cast(0) .. ishraq bake(+10) .. ishraq cast(+20)
      expect(Math.round(spanMin)).toBe(30);
    });

    it('bakes sunrise and ishraq to distinct files, each single-flight', async () => {
      const fs = require('fs');
      fs.existsSync.mockReturnValue(false);
      const encodes = [];
      const resolvers = [];
      fakeMedia.encodeSceneClip = jest.fn((outPath, sceneKey) => {
        encodes.push(sceneKey);
        return { promise: new Promise((r) => resolvers.push(r)), abort: jest.fn() };
      });

      // Two concurrent ensure() per scene -> exactly one encode per scene.
      const p = [
        scheduler.ensureSceneClip('sunrise'), scheduler.ensureSceneClip('sunrise'),
        scheduler.ensureSceneClip('ishraq'), scheduler.ensureSceneClip('ishraq'),
      ];
      resolvers.forEach((r) => r('done'));
      await Promise.all(p);
      // One encode per scene (single-flight), and to distinct files.
      expect(encodes.sort()).toEqual(['ishraq', 'sunrise']);
      const files = fakeMedia.encodeSceneClip.mock.calls.map((c) => require('path').basename(c[0])).sort();
      expect(files).toEqual(['ishraq.mp4', 'sunrise.mp4']);
    });
  });
});
