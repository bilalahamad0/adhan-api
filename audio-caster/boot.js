const path = require('path');
const HardwareService = require('./services/HardwareService');
const MediaService = require('./services/MediaService');
const CastService = require('./services/CastService');
const CoreScheduler = require('./services/CoreScheduler');
require('dotenv').config();

// --- CRASH DIAGNOSTICS (Production Stability) ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
  // PM2 will restart the process automatically
  process.exit(1);
});

const CONFIG = {
  location: {
    city: process.env.LOCATION_CITY || 'Sunnyvale',
    country: process.env.LOCATION_COUNTRY || 'US',
    method: parseInt(process.env.LOCATION_METHOD || 2), // ISNA
    school: parseInt(process.env.LOCATION_SCHOOL || 1), // Hanafi
  },
  device: {
    name: process.env.DEVICE_NAME || 'Google Display',
    targetVolume: 0.55,
  },
  audio: {
    fajrCurrent: 'fajr',
    regularCurrent: 'generic_3',
    options: {
      fajr: "https://raw.githubusercontent.com/AalianKhan/adhans/master/adhan_fajr.mp3",
      mecca_1: "https://www.islamcan.com/audio/adhan/azan1.mp3",
      mecca_2: "https://www.islamcan.com/audio/adhan/azan3.mp3",
      generic_1: "https://www.islamcan.com/audio/adhan/azan4.mp3",
      generic_2: "https://www.islamcan.com/audio/adhan/azan5.mp3",
      generic_3: "https://www.islamcan.com/audio/adhan/azan6.mp3",
      generic_4: "https://www.islamcan.com/audio/adhan/azan7.mp3",
    },
  },
  timezone: process.env.TIMEZONE || 'America/Los_Angeles',
  serverPort: parseInt(process.env.SERVER_PORT || 3001),
};

// Assembly
const hardware = new HardwareService();
const media = new MediaService();
const cast = new CastService();
const scheduler = new CoreScheduler(
  CONFIG,
  hardware,
  media,
  cast,
  path.join(__dirname, 'annual_schedule.json')
);

async function bootSystem() {
  console.log('🚀 Booting Adhan System with Modular Architecture...');

  // 1. Cache Default Media
  const audioDirPath = path.join(__dirname, 'audio');
  await media.cacheAudioSources(CONFIG, audioDirPath);
  console.log('✅ Audio cache synced.');

  // 2. Load Web Server (Static + API)
  const express = require('express');
  const app = express();
  app.use('/audio', express.static(audioDirPath));
  app.use('/images', express.static(path.join(__dirname, '..', 'images')));
  
  // Health endpoint for Post-Release Sanity Testing
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', version: '2.0.0', module: 'audio-caster' });
  });

  const server = app.listen(CONFIG.serverPort, () => {
    console.log(`🔊 Media Server running on port ${CONFIG.serverPort}`);
  });

  // Pre-Release Smoke Test hook
  if (process.argv.includes('--smoke')) {
     console.log('💨 SMOKE TEST: Startup successful. Environment configuration bound correctly.');
     console.log('💨 SMOKE TEST: Shutting down safely...');
     server.close();
     process.exit(0);
  }

  // 3. Initiate Scheduler Flow
  console.log('⏳ Awaiting schedules...');
  // Post-Boot Grace Period (Ensures network is 100% ready after a Pi reboot)
  await new Promise(r => setTimeout(r, 5000));
  await scheduler.scheduleToday();

  // Daily Refresh at 1 AM
  const schedule = require('node-schedule');
  schedule.scheduleJob('0 1 * * *', () => scheduler.scheduleToday());
  
  // Complete System Test hook
  if (process.argv.includes('--test')) {
    console.log('🧪 SYSTEM TEST: Simulating end-to-end hardware cast pipeline...');
    
    // OVERRIDE: Use lower volume for tests (10%)
    CONFIG.device.targetVolume = 0.10;

    // Allow forcing specific prayer via args (e.g. node boot.js --test Maghrib)
    const prayers = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
    const forcedReq = process.argv.find((arg) => prayers.includes(arg.toLowerCase()));
    
    // Fallback to Isha if no valid arg was found
    const testName = forcedReq
      ? forcedReq.charAt(0).toUpperCase() + forcedReq.slice(1).toLowerCase()
      : 'Isha';

    const testKey = testName === 'Fajr' ? CONFIG.audio.fajrCurrent : CONFIG.audio.regularCurrent;
    const testAudio = `${testKey}.mp3`;

    console.log(`🎯 Test Target: ${testName} (Volume: ${(CONFIG.device.targetVolume * 100).toFixed(0)}%)`);

    setTimeout(async () => {
      await scheduler.executePreFlightAndCast(testName, testAudio, null);
    }, 2000);
  }
}

if (require.main === module) {
  bootSystem();
}

module.exports = { bootSystem, scheduler, hardware, media, cast };
