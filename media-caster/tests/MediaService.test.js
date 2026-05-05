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
});
