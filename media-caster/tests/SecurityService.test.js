const path = require('path');
const SecurityService = require('../services/SecurityService');

const ROOT = '/srv/repo';
const MC = '/srv/repo/media-caster';

function makeFakeFs(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    existsSync: (p) => store.has(p),
    readFileSync: (p) => {
      if (!store.has(p)) {
        const e = new Error(`ENOENT: ${p}`);
        e.code = 'ENOENT';
        throw e;
      }
      return store.get(p);
    },
    writeFileSync: (p, contents) => store.set(p, contents),
    _store: store,
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

describe('SecurityService commit and push', () => {
  const dirty = { stdout: ' M package.json\n M media-caster/package-lock.json\n' };

  it('rebases onto the fetched remote tip before pushing', async () => {
    const { service, calls } = makeService({
      responses: {
        'git status --porcelain': dirty,
        'rev-parse HEAD': { stdout: 'abc123\n' },
        'rev-parse origin/main': { stdout: 'abc123\n' },
      },
    });

    const result = await service._commitAndPushChanges(ROOT);
    expect(result).toMatchObject({ changed: true, committed: true, pushed: true, failureReason: null });

    const order = calls.map((c) => c.cmd);
    const fetchAt = order.findIndex((c) => c.includes('git fetch origin main'));
    const rebaseAt = order.findIndex((c) => c.includes('rebase --autostash origin/main'));
    const pushAt = order.findIndex((c) => c.includes('git push origin HEAD:main'));
    expect(fetchAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeLessThan(rebaseAt);
    expect(rebaseAt).toBeLessThan(pushAt);
  });

  it('reports a push rejected for credentials distinctly from one behind the remote', async () => {
    const credentials = makeService({
      responses: {
        'git status --porcelain': dirty,
        'git push': { code: 128, stderr: 'git@github.com: Permission denied (publickey).' },
      },
    });
    expect(await credentials.service._commitAndPushChanges(ROOT)).toMatchObject({
      committed: true,
      pushed: false,
      failureReason: 'credentials',
    });

    const stale = makeService({
      responses: {
        'git status --porcelain': dirty,
        'git push': { code: 1, stderr: '! [rejected] main -> main (non-fast-forward)' },
      },
    });
    expect(await stale.service._commitAndPushChanges(ROOT)).toMatchObject({
      pushed: false,
      failureReason: 'non-fast-forward',
    });
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

  it('does not call a push "landed" when origin never moved', async () => {
    const { service } = makeService({
      responses: {
        'git status --porcelain': dirty,
        'rev-parse HEAD': { stdout: 'aaaaaaa\n' },
        'rev-parse origin/main': { stdout: 'bbbbbbb\n' },
      },
    });

    const result = await service._commitAndPushChanges(ROOT);
    expect(result.pushed).toBe(false);
    expect(result.failureReason).toBe('remote-not-updated');
  });

  it('aborts a conflicted rebase instead of leaving the repo mid-rebase', async () => {
    const { service, calls } = makeService({
      responses: {
        'git status --porcelain': dirty,
        'rebase --autostash': { code: 1, stderr: 'CONFLICT (content): package-lock.json' },
      },
    });

    const result = await service._commitAndPushChanges(ROOT);
    expect(result.failureReason).toBe('rebase-conflict');
    expect(calls.some((c) => c.cmd.includes('git rebase --abort'))).toBe(true);
    expect(calls.some((c) => c.cmd.includes('git push'))).toBe(false);
  });

  it('stays quiet when no package files changed', async () => {
    const { service, calls } = makeService({
      responses: { 'git status --porcelain': { stdout: ' M media-caster/boot.js\n' } },
    });

    const result = await service._commitAndPushChanges(ROOT);
    expect(result).toMatchObject({ changed: false, committed: false, pushed: false });
    expect(calls.some((c) => c.cmd.includes('commit'))).toBe(false);
  });

  // A local commit that never lands is what BuildManager read as an update and
  // reset away with a full redeploy, every night.
  it('rolls an unlanded commit back to the pre-run HEAD', async () => {
    const { service, calls } = makeService({
      responses: {
        'git status --porcelain': dirty,
        'rev-parse HEAD': { stdout: '3298b3d7fc23500aaaf3953ee86625cd0d8ac698\n' },
        'git push': { code: 1, stderr: '! [rejected] main -> main (fetch first)' },
      },
    });

    const result = await service._commitAndPushChanges(ROOT);
    expect(result).toMatchObject({ committed: true, pushed: false, rolledBack: true });
    expect(result.failureReason).toBe('non-fast-forward');

    const order = calls.map((c) => c.cmd);
    const preRunAt = order.indexOf('git rev-parse HEAD');
    const commitAt = order.findIndex((c) => c.includes(' commit -m'));
    expect(preRunAt).toBeGreaterThan(-1);
    expect(preRunAt).toBeLessThan(commitAt);
    expect(order[order.length - 1]).toBe('git reset --keep 3298b3d7fc23500aaaf3953ee86625cd0d8ac698');
  });

  it('rolls back after a conflicted rebase too', async () => {
    const { service, calls } = makeService({
      responses: {
        'git status --porcelain': dirty,
        'rev-parse HEAD': { stdout: 'abc1234\n' },
        'rebase --autostash': { code: 1, stderr: 'CONFLICT (content): package-lock.json' },
      },
    });

    const result = await service._commitAndPushChanges(ROOT);
    expect(result).toMatchObject({ failureReason: 'rebase-conflict', rolledBack: true });
    const order = calls.map((c) => c.cmd);
    expect(order.indexOf('git rebase --abort')).toBeLessThan(order.indexOf('git reset --keep abc1234'));
  });

  it('does not roll back a commit that landed', async () => {
    const { service, calls } = makeService({
      responses: {
        'git status --porcelain': dirty,
        'rev-parse HEAD': { stdout: 'abc1234\n' },
        'rev-parse origin/main': { stdout: 'abc1234\n' },
      },
    });

    const result = await service._commitAndPushChanges(ROOT);
    expect(result).toMatchObject({ pushed: true, rolledBack: false });
    expect(calls.some((c) => c.cmd.includes('reset'))).toBe(false);
  });

  it('says so when the rollback itself is refused', async () => {
    const { service } = makeService({
      responses: {
        'git status --porcelain': dirty,
        'rev-parse HEAD': { stdout: 'abc1234\n' },
        'git push': { code: 128, stderr: 'Permission denied (publickey).' },
        'reset --keep': { code: 128, stderr: 'error: Entry package.json would be overwritten' },
      },
    });

    const result = await service._commitAndPushChanges(ROOT);
    expect(result).toMatchObject({ committed: true, pushed: false, rolledBack: false });
    expect(service.log.error).toHaveBeenCalledWith(expect.stringContaining('Could not roll back'));
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
    const { service, calls } = noPushRun(undefined, { 'git push --dry-run': { code: 0 } });

    const summary = await service.autoFixVulnerabilities();

    expect(summary.mode).toBe('fix');
    expect(summary.pushBlocked).toBeNull();
    expect(calls.some((c) => c.cmd.includes('npm audit fix'))).toBe(true);
  });
});

describe('SecurityService run reporting', () => {
  function fullRun(extraResponses = {}) {
    return makeService({
      files: {
        [pkgFile(ROOT)]: JSON.stringify({ overrides: {} }),
        [lockFile(ROOT)]: JSON.stringify({ packages: {} }),
        [pkgFile(MC)]: JSON.stringify({ overrides: {} }),
        [lockFile(MC)]: JSON.stringify({ packages: {} }),
      },
      responses: {
        'npm audit --json': {
          stdout: JSON.stringify({
            vulnerabilities: {},
            metadata: { vulnerabilities: { critical: 0, high: 0 } },
          }),
        },
        ...extraResponses,
      },
    });
  }

  it('publishes the outcome so a failed run is visible off the Pi', async () => {
    const publishSecurityInfo = jest.fn().mockResolvedValue(true);
    // The probe passes but the real push is still refused.
    const { service } = fullRun({
      'git push --dry-run': { code: 0 },
      'git status --porcelain': { stdout: ' M package-lock.json\n' },
      'git push': { code: 128, stderr: 'Permission denied (publickey).' },
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

  // committed && !pushed reads the same whether the commit was undone or left
  // behind; only rolledBack tells them apart off the Pi.
  it('publishes whether an unlanded commit was rolled back', async () => {
    const run = (resetResult) => {
      const publishSecurityInfo = jest.fn().mockResolvedValue(true);
      const { service } = fullRun({
        'git push --dry-run': { code: 0 },
        'git status --porcelain': { stdout: ' M package-lock.json\n' },
        'rev-parse HEAD': { stdout: 'abc1234\n' },
        'git push': { code: 1, stderr: 'remote: error: GH006: Protected branch update failed' },
        'reset --keep': resetResult,
      });
      service.firestoreSync = { publishSecurityInfo };
      return service.autoFixVulnerabilities().then(() => publishSecurityInfo.mock.calls[0][0]);
    };

    expect(await run({ code: 0 })).toMatchObject({ committed: true, pushed: false, rolledBack: true, failureReason: 'protected' });
    expect(await run({ code: 128, stderr: 'fatal: Cannot do a keep reset in the middle of a merge.' })).toMatchObject({
      committed: true,
      pushed: false,
      rolledBack: false,
    });
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
    expect(summary).toMatchObject({ ok: true, remainingHighCritical: 0, failureReason: null });
    expect(summary.needsHuman).toEqual([]);
  });

  it('never throws out of the nightly job', async () => {
    const { service } = fullRun();
    service._processWorkspace = jest.fn().mockRejectedValue(new Error('npm exploded'));
    const summary = await service.autoFixVulnerabilities();
    expect(summary.ok).toBe(false);
    expect(summary.failureReason).toContain('npm exploded');
  });

  it('keeps the original new SecurityService(console) signature working', () => {
    const service = new SecurityService(console);
    expect(service.log).toBe(console);
    expect(typeof service.runExec).toBe('function');
    expect(service.branch).toBe('main');
  });
});
