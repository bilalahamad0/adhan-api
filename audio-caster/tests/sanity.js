// Hermetic sanity gate. ~1s. No network, no spawned processes, no cast.
// Catches: missing module file, syntax error, broken JSON, missing env-var.
// Use this as the fastest dev-loop gate. The smoke test (boot.js --smoke)
// covers everything this does plus the boot-time integration checks.

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ FAIL: ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

console.log('🧪 Sanity Test (hermetic):');

// 1. Module integrity — every service loads cleanly. Catches syntax errors
//    and missing-dep regressions on the dev loop in <1s.
const SERVICE_MODULES = [
  '../services/CoreScheduler', '../services/MediaService', '../services/HardwareService',
  '../services/PlaybackLogger', '../services/FirestoreSync', '../services/ScheduleService',
  '../services/CastService', '../services/DiscoveryService',
  '../services/BuildManager', '../services/SmokeRunner',
];
for (const mod of SERVICE_MODULES) {
  try {
    require(mod);
    check(`module: ${mod.replace('../services/', '')}`, true);
  } catch (e) {
    check(`module: ${mod.replace('../services/', '')}`, false, e.message);
  }
}

try {
  const { createRequire } = require('module');
  const acRequire = createRequire(path.join(__dirname, '..', 'package.json'));
  acRequire('chromecast-api/lib/device');
  check('chromecast-api/lib/device', true);
} catch (e) {
  check('chromecast-api/lib/device', false, e.message);
}

// 2. Env-var presence (presence only — never values).
const REQUIRED_ENV = ['TV_IP', 'DEVICE_NAME', 'LOCATION_CITY', 'LOCATION_COUNTRY', 'TIMEZONE', 'FIREBASE_SERVICE_KEY'];
for (const key of REQUIRED_ENV) {
  check(`env: ${key} present`, !!process.env[key], `${key} unset`);
}

// 3. JSON parses for known on-disk artifacts (no failure if absent — these
//    are runtime-created on first use).
const dataDir = process.env.PLAYBACK_DATA_DIR
  || path.join(process.env.HOME || path.join(__dirname, '..'), '.adhan-data');
const annualPath = path.join(__dirname, '..', 'annual_schedule.json');
const playbackPath = path.join(dataDir, 'playback_log.json');

if (fs.existsSync(annualPath)) {
  try { JSON.parse(fs.readFileSync(annualPath, 'utf8')); check('annual_schedule.json parses', true); }
  catch (e) { check('annual_schedule.json parses', false, e.message); }
} else {
  check('annual_schedule.json present (or absent on first boot)', true, 'absent — will be fetched on first scheduleToday');
}

if (fs.existsSync(playbackPath)) {
  try { JSON.parse(fs.readFileSync(playbackPath, 'utf8')); check('playback_log.json parses', true); }
  catch (e) { check('playback_log.json parses', false, e.message); }
} else {
  check('playback_log.json present (or absent on first boot)', true, 'absent — created on first prayer event');
}

console.log(`\n🧪 Sanity COMPLETE: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
