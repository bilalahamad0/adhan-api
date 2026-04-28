#!/usr/bin/env node
// Manual trigger for the auto-updater. Falls back to in-process run if the
// auto-updater PM2 process isn't running on this host.
//
// Usage:
//   npm run update:now            # respect prayer-window guard
//   npm run update:now -- --force # bypass guard
//   npm run update:now -- --dry-run # smoke only, no swap

const { exec, spawnSync } = require('child_process');

const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');

function runInProcess() {
  console.log('[update:now] auto-updater PM2 process not found — running in-process');
  process.env.UPDATE_FORCE = force ? '1' : '0';
  process.env.UPDATE_DRY_RUN = dryRun ? '1' : '0';
  // Lazy-require so PATH for child npm is correct.
  const path = require('path');
  const BuildManager = require(path.join(__dirname, '..', 'audio-caster', 'services', 'BuildManager'));
  const SmokeRunner = require(path.join(__dirname, '..', 'audio-caster', 'services', 'SmokeRunner'));
  const FirestoreSync = require(path.join(__dirname, '..', 'audio-caster', 'services', 'FirestoreSync'));
  require('dotenv').config({ path: path.join(__dirname, '..', 'audio-caster', '.env') });

  const REPO_ROOT = path.resolve(__dirname, '..');
  const STAGING_PATH = process.env.UPDATE_STAGING_PATH || '/tmp/adhan-staging';
  const DATA_DIR = process.env.PLAYBACK_DATA_DIR
    || path.join(process.env.HOME || REPO_ROOT, '.adhan-data');
  const TIMEZONE = process.env.TIMEZONE || 'America/Los_Angeles';
  const BRANCH = process.env.UPDATE_TRACK_BRANCH || 'main';

  const firestoreSync = new FirestoreSync(
    process.env.FIREBASE_SERVICE_KEY,
    TIMEZONE,
    path.join(REPO_ROOT, 'audio-caster', 'annual_schedule.json'),
  );
  const smokeRunner = new SmokeRunner();
  const bm = new BuildManager({
    repoRoot: REPO_ROOT,
    stagingPath: STAGING_PATH,
    dataDir: DATA_DIR,
    branch: BRANCH,
    smokeRunner,
    firestoreSync,
    timezone: TIMEZONE,
  });
  bm.attemptUpdate({ force, dryRun }).then((result) => {
    console.log(`[update:now] result: ${JSON.stringify(result, null, 2)}`);
    process.exit(result.success ? 0 : 1);
  }).catch((e) => {
    console.error(`[update:now] error: ${e.message}`);
    process.exit(2);
  });
}

function trySignalPm2() {
  return new Promise((resolve) => {
    exec('pm2 jlist', { timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(false); return; }
      try {
        const procs = JSON.parse(stdout);
        const proc = procs.find((p) => p.name === 'auto-updater' && p.pm2_env?.status === 'online');
        if (!proc) { resolve(false); return; }
        if (force || dryRun) {
          console.log('[update:now] WARN: --force/--dry-run not supported via SIGUSR2 path; running in-process instead.');
          resolve(false);
          return;
        }
        console.log(`[update:now] sending SIGUSR2 to PID ${proc.pid} (auto-updater)`);
        process.kill(proc.pid, 'SIGUSR2');
        const tail = spawnSync('pm2', ['logs', 'auto-updater', '--lines', '40', '--nostream'], { stdio: 'inherit' });
        resolve(tail.status === 0);
      } catch {
        resolve(false);
      }
    });
  });
}

(async () => {
  const ok = await trySignalPm2();
  if (!ok) runInProcess();
})();
