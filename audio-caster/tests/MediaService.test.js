const MediaService = require('../services/MediaService');
const fs = require('fs');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');

jest.mock('fs');
jest.mock('axios');
jest.mock('fluent-ffmpeg');

describe('MediaService', () => {
  let service;

  beforeEach(() => {
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
      videoCodec: jest.fn().mockReturnThis(),
      audioCodec: jest.fn().mockReturnThis(),
      audioFrequency: jest.fn().mockReturnThis(),
      outputOptions: jest.fn().mockReturnThis(),
      save: jest.fn().mockReturnThis(),
      on: jest.fn().mockImplementation(function (event, cb) {
        if (event === 'end') cb();
        return this;
      }),
    };
    ffmpeg.mockImplementation(() => mockFFmpeg);

    const result = await service.encodeVideoFromImageAndAudio('img.jpg', 'aud.mp3', 'out.mp4');
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
});
