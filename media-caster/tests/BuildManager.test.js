const path = require('path');
const { DateTime } = require('luxon');
const BuildManager = require('../services/BuildManager');

function makeFakeFs(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    existsSync: (p) => store.has(p),
    readFileSync: (p) => {
      if (!store.has(p)) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
      return store.get(p);
    },
    writeFileSync: (p, contents) => { store.set(p, contents); },
    unlinkSync: (p) => { store.delete(p); },
    mkdirSync: () => {},
    _store: store,
  };
}

function makeRunExecRecorder(responses = {}) {
  const calls = [];
  const runExec = jest.fn(async (cmd) => {
    calls.push(cmd);
    for (const [pattern, value] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        if (typeof value === 'function') return value(cmd);
        if (value instanceof Error) throw value;
        return value;
      }
    }
    return { stdout: '', stderr: '' };
  });
  return { runExec, calls };
}

function makeSmoke(result) {
  return { run: jest.fn().mockResolvedValue(result) };
}

const REPO = '/srv/repo';
const STAGING = '/tmp/staging';
const DATA = '/tmp/data';
const FIXED_NOW = DateTime.fromISO('2026-04-27T14:32:00', { zone: 'America/Los_Angeles' });

describe('BuildManager.parseConventionalType', () => {
  test('extracts known commit types', () => {
    expect(BuildManager.parseConventionalType('fix(scheduler): correct DST')).toBe('fix');
    expect(BuildManager.parseConventionalType('feat: add X')).toBe('feat');
    expect(BuildManager.parseConventionalType('chore: bump deps')).toBe('chore');
    expect(BuildManager.parseConventionalType('docs!: rewrite README')).toBe('docs');
  });
  test('falls back to chore for unknown or malformed subjects', () => {
    expect(BuildManager.parseConventionalType('random subject')).toBe('chore');
    expect(BuildManager.parseConventionalType('unknownType: foo')).toBe('chore');
    expect(BuildManager.parseConventionalType('')).toBe('chore');
  });
});

describe('BuildManager.assertPrivacy', () => {
  test('flags any payload that contains an env value longer than 4 chars', () => {
    const env = { TV_IP: '10.0.0.42', SHORT: 'abc', FIREBASE_SERVICE_KEY: 'eyJsdmVyc2lvbiI6IjEifQ' };
    const payload = { currentVersion: 'v2026.04.27-fix.1', currentShortSha: 'abc1234', leak: '10.0.0.42' };
    const verdict = BuildManager.assertPrivacy(payload, env);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/TV_IP/);
  });
  test('passes a clean payload', () => {
    const env = { TV_IP: '10.0.0.42', LOCATION_CITY: 'Sunnyvale' };
    const payload = {
      currentVersion: 'v2026.04.27-fix.1',
      currentShortSha: 'abc1234',
      currentDeployedAt: '2026-04-27T14:32:00-07:00',
      currentChangePriority: 'high',
      previousVersion: null,
      previousShortSha: null,
      lastSuccessfulSmoke: { passed: 25, failed: 0, ts: '2026-04-27T14:31:30-07:00' },
      lastFailure: null,
    };
    const verdict = BuildManager.assertPrivacy(payload, env);
    expect(verdict.ok).toBe(true);
  });
  test('ignores env values of 4 chars or fewer', () => {
    const env = { TZ: 'PST', X: 'abcd' };
    const payload = { x: 'PST in payload' };
    expect(BuildManager.assertPrivacy(payload, env).ok).toBe(true);
  });

  // Matching against serialised JSON folds structure into the haystack: an env
  // var whose value is "false" collided with a JSON boolean and blocked
  // publishing outright. A live env var tripped exactly this.
  test('does not mistake JSON syntax for an env value', () => {
    const env = { SOME_FLAG: 'false', OTHER_FLAG: 'null' };
    const payload = { ok: false, pushed: false, failureReason: null, count: 0 };
    expect(BuildManager.assertPrivacy(payload, env).ok).toBe(true);
  });

  test('still catches a secret nested in an array or object', () => {
    const env = { TOKEN: 'sk-super-secret-token' };
    expect(
      BuildManager.assertPrivacy({ needsHuman: [{ reason: 'failed for sk-super-secret-token' }] }, env)
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/TOKEN/) });
  });

  test('catches a secret that leaked into a key rather than a value', () => {
    const env = { TOKEN: 'sk-super-secret-token' };
    expect(BuildManager.assertPrivacy({ 'sk-super-secret-token': 1 }, env).ok).toBe(false);
  });
});

describe('BuildManager.checkForUpdate', () => {
  test('returns null newSha when HEAD == origin/main', async () => {
    const { runExec } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: 'abc123\n', stderr: '' },
      'rev-parse origin/main': { stdout: 'abc123\n', stderr: '' },
    });
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 1, failed: 0, failedChecks: [], reason: 'OK', durationMs: 10 }),
      runExec, fsApi: makeFakeFs(),
    });
    const result = await bm.checkForUpdate();
    expect(result.newSha).toBeNull();
    expect(result.currentSha).toBe('abc123');
  });

  test('returns newSha when origin is ahead', async () => {
    const { runExec } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: 'abc123\n', stderr: '' },
      'rev-parse origin/main': { stdout: 'def456\n', stderr: '' },
    });
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 1, failed: 0, failedChecks: [], reason: 'OK', durationMs: 10 }),
      runExec, fsApi: makeFakeFs(),
    });
    const result = await bm.checkForUpdate();
    expect(result.newSha).toBe('def456');
    expect(result.currentSha).toBe('abc123');
  });
});

// The Pi's nightly loop: SecurityService committed at 00:01 and could not push,
// then the 02:00 cycle read HEAD != origin as an update, reset the commit away
// and redeployed the sha that was already running.
describe('BuildManager.checkForUpdate with unpushed security commits', () => {
  const ORIGIN = '3298b3d7fc23500aaaf3953ee86625cd0d8ac698';
  const BOT_COMMIT = 'c0a99be95efe71648fdeb8115192e386d9459007';
  const MANIFESTS = 'media-caster/package-lock.json\nmedia-caster/package.json\npackage-lock.json\npackage.json\n';

  function setup({ deployedSha = ORIGIN, overrides = {} } = {}) {
    const { runExec, calls } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: `${BOT_COMMIT}\n`, stderr: '' },
      'rev-parse origin/main': { stdout: `${ORIGIN}\n`, stderr: '' },
      'rev-list --count': { stdout: '0\n', stderr: '' },
      'log --format=%ae': { stdout: `${BuildManager.SECURITY_BOT_EMAIL}\n`, stderr: '' },
      'diff --name-only': { stdout: MANIFESTS, stderr: '' },
      'log -1 --pretty=%s': { stdout: 'chore: weekly AI metrics update\n', stderr: '' },
      ...overrides,
    });
    const fsApi = makeFakeFs({
      [path.join(DATA, 'build-info.json')]: JSON.stringify({ currentVersion: 'v2026.10.15-chore.1', sha: deployedSha }),
    });
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 1, failed: 0, failedChecks: [], reason: 'OK', durationMs: 10 }),
      runExec, fsApi, log: jest.fn(), nowFn: () => FIXED_NOW,
      securityBotEmail: BuildManager.SECURITY_BOT_EMAIL,
    });
    return { bm, calls };
  }

  test('does not treat them as an update', async () => {
    const { bm } = setup();
    expect(await bm.checkForUpdate()).toEqual({ currentSha: BOT_COMMIT, newSha: null, localOnly: 1 });
    expect(bm.log).toHaveBeenCalledWith(expect.stringContaining('1 unpushed security-bot commit'));
  });

  test('so the update cycle neither resets nor redeploys', async () => {
    const { bm, calls } = setup();
    const result = await bm.attemptUpdate();
    expect(result).toMatchObject({ success: true, reason: 'no-update' });
    const cmds = calls.join('\n');
    expect(cmds).not.toMatch(/worktree add/);
    expect(cmds).not.toMatch(/reset --hard/);
    expect(cmds).not.toMatch(/pm2 reload/);
  });

  test('deploys when origin has moved on as well', async () => {
    const { bm } = setup({ overrides: { 'rev-list --count': { stdout: '1\n', stderr: '' } } });
    expect((await bm.checkForUpdate()).newSha).toBe(ORIGIN);
  });

  test('deploys when a local commit is not the security bot\'s', async () => {
    const { bm } = setup({
      overrides: { 'log --format=%ae': { stdout: `${BuildManager.SECURITY_BOT_EMAIL}\nsomeone@example.com\n`, stderr: '' } },
    });
    expect((await bm.checkForUpdate()).newSha).toBe(ORIGIN);
  });

  test('deploys when the local commits touch more than dependency manifests', async () => {
    const { bm } = setup({
      overrides: { 'diff --name-only': { stdout: `${MANIFESTS}media-caster/boot.js\n`, stderr: '' } },
    });
    expect((await bm.checkForUpdate()).newSha).toBe(ORIGIN);
  });

  // A security rebase can move the files on disk to a newer origin without a
  // deploy; the running code is still the old one and needs the deploy.
  test('deploys when origin\'s tip is not what build-info says is deployed', async () => {
    const { bm, calls } = setup({ deployedSha: '1cfe4e65d1539540823cb300661dae29b857bf9f' });
    expect((await bm.checkForUpdate()).newSha).toBe(ORIGIN);
    expect(calls.join('\n')).not.toMatch(/rev-list/);
  });

  test('falls back to deploying when git cannot answer', async () => {
    const { bm } = setup({ overrides: { 'rev-list --count': new Error('bad revision') } });
    expect((await bm.checkForUpdate()).newSha).toBe(ORIGIN);
  });

  test('matches the identity SecurityService commits under', () => {
    const SecurityService = require('../services/SecurityService');
    const bm = new BuildManager({ repoRoot: REPO, stagingPath: STAGING, dataDir: DATA, smokeRunner: makeSmoke({}) });
    expect(bm.securityBotEmail).toBe(new SecurityService({ runExec: jest.fn() }).gitEmail);
  });
});

describe('BuildManager.attemptUpdate happy path', () => {
  test('passes smoke, swaps, publishes meta/build, reloads', async () => {
    const { runExec, calls } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: 'oldsha7777777\n', stderr: '' },
      'rev-parse origin/main': { stdout: 'newsha8888888\n', stderr: '' },
      'log -1 --pretty=%s': { stdout: 'fix(scheduler): correct DST drift\n', stderr: '' },
    });
    const fsApi = makeFakeFs();
    const firestoreSync = { publishBuildInfo: jest.fn().mockResolvedValue(true) };
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 25, failed: 0, failedChecks: [], reason: 'OK', durationMs: 9000 }),
      runExec, fsApi, firestoreSync,
      nowFn: () => FIXED_NOW,
    });

    const result = await bm.attemptUpdate();

    expect(result.success).toBe(true);
    expect(result.reason).toBe('deployed');
    expect(result.stage).toBe('reload');
    expect(result.sha).toBe('newsha8888888');
    expect(result.previousSha).toBe('oldsha7777777');
    expect(result.version).toBe('v2026.04.27-fix.1');

    // Wrote build-info.json with versioned record
    const buildInfoPath = path.join(DATA, 'build-info.json');
    expect(fsApi._store.has(buildInfoPath)).toBe(true);
    const persisted = JSON.parse(fsApi._store.get(buildInfoPath));
    expect(persisted.currentVersion).toBe('v2026.04.27-fix.1');
    expect(persisted.currentShortSha).toBe('newsha8');
    expect(persisted.currentChangePriority).toBe('high');

    // Published a privacy-safe payload — no commit message, no full SHA leakage
    expect(firestoreSync.publishBuildInfo).toHaveBeenCalledTimes(1);
    const published = firestoreSync.publishBuildInfo.mock.calls[0][0];
    expect(published).not.toHaveProperty('commitMessage');
    expect(published.currentVersion).toBe('v2026.04.27-fix.1');
    expect(published.lastSuccessfulSmoke.passed).toBe(25);

    // Ran the worktree, npm ci x2, rsync, git reset, pm2 reload
    const cmdJoined = calls.join('\n');
    expect(cmdJoined).toMatch(/git -C \/srv\/repo worktree add --detach \/tmp\/staging newsha8888888/);
    expect(cmdJoined).toMatch(/npm ci --omit=dev/);
    expect(cmdJoined).toMatch(/rsync -a --delete-after/);
    expect(calls.filter((c) => c.includes('pm2 reload'))).toEqual([
      'exec pm2 reload adhan-caster',
      'exec pm2 reload adb-keeper',
      'exec pm2 reload auto-updater',
    ]);
    expect(result.restartSelf).toBe(false);
  });
});

describe('BuildManager pm2 reload', () => {
  const SHA_RESPONSES = {
    'rev-parse HEAD': { stdout: 'oldsha7777777\n', stderr: '' },
    'rev-parse origin/main': { stdout: 'newsha8888888\n', stderr: '' },
    'log -1 --pretty=%s': { stdout: 'fix(scheduler): correct DST drift\n', stderr: '' },
  };

  function makeManager(responses, extra = {}, files = {}) {
    const { runExec, calls } = makeRunExecRecorder({ ...SHA_RESPONSES, ...responses });
    const fsApi = makeFakeFs(files);
    const firestoreSync = { publishBuildInfo: jest.fn().mockResolvedValue(true) };
    const logs = [];
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 25, failed: 0, failedChecks: [], reason: 'OK', durationMs: 9000 }),
      runExec, fsApi, firestoreSync,
      nowFn: () => FIXED_NOW,
      log: (msg) => logs.push(msg),
      ...extra,
    });
    const reloads = () => calls.filter((c) => c.includes('pm2 reload'));
    return { bm, runExec, fsApi, firestoreSync, logs, reloads };
  }

  // pm2's `reload <id|name|namespace|all>` takes one name. The old single
  // `pm2 reload adhan-caster adb-keeper auto-updater` reloaded adhan-caster
  // and silently ignored the other two, every night.
  test('names exactly one app per pm2 reload', async () => {
    const { bm, reloads } = makeManager({});
    await bm.attemptUpdate();
    expect(reloads().length).toBe(BuildManager.PM2_APPS.length);
    for (const cmd of reloads()) {
      expect(cmd).toMatch(/^exec pm2 reload [\w-]+$/);
    }
  });

  // On the Pi the CLI took 54-144s to reach the daemon after npm ci, so the old
  // 30s limit timed out every night.
  test('gives each reload minutes, not 30s', async () => {
    const { bm, runExec } = makeManager({});
    await bm.attemptUpdate();
    const reloadCalls = runExec.mock.calls.filter(([cmd]) => cmd.includes('pm2 reload'));
    expect(reloadCalls.length).toBeGreaterThan(0);
    for (const [, opts] of reloadCalls) {
      expect(opts.timeoutMs).toBe(BuildManager.PM2_RELOAD_TIMEOUT_MS);
    }
    expect(BuildManager.PM2_RELOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(3 * 60_000);
  });

  // pm2 kills a reloading app's process tree. Reloading the auto-updater from
  // inside it would kill the CLI doing the reload, and the cycle with it.
  test('leaves its own app to the caller and asks for a restart', async () => {
    const { bm, reloads } = makeManager({}, { selfPm2App: 'auto-updater' });
    const result = await bm.attemptUpdate();
    expect(result.success).toBe(true);
    expect(result.reason).toBe('deployed');
    expect(reloads()).toEqual(['exec pm2 reload adhan-caster', 'exec pm2 reload adb-keeper']);
    expect(result.restartSelf).toBe(true);
  });

  test('a timed-out reload fails the deploy and is published to meta/build', async () => {
    const timeout = Object.assign(new Error('Command failed: exec pm2 reload adb-keeper\n'), {
      killed: true, signal: 'SIGTERM', code: null, stdout: '', stderr: '',
    });
    const { bm, fsApi, firestoreSync, reloads } = makeManager(
      { 'pm2 reload adb-keeper': timeout },
      { selfPm2App: 'auto-updater' },
    );

    const result = await bm.attemptUpdate();

    expect(result.success).toBe(false);
    expect(result.stage).toBe('reload');
    expect(result.reason).toBe('reload-failed: adb-keeper (timed out after 300s)');
    expect(result.reloadFailures).toEqual([{ app: 'adb-keeper', error: 'timed out after 300s' }]);
    // The new code is on disk either way, so the auto-updater still restarts onto it.
    expect(result.restartSelf).toBe(true);
    expect(reloads()).toEqual(['exec pm2 reload adhan-caster', 'exec pm2 reload adb-keeper']);

    const persisted = JSON.parse(fsApi._store.get(path.join(DATA, 'build-info.json')));
    expect(persisted.lastFailure).toMatchObject({
      version: 'v2026.04.27-fix.1',
      shortSha: 'newsha8',
      stage: 'reload',
      failedChecks: ['pm2 reload adb-keeper: timed out after 300s'],
    });
    const lastPublish = firestoreSync.publishBuildInfo.mock.calls.at(-1)[0];
    expect(lastPublish.lastFailure.stage).toBe('reload');
    expect(lastPublish.lastFailure.failedChecks).toEqual(['pm2 reload adb-keeper: timed out after 300s']);
  });

  test('keeps reloading the other apps after one fails, and reports each failure', async () => {
    const missing = Object.assign(new Error('Command failed: exec pm2 reload adhan-caster\n'), {
      killed: false, signal: null, code: 1,
      stdout: '', stderr: '[PM2][ERROR] Process or Namespace adhan-caster not found\n',
    });
    const { bm, firestoreSync, logs, reloads } = makeManager({ 'pm2 reload adhan-caster': missing });

    const result = await bm.attemptUpdate();

    expect(reloads()).toEqual([
      'exec pm2 reload adhan-caster',
      'exec pm2 reload adb-keeper',
      'exec pm2 reload auto-updater',
    ]);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('reload-failed: adhan-caster (exit 1)');
    // The CLI's own words go to the local log only, never to the published record.
    expect(logs.some((l) => l.includes('pm2 reload adhan-caster FAILED: exit 1') && l.includes('not found'))).toBe(true);
    expect(logs.some((l) => l.includes('pm2 reload adb-keeper ok'))).toBe(true);
    const published = JSON.stringify(firestoreSync.publishBuildInfo.mock.calls.at(-1)[0]);
    expect(published).toContain('pm2 reload adhan-caster: exit 1');
    expect(published).not.toContain('[PM2][ERROR]');
  });

  test('a failed reload leaves its apps pending in build-info.json', async () => {
    const timeout = Object.assign(new Error('Command failed\n'), { killed: true, signal: 'SIGTERM' });
    const { bm, fsApi } = makeManager({ 'pm2 reload adb-keeper': timeout }, { selfPm2App: 'auto-updater' });
    await bm.attemptUpdate();
    const persisted = JSON.parse(fsApi._store.get(path.join(DATA, 'build-info.json')));
    expect(persisted.pendingReload).toEqual(['adb-keeper']);
  });

  test('a deploy whose reloads all succeed leaves nothing pending', async () => {
    const { bm, fsApi } = makeManager({}, { selfPm2App: 'auto-updater' }, {
      [path.join(DATA, 'build-info.json')]: JSON.stringify({ currentVersion: 'v2026.04.26-fix.1', pendingReload: ['adb-keeper'] }),
    });
    const result = await bm.attemptUpdate();
    expect(result.reason).toBe('deployed');
    const persisted = JSON.parse(fsApi._store.get(path.join(DATA, 'build-info.json')));
    expect(persisted.pendingReload).toBeUndefined();
  });
});

// After a swap HEAD == origin, so every later cycle is 'no-update'. Without a
// retry, an app whose reload failed stays on old code until the next commit.
describe('BuildManager pending reload retry', () => {
  const BUILD_INFO = path.join(DATA, 'build-info.json');
  const NO_UPDATE = {
    'rev-parse HEAD': { stdout: 'newsha8888888\n', stderr: '' },
    'rev-parse origin/main': { stdout: 'newsha8888888\n', stderr: '' },
  };
  // What a 02:00 deploy with a timed-out adb-keeper reload leaves behind.
  const afterFailedReload = (pendingReload) => ({
    [BUILD_INFO]: JSON.stringify({
      currentVersion: 'v2026.04.27-fix.1',
      currentShortSha: 'newsha8',
      currentDeployedAt: '2026-04-27T02:02:00.000-07:00',
      lastFailure: {
        version: 'v2026.04.27-fix.1', shortSha: 'newsha8', ts: '2026-04-27T02:04:00.000-07:00',
        stage: 'reload', failedChecks: ['pm2 reload adb-keeper: timed out after 300s'],
      },
      pendingReload,
    }),
  });

  function makeManager(responses, extra = {}, files = {}) {
    const { runExec, calls } = makeRunExecRecorder({ ...NO_UPDATE, ...responses });
    const fsApi = makeFakeFs(files);
    const firestoreSync = { publishBuildInfo: jest.fn().mockResolvedValue(true) };
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 25, failed: 0, failedChecks: [], reason: 'OK', durationMs: 1 }),
      runExec, fsApi, firestoreSync,
      nowFn: () => FIXED_NOW,
      log: () => {},
      selfPm2App: 'auto-updater',
      ...extra,
    });
    const reloads = () => calls.filter((c) => c.includes('pm2 reload'));
    const persisted = () => JSON.parse(fsApi._store.get(BUILD_INFO));
    return { bm, firestoreSync, reloads, persisted };
  }

  // dashboard.html renderBuildBanner shows the banner while this holds.
  const bannerShown = (b) => new Date(b.lastFailure.ts) > new Date(b.currentDeployedAt);

  test('reloads only the pending apps on a no-update cycle and clears the banner', async () => {
    const { bm, firestoreSync, reloads, persisted } = makeManager({}, {}, afterFailedReload(['adb-keeper']));
    expect(bannerShown(JSON.parse(afterFailedReload([])[BUILD_INFO]))).toBe(true);

    const result = await bm.attemptUpdate();

    expect(result).toMatchObject({ success: true, stage: 'reload-retry', reason: 'reload-retried', restartSelf: false });
    expect(reloads()).toEqual(['exec pm2 reload adb-keeper']);
    const b = persisted();
    expect(b.pendingReload).toBeUndefined();
    expect(b.currentDeployedAt).toBe(FIXED_NOW.toISO());
    expect(b.currentVersion).toBe('v2026.04.27-fix.1');
    expect(b.lastFailure.stage).toBe('reload'); // kept as history, like after any deploy
    expect(bannerShown(b)).toBe(false);
    const published = firestoreSync.publishBuildInfo.mock.calls.at(-1)[0];
    expect(bannerShown(published)).toBe(false);
  });

  test('keeps the still-failing apps pending and refreshes lastFailure', async () => {
    const stillMissing = Object.assign(new Error('Command failed\n'), { killed: false, code: 1 });
    const { bm, firestoreSync, reloads, persisted } = makeManager(
      { 'pm2 reload adb-keeper': stillMissing },
      {},
      afterFailedReload(['adhan-caster', 'adb-keeper']),
    );

    const result = await bm.attemptUpdate();

    expect(result).toMatchObject({ success: false, stage: 'reload-retry', reason: 'reload-failed: adb-keeper (exit 1)' });
    expect(reloads()).toEqual(['exec pm2 reload adhan-caster', 'exec pm2 reload adb-keeper']);
    const b = persisted();
    expect(b.pendingReload).toEqual(['adb-keeper']);
    expect(b.lastFailure).toMatchObject({
      version: 'v2026.04.27-fix.1',
      ts: FIXED_NOW.toISO(),
      stage: 'reload-retry',
      failedChecks: ['pm2 reload adb-keeper: exit 1'],
    });
    expect(bannerShown(b)).toBe(true);
    expect(firestoreSync.publishBuildInfo.mock.calls.at(-1)[0].lastFailure.stage).toBe('reload-retry');
  });

  // e.g. `npm run update:now` ran outside pm2 and failed to reload the auto-updater.
  test('a pending self app is handed back to the caller to restart', async () => {
    const { bm, reloads, persisted } = makeManager({}, {}, afterFailedReload(['auto-updater']));
    const result = await bm.attemptUpdate();
    expect(result).toMatchObject({ success: true, reason: 'reload-retried', restartSelf: true });
    expect(reloads()).toEqual([]);
    expect(persisted().pendingReload).toBeUndefined();
  });

  test('a no-update cycle with nothing pending reloads nothing', async () => {
    const { bm, reloads } = makeManager({}, {}, {
      [BUILD_INFO]: JSON.stringify({ currentVersion: 'v2026.04.27-fix.1', pendingReload: [] }),
    });
    const result = await bm.attemptUpdate();
    expect(result.reason).toBe('no-update');
    expect(reloads()).toEqual([]);
  });

  test('a dry run does not retry', async () => {
    const { bm, reloads, persisted } = makeManager({}, {}, afterFailedReload(['adb-keeper']));
    const result = await bm.attemptUpdate({ dryRun: true });
    expect(result.reason).toBe('no-update');
    expect(reloads()).toEqual([]);
    expect(persisted().pendingReload).toEqual(['adb-keeper']);
  });

  test('the prayer-window guard still applies', async () => {
    const { bm, reloads } = makeManager({}, {
      prayerWindowProvider: async () => [{ name: 'Asr', iso: FIXED_NOW.plus({ minutes: 3 }).toISO() }],
    }, afterFailedReload(['adb-keeper']));
    const result = await bm.attemptUpdate();
    expect(result.stage).toBe('guard');
    expect(reloads()).toEqual([]);
  });
});

describe('BuildManager.describeExecFailure', () => {
  test('names the cause without the command output', () => {
    expect(BuildManager.describeExecFailure({ killed: true, signal: 'SIGTERM' }, 300_000)).toBe('timed out after 300s');
    expect(BuildManager.describeExecFailure({ killed: false, code: 1, stderr: 'secret path' }, 300_000)).toBe('exit 1');
    expect(BuildManager.describeExecFailure({ killed: false, code: null, signal: 'SIGKILL' }, 300_000)).toBe('killed by SIGKILL');
    expect(BuildManager.describeExecFailure(new Error('spawn failed'), 300_000)).toBe('failed');
  });
});

describe('BuildManager.attemptUpdate smoke failure', () => {
  test('keeps the live build, records lastFailure with check names only', async () => {
    const { runExec } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: 'oldsha7777777\n', stderr: '' },
      'rev-parse origin/main': { stdout: 'newsha8888888\n', stderr: '' },
      'log -1 --pretty=%s': { stdout: 'fix: thing\n', stderr: '' },
    });
    const fsApi = makeFakeFs();
    const firestoreSync = { publishBuildInfo: jest.fn().mockResolvedValue(true) };
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({
        ok: false, passed: 23, failed: 2,
        failedChecks: ['Weather Data', 'TV_IP Configured'],
        reason: 'OK', durationMs: 9000,
      }),
      runExec, fsApi, firestoreSync,
      nowFn: () => FIXED_NOW,
    });

    const result = await bm.attemptUpdate();

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/^smoke-failed:/);
    expect(result.stage).toBe('smoke');

    const persisted = JSON.parse(fsApi._store.get(path.join(DATA, 'build-info.json')));
    expect(persisted.lastFailure.stage).toBe('smoke');
    expect(persisted.lastFailure.failedChecks).toEqual(['Weather Data', 'TV_IP Configured']);
    expect(persisted.currentVersion).toBeUndefined(); // no swap, no version

    // No swap commands invoked
    const cmds = runExec.mock.calls.map((c) => c[0]).join('\n');
    expect(cmds).not.toMatch(/rsync/);
    expect(cmds).not.toMatch(/pm2 reload/);
  });
});

describe('BuildManager prayer-window guard', () => {
  test('aborts before staging when a prayer is < 5 min away', async () => {
    const { runExec } = makeRunExecRecorder({});
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 1, failed: 0, failedChecks: [], reason: 'OK', durationMs: 1 }),
      runExec, fsApi: makeFakeFs(),
      nowFn: () => FIXED_NOW,
      prayerWindowProvider: async () => [{ name: 'Asr', iso: FIXED_NOW.plus({ minutes: 3 }).toISO() }],
    });
    const result = await bm.attemptUpdate();
    expect(result.success).toBe(false);
    expect(result.stage).toBe('guard');
    expect(result.reason).toMatch(/prayer-window-guard/);
    expect(runExec).not.toHaveBeenCalled();
  });

  test('--force bypasses the guard', async () => {
    const { runExec } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: 'old\n', stderr: '' },
      'rev-parse origin/main': { stdout: 'old\n', stderr: '' },
    });
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 1, failed: 0, failedChecks: [], reason: 'OK', durationMs: 1 }),
      runExec, fsApi: makeFakeFs(),
      nowFn: () => FIXED_NOW,
      prayerWindowProvider: async () => [{ name: 'Asr', iso: FIXED_NOW.plus({ minutes: 3 }).toISO() }],
    });
    const result = await bm.attemptUpdate({ force: true });
    expect(result.success).toBe(true);
    expect(result.reason).toBe('no-update');
  });
});

describe('BuildManager mutex', () => {
  test('refuses re-entry while a cycle is in progress', async () => {
    const { runExec } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: 'a\n', stderr: '' },
      'rev-parse origin/main': { stdout: 'a\n', stderr: '' },
    });
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 1, failed: 0, failedChecks: [], reason: 'OK', durationMs: 1 }),
      runExec, fsApi: makeFakeFs(),
      nowFn: () => FIXED_NOW,
    });
    bm._inProgress = true;
    const result = await bm.attemptUpdate();
    expect(result.success).toBe(false);
    expect(result.reason).toBe('update-already-in-progress');
  });
});

describe('BuildManager dry-run', () => {
  test('runs smoke but skips swap', async () => {
    const { runExec } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: 'a\n', stderr: '' },
      'rev-parse origin/main': { stdout: 'b\n', stderr: '' },
      'log -1 --pretty=%s': { stdout: 'feat: x\n', stderr: '' },
    });
    const firestoreSync = { publishBuildInfo: jest.fn().mockResolvedValue(true) };
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 25, failed: 0, failedChecks: [], reason: 'OK', durationMs: 1 }),
      runExec, fsApi: makeFakeFs(), firestoreSync,
      nowFn: () => FIXED_NOW,
    });
    const result = await bm.attemptUpdate({ dryRun: true });
    expect(result.success).toBe(true);
    expect(result.reason).toBe('dry-run-passed');
    expect(firestoreSync.publishBuildInfo).not.toHaveBeenCalled();
    const cmds = runExec.mock.calls.map((c) => c[0]).join('\n');
    expect(cmds).not.toMatch(/rsync/);
  });
});

describe('BuildManager._dailySequence', () => {
  test('increments seq when the same date+type appears in build-info', async () => {
    const fsApi = makeFakeFs({
      [path.join(DATA, 'build-info.json')]: JSON.stringify({
        currentVersion: 'v2026.04.27-fix.1',
      }),
    });
    const { runExec } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: 'a\n', stderr: '' },
      'rev-parse origin/main': { stdout: 'def4567abcdef\n', stderr: '' },
      'log -1 --pretty=%s': { stdout: 'fix: another\n', stderr: '' },
    });
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 1, failed: 0, failedChecks: [], reason: 'OK', durationMs: 1 }),
      runExec, fsApi, firestoreSync: { publishBuildInfo: jest.fn().mockResolvedValue(true) },
      nowFn: () => FIXED_NOW,
    });
    const result = await bm.attemptUpdate();
    expect(result.success).toBe(true);
    expect(result.version).toBe('v2026.04.27-fix.2');
  });
});

// ── Drift Detection Tests ──────────────────────────────────────────────

describe('BuildManager.parseDriftOutput', () => {
  test('parses untracked, modified, and deleted entries', () => {
    const status = [
      '?? images/play.svg',
      '?? test.jpg',
      ' M media-caster/boot.js',
      ' D old-file.txt',
    ].join('\n');
    const drift = BuildManager.parseDriftOutput(status);
    expect(drift.untracked).toEqual(['images/play.svg', 'test.jpg']);
    expect(drift.modified).toEqual(['media-caster/boot.js']);
    expect(drift.deleted).toEqual(['old-file.txt']);
    expect(drift.modeOnly).toEqual([]);
    expect(drift.total).toBe(4);
  });

  test('returns empty drift for clean status', () => {
    const drift = BuildManager.parseDriftOutput('');
    expect(drift.total).toBe(0);
    expect(drift.modified).toEqual([]);
    expect(drift.untracked).toEqual([]);
  });

  test('separates mode-only changes from content modifications', () => {
    const status = ' M deploy.sh\n M boot.js\n';
    const diffSummary = ' mode change 100644 => 100755 deploy.sh\n';
    const drift = BuildManager.parseDriftOutput(status, diffSummary);
    expect(drift.modeOnly).toEqual(['deploy.sh']);
    expect(drift.modified).toEqual(['boot.js']);
    expect(drift.total).toBe(2);
  });

  test('handles null/undefined inputs gracefully', () => {
    const drift = BuildManager.parseDriftOutput(null, undefined);
    expect(drift.total).toBe(0);
  });
});

describe('BuildManager.summarizeDrift', () => {
  test('returns null for clean drift', () => {
    const drift = { modified: [], deleted: [], untracked: [], modeOnly: [], total: 0 };
    expect(BuildManager.summarizeDrift(drift)).toBeNull();
    expect(BuildManager.summarizeDrift(null)).toBeNull();
  });

  test('returns counts and capped samples', () => {
    const drift = {
      modified: ['a.js', 'b.js', 'c.js', 'd.js'],
      deleted: ['x.js'],
      untracked: ['u1.jpg', 'u2.jpg', 'u3.jpg', 'u4.jpg'],
      modeOnly: ['m1.sh', 'm2.sh', 'm3.sh'],
      total: 12,
    };
    const summary = BuildManager.summarizeDrift(drift);
    expect(summary.modified).toBe(4);
    expect(summary.deleted).toBe(1);
    expect(summary.untracked).toBe(4);
    expect(summary.modeOnly).toBe(3);
    expect(summary.total).toBe(12);
    expect(summary.samples.length).toBe(8);
    expect(summary.samples).toEqual([
      'a.js', 'b.js', 'c.js',
      'u1.jpg', 'u2.jpg', 'u3.jpg',
      'm1.sh', 'm2.sh',
    ]);
  });
});

describe('BuildManager drift preflight integration', () => {
  test('detects drift and includes it in result without blocking update', async () => {
    const driftStatus = '?? stray-photo.jpg\n M src/server.js\n';
    const logs = [];
    const { runExec } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: 'oldsha7777777\n', stderr: '' },
      'rev-parse origin/main': { stdout: 'newsha8888888\n', stderr: '' },
      'log -1 --pretty=%s': { stdout: 'fix: drift test\n', stderr: '' },
      'status --porcelain': { stdout: driftStatus, stderr: '' },
      'diff --summary': { stdout: '', stderr: '' },
      'config --local core.fileMode': { stdout: '', stderr: '' },
    });
    const fsApi = makeFakeFs();
    const firestoreSync = { publishBuildInfo: jest.fn().mockResolvedValue(true) };
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 25, failed: 0, failedChecks: [], reason: 'OK', durationMs: 100 }),
      runExec, fsApi, firestoreSync,
      nowFn: () => FIXED_NOW,
      log: (msg) => logs.push(msg),
    });

    const result = await bm.attemptUpdate();

    expect(result.success).toBe(true);
    expect(result.drift).toBeTruthy();
    expect(result.drift.untracked).toEqual(['stray-photo.jpg']);
    expect(result.drift.modified).toEqual(['src/server.js']);
    expect(result.drift.total).toBe(2);

    expect(logs.some((l) => l.includes('drift detected: 2 items'))).toBe(true);

    const buildInfo = JSON.parse(fsApi._store.get(path.join(DATA, 'build-info.json')));
    expect(buildInfo.driftSnapshot).toBeTruthy();
    expect(buildInfo.driftSnapshot.total).toBe(2);
  });

  test('logs clean when no drift exists', async () => {
    const logs = [];
    const { runExec } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: 'aaa\n', stderr: '' },
      'rev-parse origin/main': { stdout: 'aaa\n', stderr: '' },
      'status --porcelain': { stdout: '', stderr: '' },
      'diff --summary': { stdout: '', stderr: '' },
      'config --local core.fileMode': { stdout: '', stderr: '' },
    });
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 1, failed: 0, failedChecks: [], reason: 'OK', durationMs: 1 }),
      runExec, fsApi: makeFakeFs(),
      nowFn: () => FIXED_NOW,
      log: (msg) => logs.push(msg),
    });
    const result = await bm.attemptUpdate();
    expect(result.success).toBe(true);
    expect(result.drift.total).toBe(0);
    expect(logs.some((l) => l.includes('working tree clean'))).toBe(true);
  });
});

describe('BuildManager fileMode bootstrap', () => {
  test('runs git config core.fileMode false on first cycle', async () => {
    const { runExec, calls } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: 'aaa\n', stderr: '' },
      'rev-parse origin/main': { stdout: 'aaa\n', stderr: '' },
      'status --porcelain': { stdout: '', stderr: '' },
      'diff --summary': { stdout: '', stderr: '' },
      'config --local core.fileMode': { stdout: '', stderr: '' },
    });
    const logs = [];
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 1, failed: 0, failedChecks: [], reason: 'OK', durationMs: 1 }),
      runExec, fsApi: makeFakeFs(),
      nowFn: () => FIXED_NOW,
      log: (msg) => logs.push(msg),
    });

    await bm.attemptUpdate();
    const fileModeCmd = calls.find((c) => c.includes('core.fileMode'));
    expect(fileModeCmd).toMatch(/config --local core\.fileMode false/);
    expect(logs.some((l) => l.includes('core.fileMode set to false'))).toBe(true);
  });

  test('skips git config on subsequent cycles', async () => {
    const { runExec, calls } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: 'aaa\n', stderr: '' },
      'rev-parse origin/main': { stdout: 'aaa\n', stderr: '' },
      'status --porcelain': { stdout: '', stderr: '' },
      'diff --summary': { stdout: '', stderr: '' },
      'config --local core.fileMode': { stdout: '', stderr: '' },
    });
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 1, failed: 0, failedChecks: [], reason: 'OK', durationMs: 1 }),
      runExec, fsApi: makeFakeFs(),
      nowFn: () => FIXED_NOW,
    });

    await bm.attemptUpdate();
    await bm.attemptUpdate();
    const fileModeCount = calls.filter((c) => c.includes('core.fileMode')).length;
    expect(fileModeCount).toBe(1);
  });
});

describe('BuildManager post-swap drift reporting', () => {
  test('reports remaining drift after swap in result and build info', async () => {
    let statusCallCount = 0;
    const { runExec } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: 'oldsha7777777\n', stderr: '' },
      'rev-parse origin/main': { stdout: 'newsha8888888\n', stderr: '' },
      'log -1 --pretty=%s': { stdout: 'chore: test post-swap\n', stderr: '' },
      'config --local core.fileMode': { stdout: '', stderr: '' },
      'diff --summary': { stdout: '', stderr: '' },
      'status --porcelain': () => {
        statusCallCount++;
        if (statusCallCount <= 1) return { stdout: '', stderr: '' };
        return { stdout: '?? leftover.tmp\n', stderr: '' };
      },
    });
    const fsApi = makeFakeFs();
    const firestoreSync = { publishBuildInfo: jest.fn().mockResolvedValue(true) };
    const logs = [];
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 25, failed: 0, failedChecks: [], reason: 'OK', durationMs: 100 }),
      runExec, fsApi, firestoreSync,
      nowFn: () => FIXED_NOW,
      log: (msg) => logs.push(msg),
    });

    const result = await bm.attemptUpdate();

    expect(result.success).toBe(true);
    expect(result.postSwapDrift).toBeTruthy();
    expect(result.postSwapDrift.untracked).toContain('leftover.tmp');
    expect(logs.some((l) => l.includes('post-swap drift'))).toBe(true);

    const buildInfo = JSON.parse(fsApi._store.get(path.join(DATA, 'build-info.json')));
    expect(buildInfo.postSwapDrift).toBeTruthy();
    expect(buildInfo.postSwapDrift.total).toBeGreaterThan(0);
  });
});

describe('BuildManager observe-only policy', () => {
  test('does NOT run git clean even when drift is detected', async () => {
    const { runExec, calls } = makeRunExecRecorder({
      'rev-parse HEAD': { stdout: 'aaa\n', stderr: '' },
      'rev-parse origin/main': { stdout: 'bbb\n', stderr: '' },
      'log -1 --pretty=%s': { stdout: 'feat: observe test\n', stderr: '' },
      'status --porcelain': { stdout: '?? stray-junk.jpg\n M drifted-cfg.js\n', stderr: '' },
      'diff --summary': { stdout: '', stderr: '' },
      'config --local core.fileMode': { stdout: '', stderr: '' },
    });
    const bm = new BuildManager({
      repoRoot: REPO, stagingPath: STAGING, dataDir: DATA,
      smokeRunner: makeSmoke({ ok: true, passed: 25, failed: 0, failedChecks: [], reason: 'OK', durationMs: 1 }),
      runExec, fsApi: makeFakeFs(),
      firestoreSync: { publishBuildInfo: jest.fn().mockResolvedValue(true) },
      nowFn: () => FIXED_NOW,
    });

    await bm.attemptUpdate();

    const allCmds = calls.join('\n');
    expect(allCmds).not.toMatch(/git clean/);
    expect(allCmds).not.toMatch(/git stash/);
    expect(allCmds).not.toMatch(/git checkout -- /);
  });
});
