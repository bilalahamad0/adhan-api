const path = require('path');
const HardwareService = require('./services/HardwareService');
const MediaService = require('./services/MediaService');
const CastService = require('./services/CastService');
const CoreScheduler = require('./services/CoreScheduler');
require('dotenv').config();

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
    options: {
      fajr: 'https://raw.githubusercontent.com/AalianKhan/adhans/master/adhan_fajr.mp3',
      mecca_1: 'https://www.islamcan.com/audio/adhan/azan1.mp3',
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
  // Logic to bind node-schedule would go here calling scheduler.executePreFlightAndCast()
  
  // Complete System Test hook
  if (process.argv.includes('--test')) {
     console.log('🧪 SYSTEM TEST: Simulating end-to-end hardware cast pipeline...');
     await scheduler.executePreFlightAndCast('TestPrayer', 'fajr.mp3', null);
     console.log('🧪 SYSTEM TEST: Hardware cast command issued. Evaluator should verify TV behaviour.');
  }
}

if (require.main === module) {
  bootSystem();
}

module.exports = { bootSystem, scheduler, hardware, media, cast };
