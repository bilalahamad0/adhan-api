const path = require('path');
const SecurityService = require('../services/SecurityService');

const ROOT = '/srv/repo';
const MC = '/srv/repo/media-caster';

function makeFakeFs(initial = {}) {
  const store = new Map(Object.entries(initial));
  const removed = [];
  // Directories created through the fake, by path, with their mtime.
  const dirs = new Map();
  const missing = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    existsSync: (p) => store.has(p) || dirs.has(p),
    readFileSync: (p) => {
      if (!store.has(p)) {
        const e = new Error(`ENOENT: ${p}`);
        e.code = 'ENOENT';
        throw e;
      }
      return store.get(p);
    },
    writeFileSync: (p, contents) => store.set(p, contents),
    mkdtempSync: (prefix) => {
      dirs.set(`${prefix}TEST`, Date.now());
      return `${prefix}TEST`;
    },
    mkdirSync: (p) => dirs.set(p, Date.now()),
    readdirSync: (p) => [...dirs.keys()].filter((d) => path.dirname(d) === p).map((d) => path.basename(d)),
    statSync: (p) => {
      if (!dirs.has(p)) throw missing(p);
      return { mtimeMs: dirs.get(p) };
    },
    rmSync: (p) => {
      removed.push(p);
      for (const map of [store, dirs])
        for (const key of [...map.keys()]) if (key === p || key.startsWith(`${p}/`)) map.delete(key);
    },
    _store: store,
    _dirs: dirs,
    _removed: removed,
    _json: (p) => JSON.parse(store.get(p)),
  };
}

/**
 * Matches commands by substring, in insertion order. Anything unmatched comes
 * back as a clean exit with empty output.
 */
function makeRunExec(responses = {}) {
  const calls = [];
  const runExec = jest.fn(async (cmd, opts = {}) => {
    calls.push({ cmd, cwd: opts.cwd });
    for (const [pattern, value] of Object.entries(responses)) {
      if (!cmd.includes(pattern)) continue;
      const resolved = typeof value === 'function' ? value(cmd, opts) : value;
      return { code: 0, stdout: '', stderr: '', ...resolved };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  return { runExec, calls };
}

const pkgFile = (dir) => path.join(dir, 'package.json');
const lockFile = (dir) => path.join(dir, 'package-lock.json');

// Fix mode's throwaway copy of the manifests: a mkdtemp dir (the fake appends
// TEST) holding a folder named after the live checkout, "repo" for ROOT.
const SCRATCH_PARENT = '/tmp/sec';
const SCRATCH_ROOT = '/tmp/sec/adhan-security-TEST';
const SCRATCH = `${SCRATCH_ROOT}/repo`;
const SCRATCH_MC = `${SCRATCH}/media-caster`;
const BASE = '3298b3d7fc23500aaaf3953ee86625cd0d8ac698';
const TREE = '1111111111111111111111111111111111111111';
const COMMIT = 'c0ffee0000000000000000000000000000000000';
const SAME_BLOB = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW_BLOB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SCRATCH_COPY = { root: SCRATCH_ROOT, dir: SCRATCH, base: BASE };

function manifests(root, mc, { pkg = { overrides: {} } } = {}) {
  return {
    [pkgFile(root)]: JSON.stringify(pkg),
    [lockFile(root)]: JSON.stringify({ packages: {} }),
    [pkgFile(mc)]: JSON.stringify({ overrides: {} }),
    [lockFile(mc)]: JSON.stringify({ packages: {} }),
  };
}

/**
 * git responses for a fix-mode run. origin/main resolves to BASE until the
 * push lands, then to whatever originAfterPush says. Only media-caster's
 * lockfile differs from origin's copy unless changed is false.
 */
function plumbing({ changed = true, push = {}, originAfterPush = COMMIT } = {}) {
  let landed = false;
  return {
    'git push --dry-run': { code: 0 },
    'git push origin': () => {
      const result = { code: 0, ...push };
      if (result.code === 0) landed = true;
      return result;
    },
    'rev-parse origin/main': () => ({ stdout: `${landed ? originAfterPush : BASE}\n` }),
    'ls-tree --name-only': { stdout: 'media-caster/ip-patch\n' },
    'hash-object -w': (cmd) => ({
      stdout: `${changed && cmd.includes(`${SCRATCH_MC}/package-lock.json`) ? NEW_BLOB : SAME_BLOB}\n`,
    }),
    [`rev-parse ${BASE}:`]: { stdout: `${SAME_BLOB}\n` },
    'write-tree': { stdout: `${TREE}\n` },
    'commit-tree': { stdout: `${COMMIT}\n` },
  };
}

/** The real shape of the js-yaml problem: pm2 pins 4.3.0, advisory covers 4.0.0-4.3.0. */
const JS_YAML_AUDIT = {
  vulnerabilities: {
    'js-yaml': {
      name: 'js-yaml',
      severity: 'high',
      range: '4.0.0 - 4.3.0',
      nodes: ['node_modules/pm2/node_modules/js-yaml'],
      effects: ['pm2'],
      via: [{ name: 'js-yaml', range: '4.0.0 - 4.3.0', severity: 'high' }],
      fixAvailable: { name: 'pm2', version: '5.3.1', isSemVerMajor: true },
    },
  },
  metadata: { vulnerabilities: { critical: 0, high: 1, moderate: 0, low: 0 } },
};

const JS_YAML_VERSIONS = JSON.stringify([
  '3.14.2',
  '3.15.0',
  '3.15.1',
  '4.0.0',
  '4.1.0',
  '4.3.0',
  '4.3.1',
  '5.0.0',
  '5.2.3',
]);

function makeService({ files = {}, responses = {}, ...overrides } = {}) {
  const fsApi = makeFakeFs(files);
  const { runExec, calls } = makeRunExec(responses);
  const service = new SecurityService({
    logger: { log: jest.fn(), error: jest.fn() },
    runExec,
    fsApi,
    repoRoot: ROOT,
    mediaCasterDir: MC,
    scratchParent: SCRATCH_PARENT,
    ...overrides,
  });
  return { service, fsApi, runExec, calls };
}

describe('SecurityService override resolution', () => {
  // The defect: overrides[name] = "*" resolved js-yaml to 5.x while pm2 pins
  // 4.3.0, breaking the API on both sides of the tree.
  it('pins the first patched version inside the installed major, never "*"', async () => {
    const { service, fsApi } = makeService({
      files: {
        [pkgFile(ROOT)]: JSON.stringify({ name: 'adhan-api', overrides: {} }),
        [lockFile(ROOT)]: JSON.stringify({
          packages: { 'node_modules/pm2/node_modules/js-yaml': { version: '4.3.0' } },
        }),
      },
      responses: { 'npm view js-yaml versions': { stdout: JS_YAML_VERSIONS } },
    });

    const result = await service._enforceOverridesForRemainingVulnerabilities(
      ROOT,
      JS_YAML_AUDIT,
      service._readLock(ROOT)
    );

    const written = fsApi._json(pkgFile(ROOT));
    expect(written.overrides).toEqual({ pm2: { 'js-yaml': '4.3.1' } });
    expect(JSON.stringify(written.overrides)).not.toContain('*');
    expect(result.applied).toEqual([{ package: 'js-yaml', version: '4.3.1', consumers: ['pm2'] }]);
    expect(result.changed).toBe(true);
  });

  it('scopes the override to the consumer named in the node path, not the whole tree', async () => {
    const { service, fsApi } = makeService({
      files: {
        [pkgFile(ROOT)]: JSON.stringify({ overrides: {} }),
        [lockFile(ROOT)]: JSON.stringify({
          packages: {
            'node_modules/@istanbuljs/load-nyc-config/node_modules/js-yaml': { version: '3.14.2' },
          },
        }),
      },
      responses: { 'npm view js-yaml versions': { stdout: JS_YAML_VERSIONS } },
    });

    const audit = {
      vulnerabilities: {
        'js-yaml': {
          severity: 'high',
          range: '<=3.15.0',
          nodes: ['node_modules/@istanbuljs/load-nyc-config/node_modules/js-yaml'],
          effects: [],
          via: [{ name: 'js-yaml', range: '<=3.15.0' }],
        },
      },
    };

    await service._enforceOverridesForRemainingVulnerabilities(ROOT, audit, service._readLock(ROOT));

    // Stays on the 3.x line: 3.15.1, not 4.x and not 5.x.
    expect(fsApi._json(pkgFile(ROOT)).overrides).toEqual({
      '@istanbuljs/load-nyc-config': { 'js-yaml': '3.15.1' },
    });
  });

  it('falls back to the advisory effects when the node path is hoisted', async () => {
    const { service, fsApi } = makeService({
      files: {
        [pkgFile(ROOT)]: JSON.stringify({ overrides: {} }),
        [lockFile(ROOT)]: JSON.stringify({
          packages: { 'node_modules/js-yaml': { version: '4.3.0' } },
        }),
      },
      responses: { 'npm view js-yaml versions': { stdout: JS_YAML_VERSIONS } },
    });

    const audit = {
      vulnerabilities: {
        'js-yaml': {
          severity: 'high',
          range: '4.0.0 - 4.3.0',
          nodes: ['node_modules/js-yaml'],
          effects: ['pm2'],
          via: [{ name: 'js-yaml', range: '4.0.0 - 4.3.0' }],
        },
      },
    };

    await service._enforceOverridesForRemainingVulnerabilities(ROOT, audit, service._readLock(ROOT));
    expect(fsApi._json(pkgFile(ROOT)).overrides).toEqual({ pm2: { 'js-yaml': '4.3.1' } });
  });

  it('leaves a vulnerability to a human when its major has no patched release', async () => {
    const { service, fsApi } = makeService({
      files: {
        [pkgFile(ROOT)]: JSON.stringify({ overrides: {} }),
        [lockFile(ROOT)]: JSON.stringify({
          packages: { 'node_modules/pm2/node_modules/js-yaml': { version: '4.3.0' } },
        }),
      },
      // Only 5.x is patched; bumping a major under a cron job is not this
      // service's call to make.
      responses: {
        'npm view js-yaml versions': { stdout: JSON.stringify(['4.3.0', '5.0.0', '5.2.3']) },
      },
    });

    const result = await service._enforceOverridesForRemainingVulnerabilities(
      ROOT,
      JS_YAML_AUDIT,
      service._readLock(ROOT)
    );

    expect(result.applied).toHaveLength(0);
    expect(result.changed).toBe(false);
    expect(fsApi._json(pkgFile(ROOT)).overrides).toEqual({});
    expect(result.unresolved[0]).toMatchObject({ package: 'js-yaml', installed: '4.3.0' });
  });

  // npm lists pm2 as vulnerable with `via: ['js-yaml']`. Fixing js-yaml fixes
  // pm2, and there is no patched pm2 in the 7.x line to chase — acting on the
  // parent would report a phantom "needs human" every night.
  it('ignores a package that is vulnerable only through a dependency', async () => {
    const { service, fsApi } = makeService({
      files: {
        [pkgFile(ROOT)]: JSON.stringify({ overrides: {} }),
        [lockFile(ROOT)]: JSON.stringify({
          packages: { 'node_modules/pm2': { version: '7.0.3' } },
        }),
      },
      responses: { 'npm view pm2 versions': { stdout: JSON.stringify(['7.0.3']) } },
    });

    const audit = {
      vulnerabilities: {
        pm2: {
          severity: 'high',
          range: '>=5.4.0',
          nodes: ['node_modules/pm2'],
          effects: [],
          via: ['js-yaml'],
        },
      },
    };

    const result = await service._enforceOverridesForRemainingVulnerabilities(ROOT, audit, service._readLock(ROOT));
    expect(result.unresolved).toHaveLength(0);
    expect(result.changed).toBe(false);
    expect(fsApi._json(pkgFile(ROOT)).overrides).toEqual({});
  });

  it('never rewrites ip, which resolves to the local file patch', async () => {
    const { service, fsApi } = makeService({
      files: {
        [pkgFile(MC)]: JSON.stringify({ overrides: { ip: 'file:./ip-patch' } }),
        [lockFile(MC)]: JSON.stringify({ packages: { 'node_modules/ip': { version: '2.0.1' } } }),
      },
      responses: { 'npm view ip versions': { stdout: JSON.stringify(['2.0.1', '3.0.0']) } },
    });

    const audit = {
      vulnerabilities: {
        ip: { severity: 'high', range: '<=2.0.1', nodes: ['node_modules/ip'], effects: [], via: [] },
      },
    };

    const result = await service._enforceOverridesForRemainingVulnerabilities(MC, audit, service._readLock(MC));
    expect(result.changed).toBe(false);
    expect(fsApi._json(pkgFile(MC)).overrides).toEqual({ ip: 'file:./ip-patch' });
  });

  it('preserves an existing pin on the consumer itself', async () => {
    const { service, fsApi } = makeService({
      files: {
        [pkgFile(ROOT)]: JSON.stringify({ overrides: { pm2: '7.0.3' } }),
        [lockFile(ROOT)]: JSON.stringify({
          packages: { 'node_modules/pm2/node_modules/js-yaml': { version: '4.3.0' } },
        }),
      },
      responses: { 'npm view js-yaml versions': { stdout: JS_YAML_VERSIONS } },
    });

    await service._enforceOverridesForRemainingVulnerabilities(ROOT, JS_YAML_AUDIT, service._readLock(ROOT));
    expect(fsApi._json(pkgFile(ROOT)).overrides).toEqual({
      pm2: { '.': '7.0.3', 'js-yaml': '4.3.1' },
    });
  });

  it('refuses to shell out for a package name it cannot vouch for', async () => {
    const { service, runExec } = makeService({
      files: { [pkgFile(ROOT)]: JSON.stringify({ overrides: {} }), [lockFile(ROOT)]: '{}' },
    });

    const versions = await service._versionsOf('evil; rm -rf /');
    expect(versions).toEqual([]);
    expect(runExec).not.toHaveBeenCalled();
  });
});

describe('SecurityService stale override pruning', () => {
  // The live trap: this rule pinned ws to 8.20.1, which GHSA-96hv-2xvq-fx4p
  // covers (it wants >= 8.21.0), so `npm audit fix` could never resolve ws.
  it('drops a conditional override whose trigger version is no longer installed', async () => {
    const { service, fsApi } = makeService({
      files: {
        [pkgFile(MC)]: JSON.stringify({
          overrides: { 'ws@8.20.0': { '.': '8.20.1' }, qs: '6.15.2' },
        }),
        [lockFile(MC)]: JSON.stringify({
          packages: { 'node_modules/ws': { version: '8.21.0' }, 'node_modules/qs': { version: '6.15.2' } },
        }),
      },
    });

    const result = await service._pruneStaleOverrides(MC, { vulnerabilities: {} }, service._readLock(MC));

    expect(result.pruned).toEqual(['ws@8.20.0']);
    expect(fsApi._json(pkgFile(MC)).overrides).toEqual({ qs: '6.15.2' });
    expect(result.changed).toBe(true);
  });

  it('moves a pin that sits inside a live advisory range up to the patched version', async () => {
    const { service, fsApi } = makeService({
      files: {
        [pkgFile(MC)]: JSON.stringify({ overrides: { 'ws@8.20.0': { '.': '8.20.1' } } }),
        [lockFile(MC)]: JSON.stringify({
          packages: { 'node_modules/ws': { version: '8.20.0' } },
        }),
      },
      responses: {
        'npm view ws versions': { stdout: JSON.stringify(['8.20.0', '8.20.1', '8.21.0', '9.0.0']) },
      },
    });

    const audit = {
      vulnerabilities: {
        ws: { severity: 'high', range: '>=8.0.0 <8.21.0', via: [{ range: '>=8.0.0 <8.21.0' }] },
      },
    };

    const result = await service._pruneStaleOverrides(MC, audit, service._readLock(MC));
    expect(result.repaired).toEqual([{ key: 'ws@8.20.0', from: '8.20.1', to: '8.21.0' }]);
    expect(fsApi._json(pkgFile(MC)).overrides).toEqual({ 'ws@8.20.0': { '.': '8.21.0' } });
  });

  it('leaves range-style defensive pins and file: specs alone', async () => {
    const overrides = { systeminformation: '^5.31.3', ip: 'file:./ip-patch', uuid: '11.1.1' };
    const { service, fsApi } = makeService({
      files: {
        [pkgFile(MC)]: JSON.stringify({ overrides }),
        [lockFile(MC)]: JSON.stringify({ packages: { 'node_modules/uuid': { version: '11.1.1' } } }),
      },
    });

    const result = await service._pruneStaleOverrides(MC, { vulnerabilities: {} }, service._readLock(MC));
    expect(result.changed).toBe(false);
    expect(fsApi._json(pkgFile(MC)).overrides).toEqual(overrides);
  });
});

describe('SecurityService scratch copy', () => {
  const ARCHIVE =
    `git archive --format=tar ${BASE} package.json package-lock.json ` +
    `media-caster/package.json media-caster/package-lock.json`;

  it('copies only the manifests and ip-patch from the freshly fetched origin tip', async () => {
    const { service, calls } = makeService({ files: manifests(SCRATCH, SCRATCH_MC), responses: plumbing() });

    const scratch = await service._prepareScratch();

    expect(scratch).toEqual({
      ok: true,
      root: SCRATCH_ROOT,
      dir: SCRATCH,
      base: BASE,
      workspaces: [SCRATCH, SCRATCH_MC],
    });
    const order = calls.map((c) => c.cmd);
    expect(order.slice(0, 2)).toEqual(['git fetch origin main', 'git rev-parse origin/main']);
    expect(order).toContain(`${ARCHIVE} media-caster/ip-patch | tar -x -C '${SCRATCH}'`);
    expect(calls.every((c) => c.cwd === ROOT)).toBe(true);
  });

  it('leaves ip-patch out when origin no longer has it', async () => {
    const { service, calls } = makeService({
      files: manifests(SCRATCH, SCRATCH_MC),
      responses: { ...plumbing(), 'ls-tree --name-only': { stdout: '' } },
    });

    await service._prepareScratch();
    expect(calls.map((c) => c.cmd)).toContain(`${ARCHIVE} | tar -x -C '${SCRATCH}'`);
  });

  // /bin/sh has no pipefail: a failed `git archive` piped into tar can still exit 0.
  it('gives up, and removes the dir, when the extract left manifests missing', async () => {
    const { service, fsApi } = makeService({ responses: plumbing() });

    expect(await service._prepareScratch()).toMatchObject({ ok: false, failureReason: 'scratch-failed' });
    expect(fsApi._removed).toEqual([SCRATCH_ROOT]);
  });

  it('reports a failed fetch before creating anything', async () => {
    const { service, fsApi, calls } = makeService({
      responses: { 'git fetch': { code: 128, stderr: "fatal: unable to access: Could not resolve host: github.com" } },
    });
    fsApi.mkdtempSync = jest.fn();

    expect(await service._prepareScratch()).toMatchObject({ ok: false, failureReason: 'network' });
    expect(fsApi.mkdtempSync).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('only ever removes its own scratch dirs', () => {
    const { service, fsApi } = makeService();
    service._removeScratch(ROOT);
    service._removeScratch('/tmp/sec/something-else');
    service._removeScratch(SCRATCH_ROOT);
    expect(fsApi._removed).toEqual([SCRATCH_ROOT]);
  });

  // npm names a lockfile after its folder when package.json has no "name".
  it('extracts under the live checkout\'s folder name, not the random mkdtemp one', async () => {
    const { service, fsApi } = makeService({
      files: manifests('/tmp/sec/adhan-security-TEST/adhan-api', '/tmp/sec/adhan-security-TEST/adhan-api/media-caster'),
      responses: plumbing(),
      repoRoot: '/home/pi/adhan-api/',
      mediaCasterDir: '/home/pi/adhan-api/media-caster',
    });

    const scratch = await service._prepareScratch();

    expect(scratch.dir).toBe('/tmp/sec/adhan-security-TEST/adhan-api');
    expect(fsApi._dirs.has(scratch.dir)).toBe(true);
  });

  it('removes the dir when anything throws after it was created', async () => {
    const { service, fsApi } = makeService({
      responses: {
        ...plumbing(),
        'ls-tree': () => {
          throw new Error('git crashed');
        },
      },
    });

    expect(await service._prepareScratch()).toMatchObject({ ok: false, failureReason: 'scratch-failed' });
    expect(fsApi._removed).toEqual([SCRATCH_ROOT]);
  });

  // A run killed mid-way (pm2 restart, reboot of the process) leaves its dir.
  it('sweeps scratch dirs older than a day before making a new one', async () => {
    const { service, fsApi } = makeService({ files: manifests(SCRATCH, SCRATCH_MC), responses: plumbing() });
    const day = 24 * 60 * 60_000;
    fsApi._dirs.set('/tmp/sec/adhan-security-old', Date.now() - 2 * day);
    fsApi._dirs.set('/tmp/sec/adhan-security-recent', Date.now() - 60_000);
    fsApi._dirs.set('/tmp/sec/unrelated-old', Date.now() - 2 * day);

    await service._prepareScratch();

    expect(fsApi._removed).toEqual(['/tmp/sec/adhan-security-old']);
    expect(fsApi._dirs.has('/tmp/sec/adhan-security-recent')).toBe(true);
    expect(fsApi._dirs.has('/tmp/sec/unrelated-old')).toBe(true);
  });
});

describe('SecurityService commit from objects', () => {
  const run = (opts) => {
    const svc = makeService({ responses: plumbing(opts) });
    return { ...svc, result: svc.service._commitAndPush(SCRATCH_COPY) };
  };

  it('builds the commit on the origin tip with a temporary index, and pushes that sha', async () => {
    const { calls, result } = run();
    expect(await result).toMatchObject({ changed: true, committed: true, pushed: true, failureReason: null });

    const index = `GIT_INDEX_FILE='${SCRATCH_ROOT}/git-index'`;
    const cmds = calls.map((c) => c.cmd);
    expect(cmds).toEqual(
      expect.arrayContaining([
        `${index} git read-tree ${BASE}`,
        `${index} git update-index --add --cacheinfo 100644,${NEW_BLOB},media-caster/package-lock.json`,
        `${index} git write-tree`,
        `git push origin ${COMMIT}:refs/heads/main`,
      ])
    );
    // Only the manifest that differs from origin's copy is staged.
    expect(cmds.filter((c) => c.includes('update-index'))).toHaveLength(1);
    expect(cmds.find((c) => c.includes('commit-tree'))).toMatch(
      new RegExp(`-c user.email="security-bot@adhan-api.local" .* commit-tree ${TREE} -p ${BASE} -m "chore\\(security\\)`)
    );
    expect(calls.every((c) => c.cwd === ROOT)).toBe(true);
  });

  it('stays quiet when no manifest changed', async () => {
    const { calls, result } = run({ changed: false });
    expect(await result).toMatchObject({ changed: false, committed: false, pushed: false, failureReason: null });
    expect(calls.some((c) => /read-tree|commit-tree|git push/.test(c.cmd))).toBe(false);
  });

  // Replaying manifests computed from the old tip could undo someone's
  // dependency change, so a race with origin is left for tomorrow's run.
  it('does not rebase when origin moved during the run', async () => {
    const { calls, result } = run({ push: { code: 1, stderr: ' ! [rejected] c0ffee0 -> main (fetch first)' } });
    expect(await result).toMatchObject({ committed: true, pushed: false, failureReason: 'non-fast-forward' });
    expect(calls.some((c) => c.cmd.includes('rebase'))).toBe(false);
  });

  it('reports a push rejected for credentials distinctly', async () => {
    const { result } = run({ push: { code: 128, stderr: 'git@github.com: Permission denied (publickey).' } });
    expect(await result).toMatchObject({ committed: true, pushed: false, failureReason: 'credentials' });
  });

  it('does not call a push "landed" when origin never moved', async () => {
    const { result } = run({ originAfterPush: BASE });
    expect(await result).toMatchObject({ pushed: false, failureReason: 'remote-not-updated' });
  });

  it('stops before pushing when the commit cannot be built', async () => {
    const svc = makeService({ responses: { ...plumbing(), 'write-tree': { code: 128, stdout: '' } } });
    expect(await svc.service._commitAndPush(SCRATCH_COPY)).toMatchObject({
      committed: false,
      failureReason: 'commit-failed',
    });
    expect(svc.calls.some((c) => c.cmd.includes('git push'))).toBe(false);
  });

  // A dry-run probe cannot see branch protection, so this only surfaces on the
  // real push; it should not read as 'unknown'.
  it('classifies a server-side refusal as protected', () => {
    const classify = SecurityService.classifyPushFailure;
    expect(classify('remote: error: GH006: Protected branch update failed for refs/heads/main.')).toBe('protected');
    expect(classify(' ! [remote rejected] HEAD -> main (pre-receive hook declined)')).toBe('protected');
    expect(classify(' ! [rejected]        HEAD -> main (non-fast-forward)')).toBe('non-fast-forward');
    expect(classify("fatal: could not read Username for 'https://github.com'")).toBe('credentials');
  });
});

describe('SecurityService push-access probe', () => {
  it('uses a non-interactive dry-run push, which writes nothing', async () => {
    const { service, calls } = makeService();
    expect(await service._probePushAccess(ROOT)).toEqual({ ok: true, reason: null });
    expect(calls).toEqual([
      { cmd: 'GIT_TERMINAL_PROMPT=0 git push --dry-run origin HEAD:refs/heads/main', cwd: ROOT },
    ]);
  });

  // The exact error the Pi printed every night.
  it('reports missing HTTPS credentials as blocked', async () => {
    const { service } = makeService({
      responses: {
        'git push --dry-run': {
          code: 128,
          stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        },
      },
    });
    expect(await service._probePushAccess(ROOT)).toMatchObject({ ok: false, reason: 'credentials' });
  });

  it('treats a non-fast-forward rejection as access granted, since it authenticated', async () => {
    const { service } = makeService({
      responses: {
        'git push --dry-run': { code: 1, stderr: ' ! [rejected] HEAD -> main (non-fast-forward)' },
      },
    });
    expect(await service._probePushAccess(ROOT)).toEqual({ ok: true, reason: null });
  });

  it('treats an unrecognised failure as blocked rather than guessing', async () => {
    const { service } = makeService({
      responses: { 'git push --dry-run': { code: 128, stderr: 'fatal: something odd' } },
    });
    expect(await service._probePushAccess(ROOT)).toMatchObject({ ok: false, reason: 'unknown' });
  });
});

describe('SecurityService report-only mode', () => {
  const NO_CREDENTIALS = {
    code: 128,
    stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  };
  const BASIC_FTP_AUDIT = {
    vulnerabilities: {
      'basic-ftp': {
        severity: 'high',
        range: '<6.2.0',
        nodes: ['node_modules/basic-ftp'],
        via: [{ name: 'basic-ftp', range: '<6.2.0', severity: 'high' }],
        fixAvailable: { name: 'basic-ftp', version: '6.2.1', isSemVerMajor: true },
      },
      // Vulnerable only through basic-ftp; not a separate finding.
      'get-uri': { severity: 'high', via: ['basic-ftp'], fixAvailable: true },
      braces: {
        severity: 'high',
        range: '<3.0.4',
        via: [{ name: 'braces', range: '<3.0.4' }],
        fixAvailable: true,
      },
      'some-moderate': { severity: 'moderate', via: [{ name: 'some-moderate' }] },
    },
    metadata: { vulnerabilities: { critical: 0, high: 3, moderate: 1, low: 0 } },
  };

  function noPushRun(audit = BASIC_FTP_AUDIT, extra = {}) {
    const run = makeService({
      files: {
        [pkgFile(ROOT)]: JSON.stringify({ overrides: { ip: '2.0.1' } }),
        [lockFile(ROOT)]: JSON.stringify({ packages: {} }),
        [pkgFile(MC)]: JSON.stringify({ overrides: {} }),
        [lockFile(MC)]: JSON.stringify({ packages: {} }),
      },
      responses: {
        'git push --dry-run': NO_CREDENTIALS,
        'npm audit --json': { code: 1, stdout: JSON.stringify(audit) },
        ...extra,
      },
    });
    run.publishSecurityInfo = jest.fn().mockResolvedValue(true);
    run.service.firestoreSync = { publishSecurityInfo: run.publishSecurityInfo };
    run.before = new Map(run.fsApi._store);
    return run;
  }

  it('makes no manifest edits, installs or commits when it cannot push', async () => {
    const { service, calls, fsApi, before } = noPushRun();

    const summary = await service.autoFixVulnerabilities();

    expect(summary).toMatchObject({
      mode: 'report-only',
      pushBlocked: 'credentials',
      committed: false,
      pushed: false,
      failureReason: null,
    });
    const cmds = calls.map((c) => c.cmd);
    expect(cmds.filter((c) => !c.includes('git push --dry-run') && c !== 'npm audit --json')).toEqual([]);
    expect(cmds.filter((c) => c === 'npm audit --json')).toHaveLength(2);
    expect(new Map(fsApi._store)).toEqual(before);
  });

  it('reports what it found, per workspace, without the push noise', async () => {
    const { service, publishSecurityInfo } = noPushRun();

    const summary = await service.autoFixVulnerabilities();

    expect(summary.ok).toBe(false);
    expect(summary.remainingHighCritical).toBe(6);
    const finding = (pkg, fix) => ({ package: pkg, severity: 'high', fix, reason: 'report-only' });
    expect(summary.needsHuman).toEqual([
      finding('basic-ftp', 'major-bump'),
      finding('braces', 'audit-fix'),
      finding('basic-ftp', 'major-bump'),
      finding('braces', 'audit-fix'),
    ]);
    expect(publishSecurityInfo).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, mode: 'report-only', pushBlocked: 'credentials', committed: false })
    );

    const errors = service.log.error.mock.calls.map(([m]) => m);
    expect(errors.some((m) => m.includes('Push rejected'))).toBe(false);
    expect(errors).toContainEqual(expect.stringContaining('push blocked: credentials'));
  });

  it('completes clean in report-only mode when nothing is vulnerable', async () => {
    const { service } = noPushRun({
      vulnerabilities: {},
      metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 } },
    });

    const summary = await service.autoFixVulnerabilities();

    expect(summary).toMatchObject({ ok: true, mode: 'report-only', remainingHighCritical: 0 });
    expect(service.log.error).not.toHaveBeenCalled();
    expect(service.log.log).toHaveBeenCalledWith(expect.stringContaining('completed clean (report-only)'));
  });

  // npm prints a JSON error document when the registry is unreachable.
  it('does not mistake an unreadable audit for a clean one', async () => {
    const { service } = noPushRun({ error: { code: 'ENOTFOUND', summary: 'registry unreachable' } });

    const summary = await service.autoFixVulnerabilities();

    expect(summary).toMatchObject({ ok: false, failureReason: 'audit-unreadable' });
  });

  it('runs the full fix when the probe passes', async () => {
    const { service, calls } = noPushRun(undefined, plumbing());
    for (const [p, v] of Object.entries(manifests(SCRATCH, SCRATCH_MC))) service.fs.writeFileSync(p, v);

    const summary = await service.autoFixVulnerabilities();

    expect(summary.mode).toBe('fix');
    expect(summary.pushBlocked).toBeNull();
    expect(calls.some((c) => c.cmd.includes('npm audit fix'))).toBe(true);
  });
});

// The live checkout is what the running app is loaded from, and what
// BuildManager deploys onto. Fix mode must leave all of it alone.
describe('SecurityService fix mode', () => {
  const CLEAN_AUDIT = {
    stdout: JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { critical: 0, high: 0 } } }),
  };

  function fixRun({ extra = {}, git = {}, audit = CLEAN_AUDIT } = {}) {
    const run = makeService({
      files: { ...manifests(ROOT, MC), ...manifests(SCRATCH, SCRATCH_MC) },
      responses: { ...extra, 'npm audit --json': audit, ...plumbing(git) },
    });
    run.publishSecurityInfo = jest.fn().mockResolvedValue(true);
    run.service.firestoreSync = { publishSecurityInfo: run.publishSecurityInfo };
    run.live = () => [...run.fsApi._store].filter(([p]) => !p.startsWith(SCRATCH_ROOT));
    run.liveBefore = run.live();
    return run;
  }

  // Writes git or npm could make to the live checkout's tree, index, HEAD or
  // node_modules.
  const LIVE_WRITE = /\b(reset|rebase|checkout|stash|status|merge|pull)\b|git add |\bcommit -m/;

  it('runs npm only in the scratch copy, and nothing that writes the live checkout', async () => {
    const { service, calls, live, liveBefore, fsApi } = fixRun();

    const summary = await service.autoFixVulnerabilities();

    expect(summary).toMatchObject({ mode: 'fix', committed: true, pushed: true, failureReason: null, ok: true });
    const npm = calls.filter((c) => c.cmd.startsWith('npm '));
    expect(npm.length).toBeGreaterThan(0);
    expect(npm.every((c) => c.cwd === SCRATCH || c.cwd === SCRATCH_MC)).toBe(true);
    expect(npm.filter((c) => /npm (install|audit fix)/.test(c.cmd)).every((c) => c.cmd.includes('--package-lock-only'))).toBe(
      true
    );
    expect(calls.filter((c) => LIVE_WRITE.test(c.cmd))).toEqual([]);
    expect(live()).toEqual(liveBefore);
    expect(fsApi._removed).toEqual([SCRATCH_ROOT]);
  });

  it('writes edited manifests into the scratch copy only', async () => {
    const { service, fsApi, live, liveBefore } = fixRun({
      extra: {
        'npm audit fix': (cmd, opts) => {
          fsApi.writeFileSync(lockFile(opts.cwd), JSON.stringify({ fixed: true }));
          return { code: 0 };
        },
      },
    });
    let seenInScratch = null;
    const realRemove = service._removeScratch.bind(service);
    service._removeScratch = (dir) => {
      seenInScratch = fsApi._json(lockFile(SCRATCH_MC));
      realRemove(dir);
    };

    await service.autoFixVulnerabilities();

    expect(seenInScratch).toEqual({ fixed: true });
    expect(live()).toEqual(liveBefore);
  });

  it('removes the scratch copy even when npm throws mid-run', async () => {
    const { service, fsApi, live, liveBefore } = fixRun({
      extra: {
        'npm audit fix': () => {
          throw new Error('npm exploded');
        },
      },
    });

    const summary = await service.autoFixVulnerabilities();

    expect(summary).toMatchObject({ ok: false, failureReason: 'exception: npm exploded' });
    expect(fsApi._removed).toEqual([SCRATCH_ROOT]);
    expect(live()).toEqual(liveBefore);
  });

  it('reports a refused push and leaves nothing behind', async () => {
    const { service, fsApi, calls, live, liveBefore, publishSecurityInfo } = fixRun({
      git: { push: { code: 1, stderr: 'remote: error: GH006: Protected branch update failed for refs/heads/main.' } },
    });

    const summary = await service.autoFixVulnerabilities();

    expect(summary).toMatchObject({ committed: true, pushed: false, failureReason: 'protected' });
    expect(fsApi._removed).toEqual([SCRATCH_ROOT]);
    expect(live()).toEqual(liveBefore);
    expect(calls.filter((c) => LIVE_WRITE.test(c.cmd))).toEqual([]);
    const [published] = publishSecurityInfo.mock.calls[0];
    expect(published).toMatchObject({ mode: 'fix', committed: true, pushed: false, failureReason: 'protected' });
    expect(published).not.toHaveProperty('rolledBack');
  });

  it('reports a scratch failure without running npm', async () => {
    const { service, calls } = makeService({
      files: manifests(ROOT, MC),
      responses: { ...plumbing(), 'npm audit --json': CLEAN_AUDIT },
    });

    const summary = await service.autoFixVulnerabilities();

    expect(summary).toMatchObject({ mode: 'fix', ok: false, failureReason: 'scratch-failed' });
    expect(calls.some((c) => c.cmd.startsWith('npm '))).toBe(false);
  });

  // npm prints a JSON error document when the registry is unreachable. Fix mode
  // used to read that as "no remaining vulnerabilities", report ok, and commit.
  it('does not commit, or call the run clean, when an audit is unreadable', async () => {
    const { service, calls, fsApi } = fixRun({
      audit: { code: 1, stdout: JSON.stringify({ error: { code: 'ENOTFOUND', summary: 'registry unreachable' } }) },
    });

    const summary = await service.autoFixVulnerabilities();

    expect(summary).toMatchObject({ mode: 'fix', ok: false, committed: false, failureReason: 'audit-unreadable' });
    expect(calls.some((c) => /commit-tree|git push origin|npm audit fix/.test(c.cmd))).toBe(false);
    expect(service.log.log).not.toHaveBeenCalledWith(expect.stringContaining('No remaining vulnerabilities'));
    expect(fsApi._removed).toEqual([SCRATCH_ROOT]);
  });

  it('does not commit when a later audit in the pipeline is unreadable', async () => {
    let audits = 0;
    const { service, calls } = fixRun({
      audit: () => (++audits === 2 ? { code: 1, stdout: '' } : CLEAN_AUDIT),
    });

    const summary = await service.autoFixVulnerabilities();

    expect(summary).toMatchObject({ ok: false, committed: false, failureReason: 'audit-unreadable' });
    expect(calls.some((c) => c.cmd.includes('commit-tree'))).toBe(false);
  });

  // Overrides rewritten in package.json without a regenerated lockfile would
  // land on main and fail `npm ci` in BuildManager's staging deploy.
  it('does not commit overrides whose lockfile install failed', async () => {
    const { service, calls } = fixRun({
      extra: { 'npm install --package-lock-only': { code: 1, stderr: 'ERESOLVE could not resolve' } },
    });
    service._pruneStaleOverrides = jest.fn().mockResolvedValue({ changed: true, pruned: ['ws@8.20.0'], repaired: [] });

    const summary = await service.autoFixVulnerabilities();

    expect(summary).toMatchObject({ ok: false, committed: false, failureReason: 'install-failed' });
    expect(calls.some((c) => c.cmd.includes('commit-tree'))).toBe(false);
  });
});

describe('SecurityService run reporting', () => {
  function fullRun(extraResponses = {}) {
    return makeService({
      files: { ...manifests(ROOT, MC), ...manifests(SCRATCH, SCRATCH_MC) },
      responses: {
        'npm audit --json': {
          stdout: JSON.stringify({
            vulnerabilities: {},
            metadata: { vulnerabilities: { critical: 0, high: 0 } },
          }),
        },
        ...extraResponses,
        ...plumbing({ changed: false }),
      },
    });
  }

  it('publishes the outcome so a failed run is visible off the Pi', async () => {
    const publishSecurityInfo = jest.fn().mockResolvedValue(true);
    // The probe passes but the real push is still refused.
    const { service } = makeService({
      files: { ...manifests(ROOT, MC), ...manifests(SCRATCH, SCRATCH_MC) },
      responses: {
        'npm audit --json': { stdout: JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: {} } }) },
        ...plumbing({ push: { code: 128, stderr: 'Permission denied (publickey).' } }),
      },
    });
    service.firestoreSync = { publishSecurityInfo };

    const summary = await service.autoFixVulnerabilities();

    expect(summary.ok).toBe(false);
    expect(summary.failureReason).toBe('credentials');
    expect(publishSecurityInfo).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, pushed: false, failureReason: 'credentials' })
    );
    expect(service.log.error).toHaveBeenCalledWith(expect.stringContaining('UNRESOLVED'));
  });

  // The payload is linted on its string leaves rather than its whole JSON, so a
  // boolean cannot collide with an env var set to "false". A real secret in a
  // string field must still be caught.
  it('refuses to publish a payload carrying an env secret', async () => {
    const publishSecurityInfo = jest.fn().mockResolvedValue(true);
    const { service } = fullRun();
    service.firestoreSync = { publishSecurityInfo };
    process.env.SECURITY_TEST_SECRET = 'sk-super-secret-token';
    try {
      const published = await service._publish({
        finishedAt: '2026-08-06T00:00:00.000Z',
        ok: false,
        committed: true,
        pushed: false,
        failureReason: 'push failed for sk-super-secret-token',
        remainingHighCritical: 0,
        needsHuman: [],
      });
      expect(published).toBe(false);
      expect(publishSecurityInfo).not.toHaveBeenCalled();
      expect(service.log.error).toHaveBeenCalledWith(expect.stringContaining('Refusing to publish'));
    } finally {
      delete process.env.SECURITY_TEST_SECRET;
    }
  });

  it('publishes a boolean-heavy payload even when an env var is the string "false"', async () => {
    const publishSecurityInfo = jest.fn().mockResolvedValue(true);
    const { service } = fullRun();
    service.firestoreSync = { publishSecurityInfo };
    process.env.SECURITY_TEST_FLAG = 'false';
    try {
      const published = await service._publish({
        finishedAt: '2026-08-06T00:00:00.000Z',
        ok: false,
        committed: true,
        pushed: false,
        failureReason: null,
        remainingHighCritical: 0,
        needsHuman: [],
      });
      expect(published).toBe(true);
      expect(publishSecurityInfo).toHaveBeenCalled();
    } finally {
      delete process.env.SECURITY_TEST_FLAG;
    }
  });

  it('reports a clean run when there is nothing left to fix', async () => {
    const { service } = fullRun();
    const summary = await service.autoFixVulnerabilities();
    expect(summary).toMatchObject({ ok: true, remainingHighCritical: 0, failureReason: null, committed: false });
    expect(summary.needsHuman).toEqual([]);
  });

  it('never throws out of the nightly job', async () => {
    const { service, fsApi } = fullRun();
    service._processWorkspace = jest.fn().mockRejectedValue(new Error('npm exploded'));
    const summary = await service.autoFixVulnerabilities();
    expect(summary.ok).toBe(false);
    expect(summary.failureReason).toContain('npm exploded');
    expect(fsApi._removed).toEqual([SCRATCH_ROOT]);
  });

  it('keeps the original new SecurityService(console) signature working', () => {
    const service = new SecurityService(console);
    expect(service.log).toBe(console);
    expect(typeof service.runExec).toBe('function');
    expect(service.branch).toBe('main');
  });
});
