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
    const { service } = fullRun({
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
