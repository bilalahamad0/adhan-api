const path = require('path');
const { DateTime } = require('luxon');
const MediaService = require('./services/MediaService');
const CoreScheduler = require('./services/CoreScheduler');
const HardwareService = require('./services/HardwareService');
const PlaybackLogger = require('./services/PlaybackLogger');
const FirestoreSync = require('./services/FirestoreSync');
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
const playbackDataDir = process.env.PLAYBACK_DATA_DIR
  || path.join(process.env.HOME || __dirname, '.adhan-data');
const playbackLogger = new PlaybackLogger(
  playbackDataDir,
  CONFIG.timezone
);
const firestoreSync = new FirestoreSync(
  process.env.FIREBASE_SERVICE_KEY,
  CONFIG.timezone,
  path.join(__dirname, 'annual_schedule.json'),
);

// THE SCHEDULER: Now standalone and self-sufficient
const scheduler = new CoreScheduler(
  CONFIG,
  hardware, 
  media,
  null, // No global cast/scanner
  path.join(__dirname, 'annual_schedule.json'),
  playbackLogger
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
  app.use(express.json());
  app.use('/audio', express.static(audioDirPath));
  app.use('/images', express.static(path.join(__dirname, '..', 'images')));
  
  app.get('/health', (req, res) => {
    let buildInfo = null;
    try {
      const dataDir = process.env.PLAYBACK_DATA_DIR
        || path.join(process.env.HOME || __dirname, '.adhan-data');
      const buildInfoPath = path.join(dataDir, 'build-info.json');
      if (require('fs').existsSync(buildInfoPath)) {
        buildInfo = JSON.parse(require('fs').readFileSync(buildInfoPath, 'utf8'));
      }
    } catch { /* missing or unreadable build-info is non-fatal */ }
    res.status(200).json({
      status: 'OK',
      version: buildInfo?.currentVersion || 'unmanaged',
      shortSha: buildInfo?.currentShortSha || null,
      deployedAt: buildInfo?.currentDeployedAt || null,
    });
  });

  // Metrics API: local access to playback data
  app.get('/api/metrics', (req, res) => {
    try {
      const range = parseInt(req.query.days) || 30;
      const data = playbackLogger.getMultiDaySummary(range);
      res.status(200).json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/metrics/today', (req, res) => {
    try {
      const data = playbackLogger.getDailySummary();
      res.status(200).json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/trigger/prayer', async (req, res) => {
    try {
      const rawPrayer = String(req.query.prayer || req.body?.prayer || '').trim().toLowerCase();
      const allowed = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
      if (!allowed.includes(rawPrayer)) {
        res.status(400).json({ error: 'Invalid prayer. Use fajr|dhuhr|asr|maghrib|isha' });
        return;
      }

      const prayerName = rawPrayer.charAt(0).toUpperCase() + rawPrayer.slice(1);
      const schedulePath = path.join(__dirname, 'annual_schedule.json');
      if (!require('fs').existsSync(schedulePath)) {
        res.status(500).json({ error: 'annual_schedule.json missing' });
        return;
      }

      const annualData = JSON.parse(require('fs').readFileSync(schedulePath));
      const today = DateTime.now().setZone(CONFIG.timezone);
      const monthData = annualData?.data?.[today.month.toString()];
      const todayEntry = Array.isArray(monthData)
        ? monthData.find((d) => parseInt(d?.date?.gregorian?.day, 10) === today.day)
        : null;
      if (!todayEntry) {
        res.status(500).json({ error: 'No schedule entry found for today' });
        return;
      }

      const timing = String(todayEntry?.timings?.[prayerName] || '').split(' ')[0];
      const [hourStr, minuteStr] = timing.split(':');
      const hour = parseInt(hourStr, 10);
      const minute = parseInt(minuteStr, 10);
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
        res.status(500).json({ error: `Invalid schedule time for ${prayerName}: ${timing}` });
        return;
      }

      const scheduledPrayerTime = today.set({ hour, minute, second: 0, millisecond: 0 });
      const audioKey = prayerName === 'Fajr' ? CONFIG.audio.fajrCurrent : CONFIG.audio.regularCurrent;
      const audioFile = `${audioKey}.mp3`;

      // Immediate production trigger while preserving scheduled prayer time in logs/dashboard.
      const immediateTargetTime = {
        toFormat: (fmt) => scheduledPrayerTime.toFormat(fmt),
        toMillis: () => Date.now(),
      };

      scheduler.executePreFlightAndCast(prayerName, audioFile, immediateTargetTime, todayEntry)
        .catch((e) => console.error('[manual-trigger] Execution failed:', e.message));

      res.status(202).json({
        status: 'triggered',
        mode: 'production-manual',
        prayer: prayerName,
        scheduledTime: scheduledPrayerTime.toFormat('HH:mm'),
        audioFile,
        targetVolume: CONFIG.device.targetVolume,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/metrics/sync', async (req, res) => {
    try {
      await firestoreSync.forceSync(playbackLogger);
      const today = DateTime.now().setZone(CONFIG.timezone).toISODate();
      const sum = firestoreSync.scheduleSummaryForDate(today);
      res.status(200).json({
        status: 'synced',
        deviceToday: sum.date,
        prayersScheduled: sum.prayersScheduled,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/metrics/sync-date', async (req, res) => {
    try {
      const date = String(req.query.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });
        return;
      }
      const synced = await firestoreSync.syncDate(playbackLogger, date, { updateLatest: false });
      res.status(200).json({ status: synced ? 'synced' : 'skipped', date });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/metrics/backfill', async (req, res) => {
    try {
      const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
      await firestoreSync.backfillRecentDays(playbackLogger, days);
      res.status(200).json({ status: 'backfill-complete', days });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/metrics/dedupe-day', async (req, res) => {
    try {
      const date = String(req.query.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });
        return;
      }
      const uniquePrayers = playbackLogger.dedupeDayForDate(date);
      await firestoreSync.syncDate(playbackLogger, date, { updateLatest: false });
      res.status(200).json({ status: 'deduped', date, uniquePrayers });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/metrics/repair-event', async (req, res) => {
    try {
      const body = req.body || {};
      const date = String(body.date || '').trim();
      const prayer = String(body.prayer || '').trim();
      const status = String(body.status || 'PLAYED').trim().toUpperCase();

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });
        return;
      }
      if (!prayer) {
        res.status(400).json({ error: 'prayer is required' });
        return;
      }
      if (!['PLAYED', 'RECOVERED', 'FAILED', 'PENDING'].includes(status)) {
        res.status(400).json({ error: 'Invalid status' });
        return;
      }

      const nowIso = new Date().toISOString();
      const event = {
        date,
        prayer: prayer.charAt(0).toUpperCase() + prayer.slice(1).toLowerCase(),
        scheduledTime: body.scheduledTime || null,
        triggerTime: body.triggerTime || nowIso,
        playbackStartTime: body.playbackStartTime || nowIso,
        completedTime: body.completedTime || nowIso,
        status,
        triggerLatencyMs: Number.isFinite(Number(body.triggerLatencyMs))
          ? Number(body.triggerLatencyMs)
          : null,
        encodingDurationMs: Number.isFinite(Number(body.encodingDurationMs))
          ? Number(body.encodingDurationMs)
          : null,
        discoveryDurationMs: Number.isFinite(Number(body.discoveryDurationMs))
          ? Number(body.discoveryDurationMs)
          : null,
        recoveryAttempts: Number.isFinite(Number(body.recoveryAttempts))
          ? Number(body.recoveryAttempts)
          : (status === 'RECOVERED' ? 1 : 0),
        auditResult: body.auditResult || (status === 'FAILED' ? 'FAIL' : 'PASS'),
        failureReason: body.failureReason || null,
        usedFallback: Boolean(body.usedFallback),
        deviceName: body.deviceName || CONFIG.device.name,
      };

      playbackLogger.upsertHistoricalEvent(event);
      await firestoreSync.syncDate(playbackLogger, date, { updateLatest: false, allowEmpty: false });
      res.status(200).json({ status: 'repaired', date, prayer: event.prayer });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
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
      check(
        'Weather Data',
        weather && weather.temp && /\d/.test(String(weather.temp)),
        `Got: ${JSON.stringify(weather)}`
      );
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

    // 9. Module integrity — every service still requires cleanly.
    const SERVICE_MODULES = [
      './services/CoreScheduler', './services/MediaService', './services/HardwareService',
      './services/PlaybackLogger', './services/FirestoreSync', './services/ScheduleService',
      './services/CastService', './services/DiscoveryService',
      './services/BuildManager', './services/SmokeRunner',
      './auto_updater',
    ];
    for (const mod of SERVICE_MODULES) {
      try {
        // auto_updater installs schedules on require; skip require, just resolve.
        if (mod === './auto_updater') {
          require.resolve(mod);
        } else {
          require(mod);
        }
        check(`Module loads: ${mod}`, true);
      } catch (e) {
        check(`Module loads: ${mod}`, false, e.message);
      }
    }
    try {
      require('chromecast-api/lib/device');
      check('chromecast-api/lib/device import', true);
    } catch (e) {
      check('chromecast-api/lib/device import', false, e.message);
    }

    // 10. Hermetic system probes (no casting, no extra network).
    const which = (bin) => {
      try { require('child_process').execSync(`which ${bin}`, { stdio: 'ignore' }); return true; }
      catch { return false; }
    };
    const isLinux = process.platform === 'linux';
    check('which adb', isLinux ? which('adb') : true, 'adb binary missing in PATH (Pi-only)');
    check('which ffmpeg', which('ffmpeg'), 'ffmpeg binary missing in PATH');
    check('which ffprobe', which('ffprobe'), 'ffprobe binary missing in PATH');

    try {
      const dataDir = process.env.PLAYBACK_DATA_DIR
        || path.join(process.env.HOME || __dirname, '.adhan-data');
      if (!require('fs').existsSync(dataDir)) require('fs').mkdirSync(dataDir, { recursive: true });
      const stat = require('child_process').execSync(`df -k ${dataDir} | tail -1 | awk '{print $4}'`).toString().trim();
      const freeKb = parseInt(stat, 10) || 0;
      check('Disk free > 500MB on data partition', freeKb > 500 * 1024, `${Math.round(freeKb / 1024)}MB free`);
    } catch (e) {
      check('Disk free > 500MB on data partition', false, e.message);
    }

    try {
      const cachePath = path.join(__dirname, '.cast-cache.smoke.json');
      const sample = { friendlyName: 'smoke', host: '127.0.0.1', port: 8009 };
      require('fs').writeFileSync(cachePath, JSON.stringify(sample));
      const back = JSON.parse(require('fs').readFileSync(cachePath, 'utf8'));
      require('fs').unlinkSync(cachePath);
      check('Cast cache round-trip', back.host === sample.host);
    } catch (e) {
      check('Cast cache round-trip', false, e.message);
    }

    try {
      const dataDir = process.env.PLAYBACK_DATA_DIR
        || path.join(process.env.HOME || __dirname, '.adhan-data');
      const logPath = path.join(dataDir, 'playback_log.json');
      if (require('fs').existsSync(logPath)) {
        JSON.parse(require('fs').readFileSync(logPath, 'utf8'));
        check('playback_log.json parses', true);
      } else {
        check('playback_log.json parses (or missing)', true, 'file does not exist yet');
      }
    } catch (e) {
      check('playback_log.json parses', false, e.message);
    }

    // 11. Critical env-var presence (presence only — values never logged).
    const REQUIRED_ENV = ['TV_IP', 'DEVICE_NAME', 'LOCATION_CITY', 'LOCATION_COUNTRY', 'TIMEZONE', 'FIREBASE_SERVICE_KEY'];
    for (const key of REQUIRED_ENV) {
      check(`env: ${key} present`, !!process.env[key], `${key} unset`);
    }

    // 12. Privacy linter — proposed meta/build payload must not contain any
    // env value longer than 4 chars. Refuses to publish if it would leak.
    try {
      const BuildManager = require('./services/BuildManager');
      const fakePayload = {
        currentVersion: 'v0000.00.00-test.0',
        currentShortSha: '0000000',
        currentDeployedAt: new Date().toISOString(),
        currentChangePriority: 'low',
        previousVersion: null,
        previousShortSha: null,
        lastSuccessfulSmoke: { passed: 0, failed: 0, ts: new Date().toISOString() },
        lastFailure: null,
      };
      const verdict = BuildManager.assertPrivacy(fakePayload, process.env);
      check('Privacy linter: meta/build payload', verdict.ok, verdict.reason || '');
    } catch (e) {
      check('Privacy linter: meta/build payload', false, e.message);
    }

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

  async function refreshScheduleAndPublishFirestore() {
    await scheduler.scheduleToday();
    const today = DateTime.now().setZone(CONFIG.timezone);
    const todayIso = today.toISODate();
    await firestoreSync.ensureTodayScheduleOnFirestore(todayIso);

    // Schedule publishing tomorrow's schedule at Maghrib + 5 minutes
    const tomorrowIso = today.plus({ days: 1 }).toISODate();
    try {
      const schedPath = path.join(__dirname, 'annual_schedule.json');
      const annualData = JSON.parse(require('fs').readFileSync(schedPath));
      const monthData = annualData.data[today.month.toString()];
      const todayEntry = monthData ? monthData.find(d => parseInt(d.date.gregorian.day) === today.day) : null;
      
      if (todayEntry && todayEntry.timings && todayEntry.timings['Maghrib']) {
        const timeStr = todayEntry.timings['Maghrib'].split(' ')[0];
        const [hours, minutes] = timeStr.split(':');
        const maghribTime = today.set({ hour: parseInt(hours), minute: parseInt(minutes), second: 0 });
        const publishTime = maghribTime.plus({ minutes: 5 });
        
        if (publishTime <= DateTime.now().setZone(CONFIG.timezone)) {
          // Already past Maghrib+5 today, publish immediately
          await firestoreSync.ensureNextDayScheduleOnFirestore(tomorrowIso);
        } else {
          // Schedule it for later today
          const schedule = require('node-schedule');
          schedule.scheduleJob(publishTime.toJSDate(), () => {
            firestoreSync.ensureNextDayScheduleOnFirestore(tomorrowIso).catch(e => {
              console.error('[boot] Next day publish failed:', e.message);
            });
          });
          console.log(`📅 Scheduled next-day schedule publish for ${publishTime.toFormat('HH:mm:ss')}`);
        }
      } else {
        // Fallback: publish immediately if can't find Maghrib time
        await firestoreSync.ensureNextDayScheduleOnFirestore(tomorrowIso);
      }
    } catch (e) {
      console.error('[boot] Failed to schedule next-day publish:', e.message);
      await firestoreSync.ensureNextDayScheduleOnFirestore(tomorrowIso);
    }
  }

  await refreshScheduleAndPublishFirestore();

  // Daily refresh at civil midnight in prayer timezone (avoids OS-local vs TIMEZONE skew around DST).
  const schedule = require('node-schedule');
  const dailyScheduleRule = new schedule.RecurrenceRule();
  dailyScheduleRule.hour = 0;
  dailyScheduleRule.minute = 0;
  dailyScheduleRule.tz = CONFIG.timezone;
  schedule.scheduleJob(dailyScheduleRule, () => {
    refreshScheduleAndPublishFirestore().catch((e) => {
      console.error('[boot] Daily schedule refresh failed:', e.message);
    });
  });

  // Direct Firestore sync (daily at 23:55 + debounced after each prayer)
  schedule.scheduleJob('55 23 * * *', () => firestoreSync.forceSync(playbackLogger));
  // Fallback reconciliation: resync last 7 days once daily.
  schedule.scheduleJob('10 0 * * *', () => firestoreSync.backfillRecentDays(playbackLogger, 7));
  const origFinalize = playbackLogger._finalizeEvent.bind(playbackLogger);
  playbackLogger._finalizeEvent = function (key) {
    origFinalize(key);
    setTimeout(() => firestoreSync.syncNow(playbackLogger), 5000);
  };

  // SYSTEM TEST MODE (hermetic): schedule resolve → image gen → audio probe
  // → encode to a temp file. Never calls device.play(). Auto-updater uses
  // this; humans use --test for the real cast.
  if (process.argv.includes('--system-test')) {
    console.log('🧪 SYSTEM TEST (hermetic, no cast):');
    let st_passed = 0, st_failed = 0;
    const stCheck = (name, ok, detail = '') => {
      if (ok) { console.log(`  ✅ ${name}`); st_passed++; }
      else { console.log(`  ❌ FAIL: ${name}${detail ? ' — ' + detail : ''}`); st_failed++; }
    };
    try {
      const fs = require('fs');
      const today = DateTime.now().setZone(CONFIG.timezone);
      const annualPath = path.join(__dirname, 'annual_schedule.json');
      const annualData = JSON.parse(fs.readFileSync(annualPath, 'utf8'));
      const monthData = annualData.data[today.month.toString()];
      const todayEntry = monthData.find(d => parseInt(d.date.gregorian.day) === today.day);
      stCheck('Schedule resolve (today entry)', !!todayEntry);

      const VisualGenerator = require('./visual_generator.js');
      const vg = new VisualGenerator(CONFIG);
      const h = todayEntry ? todayEntry.date.hijri : null;
      const hijriDate = h ? `${h.day} ${h.month.en} ${h.year}` : null;
      const imgBuffer = await vg.generateDashboard('Isha', '8:56 PM', hijriDate, { holidays: [], isFriday: false });
      stCheck('Image generation', imgBuffer && imgBuffer.length > 10000);

      const tmpDir = require('os').tmpdir();
      const tmpImg = path.join(tmpDir, 'systemtest.jpg');
      fs.writeFileSync(tmpImg, imgBuffer);
      const audioFile = path.join(__dirname, 'audio', `${CONFIG.audio.regularCurrent}.mp3`);
      stCheck('Audio file present', fs.existsSync(audioFile));

      const dur = await media.getMediaDuration(audioFile);
      stCheck('Audio probe (ffprobe)', dur != null && dur > 0, `duration=${dur}`);

      const tmpVideo = path.join(tmpDir, 'systemtest.mp4');
      const { promise } = media.encodeVideoFromImageAndAudio(tmpImg, audioFile, tmpVideo, 0);
      await promise;
      const stat = fs.existsSync(tmpVideo) ? fs.statSync(tmpVideo) : null;
      stCheck('Encode produces non-empty mp4', stat && stat.size > 1000, `size=${stat?.size}`);
      try { fs.unlinkSync(tmpVideo); fs.unlinkSync(tmpImg); } catch { /* ignore */ }
    } catch (e) {
      stCheck('System test exception', false, e.message);
    }

    console.log(`\n🧪 SYSTEM TEST COMPLETE: ${st_passed} passed, ${st_failed} failed.`);
    server.close();
    process.exit(st_failed > 0 ? 1 : 0);
  }

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
