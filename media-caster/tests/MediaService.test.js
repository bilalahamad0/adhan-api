jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  createWriteStream: jest.fn(() => ({ on: jest.fn() })),
  statSync: jest.fn(),
  readdirSync: jest.fn().mockReturnValue([]),
  readFileSync: jest.fn(),
  unlinkSync: jest.fn(),
}));
jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));
jest.mock('fluent-ffmpeg', () => {
  return jest.fn(() => ({
    input: jest.fn().mockReturnThis(),
    inputOptions: jest.fn().mockReturnThis(),
    complexFilter: jest.fn().mockReturnThis(),
    videoCodec: jest.fn().mockReturnThis(),
    audioCodec: jest.fn().mockReturnThis(),
    audioFrequency: jest.fn().mockReturnThis(),
    outputOptions: jest.fn().mockReturnThis(),
    save: jest.fn().mockReturnThis(),
    on: jest.fn(function (event, cb) {
      if (event === 'end') cb();
      return this;
    }),
  }));
});

const MediaService = require('../services/MediaService');
const fs = require('fs');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');

describe('MediaService', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MediaService();
  });

  it('skips existing audio sources and only downloads missing ones', async () => {
    fs.existsSync.mockReturnValueOnce(true); // audioDirPath exists
    fs.existsSync.mockReturnValueOnce(true); // file1.mp3 exists
    fs.existsSync.mockReturnValueOnce(false); // file2.mp3 missing

    const mockStream = { data: 'mockData' };
    axios.get.mockResolvedValueOnce(mockStream);

    const config = {
      audio: {
        options: {
          adhan: 'http://foo.com/adhan.mp3',
          fajr: 'http://foo.com/fajr.mp3',
        },
      },
    };

    await service.cacheAudioSources(config, '/tmp/audio');

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledWith('http://foo.com/fajr.mp3', { responseType: 'stream' });
  });

  it('can generate a video from image and audio', async () => {
    const mockFFmpeg = {
      input: jest.fn().mockReturnThis(),
      inputOptions: jest.fn().mockReturnThis(),
      complexFilter: jest.fn().mockReturnThis(),
      videoCodec: jest.fn().mockReturnThis(),
      audioCodec: jest.fn().mockReturnThis(),
      audioFrequency: jest.fn().mockReturnThis(),
      outputOptions: jest.fn().mockReturnThis(),
      save: jest.fn().mockReturnThis(),
      on: jest.fn(function (event, cb) {
        if (event === 'end') cb();
        return this;
      }),
    };
    ffmpeg.mockImplementation(() => mockFFmpeg);

    const { promise } = service.encodeVideoFromImageAndAudio('img.jpg', 'aud.mp3', 'out.mp4');
    const result = await promise;
    expect(result).toBe('out.mp4');
    expect(mockFFmpeg.save).toHaveBeenCalledWith('out.mp4');
  });

  it('can calculate file size in MB', () => {
    fs.statSync.mockReturnValue({ size: 1048576 * 2.5 }); // 2.5MB
    const size = service.getFileSizeMB('foo.mp4');
    expect(size).toBe('2.50');
  });

  it('returns 0.00 for missing file stats', () => {
    fs.statSync.mockImplementation(() => { throw new Error('NOENT'); });
    const size = service.getFileSizeMB('foo.mp4');
    expect(size).toBe('0.00');
  });

  it('nominal adhan: Fajr 4min, others 2min', () => {
    expect(MediaService.getNominalAdhanSeconds('Fajr')).toBe(240);
    expect(MediaService.getNominalAdhanSeconds('Isha')).toBe(120);
    expect(MediaService.getNominalAdhanSeconds('Maghrib')).toBe(120);
  });

  it('pre-encode floor is slightly below nominal', () => {
    expect(MediaService.getMinExpectedDuration('Fajr')).toBe(228);
    expect(MediaService.getMinExpectedDuration('Dhuhr')).toBe(110);
  });

  it('playback too-short threshold is half nominal (rounded down)', () => {
    expect(MediaService.getPlaybackTooShortThresholdSeconds('Fajr')).toBe(120);
    expect(MediaService.getPlaybackTooShortThresholdSeconds('Asr')).toBe(60);
  });

  it('encoding timeout scales with audio length (Fajr vs regular)', () => {
    expect(MediaService.getEncodingTimeoutMs('Fajr', 240)).toBe(1_050_000);
    expect(MediaService.getEncodingTimeoutMs('Fajr', 200)).toBe(890_000);
    expect(MediaService.getEncodingTimeoutMs('Dhuhr', 120)).toBe(570_000);
    expect(MediaService.getEncodingTimeoutMs('Dhuhr', null)).toBe(570_000);
    expect(MediaService.getEncodingTimeoutMs('Fajr', 400)).toBe(25 * 60 * 1000);
  });

  describe('sunrise clip', () => {
    const graph = (opts) => MediaService.buildSunriseFilters(opts).complexFilter.join('\n');

    it('clamps duration rather than trusting env input', () => {
      expect(MediaService.buildSunriseFilters({ durationSec: 600 }).durationSec).toBe(20);
      expect(MediaService.buildSunriseFilters({ durationSec: 0 }).durationSec).toBe(5);
      expect(MediaService.buildSunriseFilters({ durationSec: 'abc' }).durationSec).toBe(12);
      expect(MediaService.buildSunriseFilters().durationSec).toBe(12);
    });

    // The clip plays at dawn while people may still be asleep. Silence is the
    // feature, not a default — there must be no tone generator in the graph at all.
    it('is silent: carries a null audio source and no tone generators', () => {
      const g = graph({});
      expect(g).toContain('anullsrc');
      expect(g).not.toContain('sine=');
      expect(g).not.toContain('amix');
      expect(g).not.toContain('volume=');
    });

    it('still emits a real (silent) audio track, since Cast expects a stream', () => {
      expect(graph({})).toContain('[a]');
    });

    // At durations under ~4s the clip ends before the sun finishes rising.
    it('always finishes the rise within the clip', () => {
      [5, 8, 12, 20].forEach((durationSec) => {
        const { riseSec } = MediaService.buildSunriseFilters({ durationSec });
        expect(1.5 + riseSec).toBeLessThanOrEqual(durationSec);
      });
    });

    // The rise duration must be derived from clip length. If it were a constant,
    // a short clip would end before the sun cleared the horizon.
    it('derives rise duration from clip length and always leaves a hold', () => {
      [3, 5, 8, 12, 20].forEach((durationSec) => {
        const { riseSec } = MediaService.buildSunriseFilters({ durationSec });
        expect(riseSec).toBeGreaterThanOrEqual(2);
        expect(riseSec).toBeLessThanOrEqual(durationSec);
      });
      expect(MediaService.buildSunriseFilters({ durationSec: 12 }).riseSec).toBe(8);
    });

    // Guards the Pi cost model: one geq evaluation per sprite, not one per frame.
    it('renders each sprite once and replays it via loop', () => {
      const g = graph({});
      expect(g.match(/loop=loop=-1:size=1/g)).toHaveLength(3);
      expect(g.match(/geq=/g)).toHaveLength(3);
      expect(g).toContain('d=0.1');
    });

    it('animates via an overlay y-expression, not per-frame pixel maths', () => {
      expect(graph({})).toContain("overlay=x=(W-w)/2:y='560-350*(1-pow(1-clip((t-1.5)/8");
    });

    it('declares sources in-graph so fluent-ffmpeg never sees a lavfi input', () => {
      const spec = MediaService.buildSunriseFilters({});
      expect(spec.complexFilter[0]).toContain('color=c=black');
      expect(spec).not.toHaveProperty('videoInputs');
      expect(graph({})).toContain('anullsrc');
    });

    it('ends the video at [v] and the audio at [a]', () => {
      const g = graph({});
      expect(g).toContain('[v]');
      expect(g).toContain('[a]');
    });

    // Sunrise must never become a reason to touch the adhan encode path.
    it('shares no filter line with the adhan encoder', () => {
      const g = graph({});
      expect(g).not.toContain("lut2=c0='x+y'");
      expect(g).not.toContain('adelay=1500|1500[a]');
    });

    it('pins duration with -t and does not rely on -shortest', () => {
      service.encodeSunriseClip('/tmp/sunrise.mp4', { durationSec: 7 });
      const opts = ffmpeg.mock.results[0].value.outputOptions.mock.calls[0][0];
      expect(opts).toContain('-t 7');
      expect(opts).not.toContain('-shortest');
      expect(opts).toContain('-profile:v baseline'); // Nest Hub compatibility
    });
  });

  // Properties shared by every morning scene: silence, the Pi cost model, and
  // isolation from the adhan encode path. Runs against sunrise and ishraq alike.
  describe.each(['sunrise', 'ishraq'])('morning scene graph: %s', (sceneKey) => {
    const graph = (d) => MediaService.buildSceneFilters(sceneKey, { durationSec: d }).complexFilter.join('\n');

    it('is silent — a null source, no tone generators', () => {
      const g = graph(12);
      expect(g).toContain('anullsrc');
      expect(g).not.toContain('sine=');
      expect(g).not.toContain('volume=');
      expect(g).toContain('asetnsamples=n=1024:p=0'); // ffmpeg 5.x aac frame-size fix
    });

    it('renders each sprite once and replays it via loop (Pi cost model)', () => {
      const g = graph(12);
      expect(g.match(/loop=loop=-1:size=1/g)).toHaveLength(3);
      expect(g.match(/geq=/g)).toHaveLength(3);
    });

    it('finishes the rise within the clip across the clamp range', () => {
      [5, 8, 12, 20].forEach((d) => {
        const spec = MediaService.buildSceneFilters(sceneKey, { durationSec: d });
        expect(spec.lead ?? 1.5).toBeLessThan(d); // sanity
        expect(spec.riseSec).toBeGreaterThanOrEqual(2);
        expect(spec.riseSec).toBeLessThanOrEqual(d);
      });
    });

    it('ends the video at [v] and the audio at [a]', () => {
      const g = graph(12);
      expect(g).toContain('[v]');
      expect(g).toContain('[a]');
    });

    it('shares no filter line with the adhan encoder', () => {
      const g = graph(12);
      expect(g).not.toContain("lut2=c0='x+y'");
      expect(g).not.toContain('adelay=1500|1500[a]');
    });
  });

  // What makes ishraq a distinct clip, not a recoloured sunrise.
  describe('ishraq clip (distinct from sunrise)', () => {
    const g = (scene) => MediaService.buildSceneFilters(scene, { durationSec: 12 }).complexFilter.join('\n');

    it('rotates the sun sprite for radiating rays (sunrise does not)', () => {
      expect(g('ishraq')).toContain('rotate=a=');
      expect(g('sunrise')).not.toContain('rotate=a=');
    });

    it('uses a rayed sun and a daylight-blue sky, unlike the dawn sunrise', () => {
      const ish = g('ishraq');
      expect(ish).toContain('cos(12*atan2'); // 12-fold ray modulation
      // Ishraq settles the sun higher in the frame than sunrise (yEnd 90 vs 210).
      expect(ish).toContain("y='330-240*");
      expect(g('sunrise')).toContain("y='560-350*");
    });

    it('is byte-identical whether reached via alias or scene key', () => {
      expect(JSON.stringify(MediaService.buildSunriseFilters({ durationSec: 9 })))
        .toEqual(JSON.stringify(MediaService.buildSceneFilters('sunrise', { durationSec: 9 })));
    });

    it('encodeSceneClip pins duration and baseline profile like the sunrise path', () => {
      service.encodeSceneClip('/tmp/ishraq.mp4', 'ishraq', { durationSec: 7 });
      const opts = ffmpeg.mock.results[0].value.outputOptions.mock.calls[0][0];
      expect(opts).toContain('-t 7');
      expect(opts).not.toContain('-shortest');
      expect(opts).toContain('-profile:v baseline');
    });
  });

  describe('bilingual captions', () => {
    it('each scene carries English, Arabic, transliteration and a tagline', () => {
      const s = MediaService.MORNING_SCENES;
      // Title renders as "<en> (<tr>)", e.g. "Sunrise (Shurūq)".
      expect(s.sunrise).toMatchObject({ en: 'Sunrise', ar: 'شروق', tr: 'Shurūq' });
      expect(s.ishraq).toMatchObject({ en: 'Sunshine', ar: 'إشراق', tr: 'Ishrāq' });
      expect(s.sunrise.tag).toBeTruthy();
      expect(s.ishraq.tag).toBeTruthy();
    });

    it('gives both scenes the same top-title size and position', () => {
      const s = MediaService.MORNING_SCENES;
      expect(s.ishraq.titleY).toBe(s.sunrise.titleY);
      expect(s.ishraq.titleSize).toBe(s.sunrise.titleSize);
    });

    it.each(['sunrise', 'ishraq'])('renders a real PNG caption for %s', (scene) => {
      const buf = MediaService.renderSceneCaption(scene);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG magic bytes
    });

    // The still caption must be looped into a continuous stream, or the timed
    // fade-in leaves a single transparent frame at t=0 and the text never shows.
    it('loops a caption PNG input and overlays it onto [v] -> [vout]', () => {
      service.encodeSceneClip('/tmp/gen/sunrise.mp4', 'sunrise', { durationSec: 12 });
      const call = ffmpeg.mock.results[0].value;
      expect(call.input).toHaveBeenCalledWith(expect.stringContaining('.caption-sunrise.png'));
      expect(call.inputOptions).toHaveBeenCalledWith(['-loop 1']);

      const graph = call.complexFilter.mock.calls[0][0];
      expect(graph.some((f) => f.includes('[0:v]format=rgba,fade=t=in'))).toBe(true);
      expect(graph.some((f) => f.includes('[v][cap]overlay') && f.includes('[vout]'))).toBe(true);
      expect(call.outputOptions.mock.calls[0][0]).toContain('-map [vout]');
    });

    it('writes the caption sidecar next to the clip', () => {
      service.encodeSceneClip('/tmp/gen/ishraq.mp4', 'ishraq', {});
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.caption-ishraq.png'), expect.any(Buffer));
    });

    // The caption is decorative: a canvas/font failure must degrade to the
    // caption-less clip, not lose the clip entirely.
    it('falls back to a caption-less clip if rendering fails', () => {
      const spy = jest.spyOn(MediaService, 'renderSceneCaption').mockImplementation(() => {
        throw new Error('canvas unavailable');
      });
      try {
        service.encodeSceneClip('/tmp/gen/sunrise.mp4', 'sunrise', { durationSec: 12 });
        const call = ffmpeg.mock.results[0].value;
        expect(call.input).not.toHaveBeenCalled();          // no caption input
        expect(call.outputOptions.mock.calls[0][0]).toContain('-map [v]'); // base video
        const graph = call.complexFilter.mock.calls[0][0];
        expect(graph.some((f) => f.includes('overlay') && f.includes('[cap]'))).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
