const path = require('path');
const MediaService = require('./services/MediaService');
const CoreScheduler = require('./services/CoreScheduler');
const HardwareService = require('./services/HardwareService');
require('dotenv').config();

// --- CRASH DIAGNOSTICS (Production Stability) ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
  process.exit(1);
});

const CONFIG = {
  location: {
    city: process.env.LOCATION_CITY || 'CityName',
    country: process.env.LOCATION_COUNTRY || 'CountryCode',
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

// Global Services
const media = new MediaService();
const hardware = new HardwareService();

// THE SCHEDULER: Now standalone and self-sufficient
const scheduler = new CoreScheduler(
  CONFIG,
  hardware, 
  media,
  null, // No global cast/scanner
  path.join(__dirname, 'annual_schedule.json')
);

async function bootSystem() {
  console.log('🚀 Booting Adhan System...');
  
  // 1. Sync Cache
  const audioDirPath = path.join(__dirname, 'audio');
  await media.cacheAudioSources(CONFIG, audioDirPath);
  console.log('✅ Audio cache synced.');

  // 2. Start Media Server (Express)
  const express = require('express');
  const app = express();
  app.use('/audio', express.static(audioDirPath));
  app.use('/images', express.static(path.join(__dirname, '..', 'images')));
  
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', version: '2.5.0' });
  });

  const server = app.listen(CONFIG.serverPort, () => {
    console.log(`🔊 Media Server running on port ${CONFIG.serverPort}`);
  });

  // PRE-RELEASE SMOKE TEST
  if (process.argv.includes('--smoke')) {
     console.log('💨 SMOKE TEST: Startup successful.');
     server.close();
     process.exit(0);
  }

  // 3. Initiate Scheduler Flow
  console.log('⏳ Awaiting schedules...');
  await new Promise(r => setTimeout(r, 5000));
  await scheduler.scheduleToday();

  // Daily Refresh
  const schedule = require('node-schedule');
  schedule.scheduleJob('0 1 * * *', () => scheduler.scheduleToday());
  
  // SYSTEM TEST MODE
  if (process.argv.includes('--test')) {
    const prayers = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
    const forcedReq = process.argv.find((arg) => prayers.includes(arg.toLowerCase()));
    const testName = forcedReq ? forcedReq.charAt(0).toUpperCase() + forcedReq.slice(1).toLowerCase() : 'Isha';
    
    CONFIG.device.targetVolume = 0.10;
    const testKey = testName === 'Fajr' ? CONFIG.audio.fajrCurrent : CONFIG.audio.regularCurrent;
    const testAudio = `${testKey}.mp3`;

    console.log(`🧪 SYSTEM TEST: ${testName}`);
    setTimeout(() => scheduler.executePreFlightAndCast(testName, testAudio, null), 2000);
  }
}

if (require.main === module) {
  bootSystem();
}
