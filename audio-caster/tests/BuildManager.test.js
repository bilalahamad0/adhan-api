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
    expect(cmdJoined).toMatch(/pm2 reload adhan-caster adb-keeper auto-updater/);
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
