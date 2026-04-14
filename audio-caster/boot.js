const path = require('path');
const MediaService = require('./services/MediaService');
const CoreScheduler = require('./services/CoreScheduler');
const HardwareService = require('./services/HardwareService');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

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
    lat: process.env.LATITUDE || null,
    lon: process.env.LONGITUDE || null,
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
    console.log('💨 SMOKE TEST: Running production readiness checks...');
    let passed = 0;
    let failed = 0;

    const check = (name, condition, detail = '') => {
      if (condition) { console.log(`  ✅ ${name}`); passed++; }
      else { console.log(`  ❌ FAIL: ${name}${detail ? ' — ' + detail : ''}`); failed++; }
    };

    // 1. Media server running
    check('Media Server', server.listening, 'Server not started');

    // 2. Annual schedule file exists and has current year
    const schedPath = path.join(__dirname, 'annual_schedule.json');
    let annualData = null;
    let testScheduleEntry = null;
    try {
      annualData = JSON.parse(require('fs').readFileSync(schedPath));
      const currentYear = require('luxon').DateTime.now().setZone(CONFIG.timezone).toFormat('yyyy');
      check('Annual Schedule Year', annualData.year === currentYear, `File has year=${annualData.year}, expected=${currentYear}`);
      const today = require('luxon').DateTime.now().setZone(CONFIG.timezone);
      const monthData = annualData.data[today.month.toString()];
      testScheduleEntry = monthData ? monthData.find(d => parseInt(d.date.gregorian.day) === today.day) : null;
      check('Today Schedule Entry', !!testScheduleEntry, 'No entry for today in schedule');
    } catch (e) {
      check('Annual Schedule File', false, e.message);
    }

    // 3. Verify Hijri date extraction
    if (testScheduleEntry) {
      try {
        const h = testScheduleEntry.date.hijri;
        const hijriDate = `${h.day} ${h.month.en} ${h.year}`;
        check('Hijri Date Extraction', hijriDate.length > 5, `Got: "${hijriDate}"`);
      } catch (e) {
        check('Hijri Date Extraction', false, e.message);
      }
    }

    // 4. Dashboard generation round-trip (Hijri + Weather)
    try {
      const VisualGenerator = require('./visual_generator.js');
      const vg = new VisualGenerator(CONFIG);
      const h = testScheduleEntry ? testScheduleEntry.date.hijri : null;
      const hijriDate = h ? `${h.day} ${h.month.en} ${h.year}` : null;
      const today = require('luxon').DateTime.now().setZone(CONFIG.timezone);
      const isFriday = today.weekday === 5;
      const imgBuffer = await vg.generateDashboard('Isha', '8:56 PM', hijriDate, { holidays: [], isFriday });
      check('Dashboard Generation', imgBuffer && imgBuffer.length > 10000, `Buffer size: ${imgBuffer?.length}`);
      check('Hijri in Dashboard', hijriDate !== null, 'hijriDate was null — Hijri calendar will be BLANK');

      // 5. Weather check (non-null temp)
      const weather = await vg.getWeather();
      check('Weather Data', weather && weather.temp && !weather.temp.startsWith('--'), `Got: ${JSON.stringify(weather)}`);
      check('Weather Icon', !!vg.getWeatherIcon(weather.code, weather.isDay), 'No icon returned');
    } catch (e) {
      check('Dashboard Generation', false, e.message);
    }

    // 6. Audio files cached
    const audioDirPath = path.join(__dirname, 'audio');
    const audioKey = CONFIG.audio.regularCurrent;
    const audioFilePath = path.join(audioDirPath, `${audioKey}.mp3`);
    check('Audio File Cached', require('fs').existsSync(audioFilePath), `Missing: ${audioFilePath}`);

    // 7. TV_IP configured
    check('TV_IP Configured', !!process.env.TV_IP, 'TV_IP not set in .env');

    // 8. Device name configured
    check('Device Name', !!CONFIG.device.name && CONFIG.device.name !== 'Google Display' || !!process.env.DEVICE_NAME, 'DEVICE_NAME not set, using default');

    console.log(`\n💨 SMOKE TEST COMPLETE: ${passed} passed, ${failed} failed.`);
    if (failed > 0) {
      console.error(`\n❌ ${failed} CHECKPOINT(S) FAILED. DO NOT DEPLOY TO PRODUCTION.\n`);
      server.close();
      process.exit(1);
    } else {
      console.log(`\n✅ All checkpoints passed. Safe to deploy.\n`);
      server.close();
      process.exit(0);
    }
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
