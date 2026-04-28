const path = require('path');
const fs = require('fs');
const { DateTime } = require('luxon');
const schedule = require('node-schedule');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const BuildManager = require('./services/BuildManager');
const SmokeRunner = require('./services/SmokeRunner');
const FirestoreSync = require('./services/FirestoreSync');

const REPO_ROOT = path.resolve(__dirname, '..');
const STAGING_PATH = process.env.UPDATE_STAGING_PATH || '/tmp/adhan-staging';
const DATA_DIR = process.env.PLAYBACK_DATA_DIR
  || path.join(process.env.HOME || __dirname, '.adhan-data');
const BRANCH = process.env.UPDATE_TRACK_BRANCH || 'main';
const TIMEZONE = process.env.TIMEZONE || 'America/Los_Angeles';
const SCHEDULE_FILE = path.join(__dirname, 'annual_schedule.json');
const PER_PRAYER_LEAD_MIN = parseInt(process.env.UPDATE_LEAD_MIN || '20', 10);

const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

function log(msg) {
  console.log(`[${new Date().toISOString()}] [auto-updater] ${msg}`);
}

function loadTodayPrayerTimes() {
  if (!fs.existsSync(SCHEDULE_FILE)) return [];
  let annualData;
  try { annualData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); }
  catch { return []; }
  const today = DateTime.now().setZone(TIMEZONE);
  const monthData = annualData?.data?.[today.month.toString()];
  if (!Array.isArray(monthData)) return [];
  const entry = monthData.find((d) => parseInt(d?.date?.gregorian?.day, 10) === today.day);
  if (!entry) return [];
  const out = [];
  for (const p of PRAYERS) {
    const raw = entry?.timings?.[p];
    if (!raw) continue;
    const token = String(raw).trim().split(/\s+/)[0];
    const m = token.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) continue;
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    const dt = today.set({ hour, minute, second: 0, millisecond: 0 });
    out.push({ name: p, dt });
  }
  return out;
}

function upcomingPrayerWindows() {
  const now = DateTime.now().setZone(TIMEZONE);
  return loadTodayPrayerTimes()
    .filter((p) => p.dt >= now)
    .map((p) => ({ name: p.name, iso: p.dt.toISO() }));
}

const firestoreSync = new FirestoreSync(
  process.env.FIREBASE_SERVICE_KEY,
  TIMEZONE,
  SCHEDULE_FILE,
);

const smokeRunner = new SmokeRunner({ log });
const buildManager = new BuildManager({
  repoRoot: REPO_ROOT,
  stagingPath: STAGING_PATH,
  dataDir: DATA_DIR,
  branch: BRANCH,
  smokeRunner,
  firestoreSync,
  log,
  timezone: TIMEZONE,
  prayerWindowProvider: () => upcomingPrayerWindows(),
});

let activeJobs = [];

function cancelJobs() {
  for (const j of activeJobs) {
    try { j.cancel(); } catch { /* ignore */ }
  }
  activeJobs = [];
}

function scheduleTodaysJobs() {
  cancelJobs();
  const now = DateTime.now().setZone(TIMEZONE);
  const prayers = loadTodayPrayerTimes();
  for (const p of prayers) {
    const trigger = p.dt.minus({ minutes: PER_PRAYER_LEAD_MIN });
    if (trigger <= now) continue;
    const job = schedule.scheduleJob(trigger.toJSDate(), () => {
      runUpdateCycle(`pre-${p.name.toLowerCase()}`).catch((e) => log(`cycle error: ${e.message}`));
    });
    if (job) activeJobs.push(job);
    log(`scheduled pre-${p.name} update check at ${trigger.toFormat('HH:mm')} (${PER_PRAYER_LEAD_MIN} min before ${p.name})`);
  }
}

async function runUpdateCycle(triggerLabel, opts = {}) {
  if (fs.existsSync(path.join(REPO_ROOT, '.deploy-in-progress'))) {
    log(`SKIP [${triggerLabel}]: .deploy-in-progress sentinel present — operator intervention required`);
    return null;
  }
  log(`▶ update cycle [${triggerLabel}]`);
  const result = await buildManager.attemptUpdate(opts);
  log(`◀ update cycle [${triggerLabel}] → success=${result.success} stage=${result.stage} reason=${result.reason || 'n/a'}`);
  return result;
}

const dailyRule = new schedule.RecurrenceRule();
dailyRule.hour = 2;
dailyRule.minute = 0;
dailyRule.tz = TIMEZONE;
schedule.scheduleJob(dailyRule, async () => {
  scheduleTodaysJobs();
  await runUpdateCycle('daily-02:00');
});

const dawnRescheduleRule = new schedule.RecurrenceRule();
dawnRescheduleRule.hour = 0;
dawnRescheduleRule.minute = 30;
dawnRescheduleRule.tz = TIMEZONE;
schedule.scheduleJob(dawnRescheduleRule, () => {
  log('post-midnight: re-resolving today\'s prayer schedule for T−20 jobs');
  scheduleTodaysJobs();
});

process.on('SIGUSR2', () => {
  runUpdateCycle('manual-SIGUSR2').catch((e) => log(`SIGUSR2 cycle error: ${e.message}`));
});

scheduleTodaysJobs();
log(`auto-updater started: branch=${BRANCH} repoRoot=${REPO_ROOT} staging=${STAGING_PATH}`);
log(`tracking ${activeJobs.length} per-prayer jobs + daily 02:00 + post-midnight reschedule`);
