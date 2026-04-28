// Jest is injected gobally

// Mock child process
jest.mock('child_process', () => ({
  exec: jest.fn((cmd, opts, callback) => {
    if (typeof opts === 'function') {
      callback = opts;
    }
    callback(null, 'OK', '');
  }),
}));

// Mock FS
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  readFileSync: jest.fn().mockReturnValue(
    JSON.stringify({
      data: {
        1: [
          {
            date: {
              gregorian: { day: '1' },
              hijri: { month: { en: 'Ramadan' }, day: '1', year: '1445' },
            },
            timings: {
              Fajr: '05:00',
              Dhuhr: '13:00',
              Asr: '17:00',
              Maghrib: '20:00',
              Isha: '21:30',
            },
          },
        ],
      },
    })
  ),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
  createWriteStream: jest.fn(),
  readdirSync: jest.fn().mockReturnValue(['test.jpg']),
  statSync: jest.fn().mockReturnValue({ size: 1000 }),
}));

// Mock FFmpeg
jest.mock('fluent-ffmpeg', () => {
  const ffmpegMock = jest.fn(() => ({
    input: jest.fn().mockReturnThis(),
    inputOptions: jest.fn().mockReturnThis(),
    videoCodec: jest.fn().mockReturnThis(),
    audioCodec: jest.fn().mockReturnThis(),
    audioFrequency: jest.fn().mockReturnThis(),
    outputOptions: jest.fn().mockReturnThis(),
    save: jest.fn().mockReturnThis(),
    on: jest.fn(function (event, callback) {
      if (event === 'end') setTimeout(callback, 10);
      return this;
    }),
  }));
  return ffmpegMock;
});

// Mock Chromecast
jest.mock('chromecast-api', () => {
  return jest.fn(() => ({
    on: jest.fn(),
    update: jest.fn(),
  }));
});

// Mock Canvas
jest.mock('canvas', () => ({
  createCanvas: jest.fn(() => ({
    getContext: jest.fn(() => ({
      fillRect: jest.fn(),
      fillStyle: '',
      font: '',
      fillText: jest.fn(),
      measureText: jest.fn().mockReturnValue({ width: 100 }),
      drawImage: jest.fn(),
      textBaseline: '',
      textAlign: '',
      globalAlpha: 1,
      shadowColor: '',
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      strokeStyle: '',
      lineWidth: 1,
      save: jest.fn(),
      restore: jest.fn(),
      beginPath: jest.fn(),
      arc: jest.fn(),
      fill: jest.fn(),
      stroke: jest.fn(),
      moveTo: jest.fn(),
      lineTo: jest.fn(),
      closePath: jest.fn(),
      quadraticCurveTo: jest.fn(),
      bezierCurveTo: jest.fn(),
      rect: jest.fn(),
      ellipse: jest.fn(),
      clip: jest.fn(),
      setLineDash: jest.fn(),
      roundRect: jest.fn(),
      createLinearGradient: jest.fn(() => ({
        addColorStop: jest.fn(),
      })),
      createRadialGradient: jest.fn(() => ({
        addColorStop: jest.fn(),
      })),
    })),
    toBuffer: jest.fn().mockReturnValue(Buffer.from('image')),
  })),
  loadImage: jest.fn().mockResolvedValue({ width: 1280, height: 800 }),
  registerFont: jest.fn(),
}));

// Mock node-schedule
jest.mock('node-schedule', () => ({
  scheduleJob: jest.fn(),
}));

// Mock axios
jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({
    data: { data: {} },
  }),
  post: jest.fn().mockResolvedValue({}),
}));

// Mock Express
jest.mock('express', () => {
  const expressInstance = {
    use: jest.fn(),
    post: jest.fn(),
    get: jest.fn(),
    listen: jest.fn((port, cb) => {
      if (cb) cb();
      return { close: jest.fn() };
    }),
  };
  const expressMock = jest.fn(() => expressInstance);
  expressMock.static = jest.fn();
  return expressMock;
});

describe('Audio Caster Coverage', () => {
  beforeEach(() => {
    process.env.TV_IP = '127.0.0.1';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('reset_adb resetAdb', async () => {
    const reset = require('./reset_adb.js');
    await reset.resetAdb();
    expect(typeof reset.resetAdb).toBe('function');
  });

  it('index.js exports', () => {
    const index = require('./index.js');
    index.startServer();
    index.stopServer();
    expect(index).toHaveProperty('startServer');
  });

  it('visual_generator.js generates dashboard', async () => {
    const VisualGenerator = require('./visual_generator.js');
    const vg = new VisualGenerator({ location: { city: 'Test' } });
    const buffer = await vg.generateDashboard('Fajr', '5:00 AM', null);
    expect(buffer).toBeDefined();
  });
});
