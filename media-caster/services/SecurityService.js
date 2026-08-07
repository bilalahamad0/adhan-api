const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const semver = require('semver');

const EXEC_TIMEOUT_MS = 10 * 60_000;
// `npm audit --json` over a full tree runs to hundreds of KB. exec's 1MB default
// maxBuffer truncates silently, and a truncated document fails JSON.parse — which
// this service used to swallow and treat as "no vulnerabilities".
const MAX_BUFFER = 32 * 1024 * 1024;

// Never rewrite these. `ip` resolves to a local file patch (media-caster/ip-patch);
// any version override would quietly undo it.
const NEVER_OVERRIDE = new Set(['ip']);

// Package names arrive from npm audit output, which is data — not something to
// interpolate into a shell command unchecked.
const SAFE_PKG_NAME = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;

// Override values that point somewhere other than the registry are deliberate
// and hand-made; leave them alone.
const NON_VERSION_SPEC = /^(file:|link:|npm:|git|https?:)/i;

function defaultRunExec(command, { cwd, timeoutMs = EXEC_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      // Never rejects: `npm audit fix` exits 1 when vulnerabilities remain, and
      // that is a normal outcome we want to read, not an exception.
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

/**
 * Nightly dependency auto-fixer: prune stale overrides, run `npm audit fix`,
 * pin whatever it could not reach, then commit and push.
 *
 * Two rules shape the whole design:
 *
 *  1. Never resolve an override to "*". That ignores major boundaries — for
 *     js-yaml it lands on 5.x while pm2 pins 4.3.0 and @istanbuljs/load-nyc-config
 *     needs 3.x, an API break in both. Overrides are scoped to the consumer that
 *     pulls the vulnerable package and pinned to the first patched version inside
 *     the major already installed.
 *
 *  2. A run that cannot land its fix must say so. The previous version logged
 *     push failures to stdout and returned; nothing else observed the result, so
 *     51 alerts accumulated while the job "ran" nightly for months.
 */
class SecurityService {
  constructor(options = {}) {
    // Back-compat with the original `new SecurityService(console)` signature.
    const opts =
      options && typeof options.log === 'function' && !options.logger && !options.runExec
        ? { logger: options }
        : options || {};

    this.log = opts.logger || console;
    this.runExec = opts.runExec || defaultRunExec;
    this.fs = opts.fsApi || fs;
    this.repoRoot = opts.repoRoot || path.join(__dirname, '../../');
    this.mediaCasterDir = opts.mediaCasterDir || path.join(__dirname, '../');
    this.firestoreSync = opts.firestoreSync || null;
    this.branch = opts.branch || 'main';
    this.gitEmail =
      opts.gitEmail || process.env.SECURITY_GIT_EMAIL || 'security-bot@adhan-api.local';
    this.gitName = opts.gitName || process.env.SECURITY_GIT_NAME || 'Adhan Security Bot';
    this._versionCache = new Map();
  }

  _say(msg) {
    if (this.log && typeof this.log.log === 'function') this.log.log(msg);
  }

  _warn(msg) {
    if (this.log && typeof this.log.error === 'function') this.log.error(msg);
    else this._say(msg);
  }

  // --- reading state -------------------------------------------------------

  async _audit(dir) {
    const { stdout } = await this.runExec('npm audit --json', { cwd: dir });
    try {
      const parsed = JSON.parse(stdout);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      this._warn(`⚠️ [SecurityService] Unreadable npm audit output in ${dir}; skipping overrides.`);
      return null;
    }
  }

  _readJson(file) {
    try {
      if (!this.fs.existsSync(file)) return null;
      return JSON.parse(this.fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  _readPkg(dir) {
    return this._readJson(path.join(dir, 'package.json'));
  }

  _readLock(dir) {
    return this._readJson(path.join(dir, 'package-lock.json'));
  }

  _writePkg(dir, pkg) {
    this.fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  }

  /** name -> Set(installed versions), from every node_modules path in the lockfile. */
  _installedIndex(lock) {
    const index = new Map();
    const packages = (lock && lock.packages) || {};
    for (const [key, meta] of Object.entries(packages)) {
      const marker = key.lastIndexOf('node_modules/');
      if (marker === -1 || !meta || !meta.version) continue;
      const name = key.slice(marker + 'node_modules/'.length);
      if (!index.has(name)) index.set(name, new Set());
      index.get(name).add(meta.version);
    }
    return index;
  }

  /**
   * True when an advisory names this package directly. npm also lists packages
   * that are vulnerable only through a dependency — pm2 appears with
   * `via: ['js-yaml']` — and those resolve when the child does. Acting on them
   * would mean chasing a patched pm2 that does not exist and reporting a
   * phantom "needs human" every night.
   */
  _hasDirectAdvisory(details) {
    return ((details && details.via) || []).some((via) => via && typeof via === 'object');
  }

  /** Every version range an advisory calls vulnerable for one package. */
  _vulnerableRanges(details) {
    const ranges = new Set();
    if (details && details.range) ranges.add(details.range);
    for (const via of (details && details.via) || []) {
      if (via && typeof via === 'object' && via.range) ranges.add(via.range);
    }
    return [...ranges].filter((r) => semver.validRange(r));
  }

  async _versionsOf(pkg) {
    if (this._versionCache.has(pkg)) return this._versionCache.get(pkg);
    if (!SAFE_PKG_NAME.test(pkg)) {
      this._warn(`⚠️ [SecurityService] Refusing to query suspicious package name: ${pkg}`);
      this._versionCache.set(pkg, []);
      return [];
    }
    const { stdout } = await this.runExec(`npm view ${pkg} versions --json`, { cwd: this.repoRoot });
    let versions = [];
    try {
      const parsed = JSON.parse(stdout);
      versions = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      versions = [];
    }
    versions = versions.filter((v) => typeof v === 'string' && semver.valid(v));
    this._versionCache.set(pkg, versions);
    return versions;
  }

  /**
   * Lowest published version that no advisory range covers, staying inside the
   * major already installed so the consumer does not take an API break. Returns
   * null when the major has no patched release — that case needs a human, and
   * saying so is better than forcing a major bump under a cron job.
   */
  _pickSafeVersion(versions, ranges, installed) {
    const pinnedMajor = installed && semver.valid(installed) ? semver.major(installed) : null;
    return (
      versions
        .filter((v) => !semver.prerelease(v))
        .filter((v) => (installed && semver.valid(installed) ? semver.gte(v, installed) : true))
        .filter((v) => pinnedMajor === null || semver.major(v) === pinnedMajor)
        .sort(semver.compare)
        .find((v) => !ranges.some((r) => semver.satisfies(v, r))) || null
    );
  }

  /**
   * Which package pulls in the vulnerable one, and at what version it sits.
   * "node_modules/pm2/node_modules/js-yaml" names its own consumer; a hoisted
   * "node_modules/js-yaml" does not, so the advisory's `effects` fills in.
   */
  _nodeFacts(details, lock) {
    const packages = (lock && lock.packages) || {};
    const facts = [];
    for (const node of (details && details.nodes) || []) {
      const segments = node
        .split('node_modules/')
        .map((s) => s.replace(/\/$/, ''))
        .filter(Boolean);
      facts.push({
        node,
        consumer: segments.length > 1 ? segments[segments.length - 2] : null,
        installed: (packages[node] && packages[node].version) || null,
      });
    }
    if (!facts.length) facts.push({ node: null, consumer: null, installed: null });
    return facts;
  }

  /** "ws@8.20.0" -> { name: 'ws', version: '8.20.0' }; plain keys return null. */
  _parseConditionalKey(key) {
    const at = key.lastIndexOf('@');
    if (at <= 0) return null;
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (!semver.valid(version)) return null;
    return { name, version };
  }

  /** The concrete version an override points at, for "1.2.3" and { ".": "1.2.3" } alike. */
  _pinnedVersion(value) {
    const raw = value && typeof value === 'object' ? value['.'] : value;
    if (typeof raw !== 'string' || NON_VERSION_SPEC.test(raw)) return null;
    return semver.valid(raw) ? raw : null;
  }

  _setScopedOverride(overrides, consumer, dep, version) {
    const existing = overrides[consumer];
    if (existing && typeof existing === 'object') {
      existing[dep] = version;
    } else if (typeof existing === 'string') {
      // Keep any pin on the consumer itself; npm spells that ".".
      overrides[consumer] = { '.': existing, [dep]: version };
    } else {
      overrides[consumer] = { [dep]: version };
    }
  }

  // --- the two repairs -----------------------------------------------------

  /**
   * Overrides this service wrote in the past can rot into traps. The live
   * example: `"ws@8.20.0": { ".": "8.20.1" }` held ws at 8.20.1, which is itself
   * vulnerable (GHSA-96hv-2xvq-fx4p wants >= 8.21.0), so `npm audit fix` could
   * never resolve ws. Runs before audit fix so it cannot block the fix.
   *
   * Two rules, both conservative:
   *   - a conditional key whose trigger version is no longer installed is dead, so drop it
   *   - a pin sitting inside a live advisory range gets moved to the first patched version
   * Range-style defensive pins ("^5.31.3") and file: specs are left untouched.
   */
  async _pruneStaleOverrides(dir, audit, lock) {
    const result = { changed: false, pruned: [], repaired: [] };
    const pkg = this._readPkg(dir);
    if (!pkg || !pkg.overrides) return result;

    const installed = this._installedIndex(lock);
    const vulns = (audit && audit.vulnerabilities) || {};
    const before = JSON.stringify(pkg.overrides);

    for (const key of Object.keys(pkg.overrides)) {
      const conditional = this._parseConditionalKey(key);
      const name = conditional ? conditional.name : key;
      if (NEVER_OVERRIDE.has(name)) continue;

      if (conditional) {
        const versions = installed.get(conditional.name);
        if (!versions || !versions.has(conditional.version)) {
          delete pkg.overrides[key];
          result.pruned.push(key);
          this._say(`🧹 [SecurityService] Dropped dead override "${key}" (trigger not installed).`);
          continue;
        }
      }

      const pinned = this._pinnedVersion(pkg.overrides[key]);
      if (!pinned) continue;
      const ranges = this._vulnerableRanges(vulns[name]);
      if (!ranges.length || !ranges.some((r) => semver.satisfies(pinned, r))) continue;

      const safe = this._pickSafeVersion(await this._versionsOf(name), ranges, pinned);
      if (!safe) continue;
      if (pkg.overrides[key] && typeof pkg.overrides[key] === 'object') pkg.overrides[key]['.'] = safe;
      else pkg.overrides[key] = safe;
      result.repaired.push({ key, from: pinned, to: safe });
      this._say(`🧹 [SecurityService] Override "${key}" pinned a vulnerable ${pinned} → ${safe}.`);
    }

    if (JSON.stringify(pkg.overrides) !== before) {
      this._writePkg(dir, pkg);
      result.changed = true;
    }
    return result;
  }

  /**
   * Pin whatever `npm audit fix` could not resolve on its own — scoped to the
   * consumer, inside its existing major. Replaces the old `overrides[name] = "*"`,
   * which resolved to latest across the whole tree regardless of majors.
   */
  async _enforceOverridesForRemainingVulnerabilities(dir, audit, lock) {
    const result = { changed: false, applied: [], unresolved: [] };
    const pkg = this._readPkg(dir);
    if (!pkg) return result;

    const vulns = (audit && audit.vulnerabilities) || {};
    if (!Object.keys(vulns).length) {
      this._say(`✅ [SecurityService] No remaining vulnerabilities in ${dir}.`);
      return result;
    }

    pkg.overrides = pkg.overrides || {};
    const before = JSON.stringify(pkg.overrides);

    for (const [name, details] of Object.entries(vulns)) {
      if (details.severity !== 'high' && details.severity !== 'critical') continue;
      if (NEVER_OVERRIDE.has(name)) continue;
      if (!this._hasDirectAdvisory(details)) continue;

      const ranges = this._vulnerableRanges(details);
      if (!ranges.length) continue;

      const versions = await this._versionsOf(name);
      if (!versions.length) {
        result.unresolved.push({ package: name, reason: 'no published versions readable' });
        continue;
      }

      const effectConsumers = (details.effects || []).filter((e) => SAFE_PKG_NAME.test(e));

      for (const fact of this._nodeFacts(details, lock)) {
        const safe = this._pickSafeVersion(versions, ranges, fact.installed);
        if (!safe) {
          result.unresolved.push({
            package: name,
            installed: fact.installed,
            severity: details.severity,
            reason: 'no patched version inside the installed major',
          });
          this._warn(
            `⚠️ [SecurityService] ${name}@${fact.installed || '?'} (${details.severity}) has no ` +
              `patched release in its major. Leaving it for a human rather than forcing a major bump.`
          );
          continue;
        }

        const consumers = fact.consumer ? [fact.consumer] : effectConsumers;
        if (consumers.length) {
          for (const consumer of consumers) this._setScopedOverride(pkg.overrides, consumer, name, safe);
        } else {
          pkg.overrides[name] = safe;
        }
        result.applied.push({ package: name, version: safe, consumers: consumers.length ? consumers : ['<root>'] });
        this._say(
          `🔒 [SecurityService] Pinning ${name} -> ${safe}` +
            (consumers.length ? ` under ${consumers.join(', ')}` : ' at the root') +
            ` (was ${fact.installed || 'unknown'}).`
        );
      }
    }

    if (JSON.stringify(pkg.overrides) !== before) {
      this._writePkg(dir, pkg);
      result.changed = true;
    }
    return result;
  }

  // --- workspace pipeline --------------------------------------------------

  async _runAuditFix(dir) {
    this._say(`🔒 [SecurityService] Running 'npm audit fix' in ${dir}...`);
    const { stdout, stderr, code } = await this.runExec('npm audit fix --no-fund', { cwd: dir });
    this._say(`🔒 [SecurityService] npm audit fix (code ${code}):\n${stdout}`);
    if (stderr) this._say(`⚠️ [SecurityService] npm audit fix stderr:\n${stderr}`);
  }

  async _install(dir) {
    const { code, stderr } = await this.runExec('npm install --no-audit --no-fund', { cwd: dir });
    if (code !== 0) this._warn(`❌ [SecurityService] npm install failed in ${dir}: ${stderr.slice(0, 300)}`);
    return code === 0;
  }

  async _processWorkspace(dir) {
    const summary = { dir, pruned: [], repaired: [], applied: [], unresolved: [], remainingHighCritical: 0 };

    const prune = await this._pruneStaleOverrides(dir, await this._audit(dir), this._readLock(dir));
    summary.pruned = prune.pruned;
    summary.repaired = prune.repaired;
    if (prune.changed) await this._install(dir);

    await this._runAuditFix(dir);

    const enforce = await this._enforceOverridesForRemainingVulnerabilities(
      dir,
      await this._audit(dir),
      this._readLock(dir)
    );
    summary.applied = enforce.applied;
    summary.unresolved = enforce.unresolved;
    if (enforce.changed) await this._install(dir);

    const finalAudit = await this._audit(dir);
    const counts = (finalAudit && finalAudit.metadata && finalAudit.metadata.vulnerabilities) || {};
    summary.remainingHighCritical = (counts.high || 0) + (counts.critical || 0);
    return summary;
  }

  // --- landing the fix -----------------------------------------------------

  static classifyPushFailure(text) {
    const s = String(text || '').toLowerCase();
    if (/permission denied|publickey|authentication failed|could not read username|access rights|terminal prompts disabled|403/.test(s))
      return 'credentials';
    if (/non-fast-forward|fetch first|\[rejected\]|stale info|behind its remote/.test(s))
      return 'non-fast-forward';
    if (/could not resolve host|connection refused|timed out|network is unreachable/.test(s))
      return 'network';
    return 'unknown';
  }

  /**
   * Commit the manifest changes and land them on origin.
   *
   * The old version ran a bare `git push origin HEAD:main` and reported success
   * on the basis of an exit code nobody read. Two things changed:
   *
   *  - Rebase onto the fetched remote tip first. BuildManager resets this repo to
   *    a specific sha on every deploy, so by the time this runs the local branch
   *    is routinely behind origin and a plain push is a guaranteed rejection.
   *  - Confirm origin actually moved afterwards, and classify the failure when it
   *    did not, so "credentials" and "non-fast-forward" are distinguishable
   *    without shelling into the Pi.
   */
  async _commitAndPushChanges(projectRoot) {
    const result = { changed: false, committed: false, pushed: false, failureReason: null, detail: null };

    const { stdout: statusOut } = await this.runExec('git status --porcelain', { cwd: projectRoot });
    const touched = statusOut
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && (/package(-lock)?\.json$/.test(l) || l.includes('ip-patch')));

    if (!touched.length) {
      this._say(`✅ [SecurityService] No package changes to commit.`);
      return result;
    }
    result.changed = true;

    await this.runExec('git add package.json package-lock.json', { cwd: projectRoot });
    await this.runExec('git add media-caster/package.json media-caster/package-lock.json media-caster/ip-patch', {
      cwd: projectRoot,
    });

    // Identity stays scoped to the single command — the Pi has no global git user.
    const identity = `-c user.email="${this.gitEmail}" -c user.name="${this.gitName}"`;
    const message = 'chore(security): auto-fix dependabot vulnerabilities and enforce overrides';
    const commit = await this.runExec(`git ${identity} commit -m "${message}"`, { cwd: projectRoot });
    if (commit.code !== 0) {
      result.failureReason = 'commit-failed';
      result.detail = `${commit.stderr || commit.stdout}`.slice(0, 400);
      this._warn(`❌ [SecurityService] Commit failed: ${result.detail}`);
      return result;
    }
    result.committed = true;

    const fetch = await this.runExec(`git fetch origin ${this.branch}`, { cwd: projectRoot });
    if (fetch.code !== 0) {
      result.failureReason = SecurityService.classifyPushFailure(fetch.stderr);
      result.detail = `fetch failed: ${fetch.stderr}`.slice(0, 400);
      this._warn(`❌ [SecurityService] ${result.detail}`);
      return result;
    }

    // --autostash keeps unrelated Pi drift from aborting the rebase.
    const rebase = await this.runExec(`git ${identity} rebase --autostash origin/${this.branch}`, {
      cwd: projectRoot,
    });
    if (rebase.code !== 0) {
      await this.runExec('git rebase --abort', { cwd: projectRoot });
      result.failureReason = 'rebase-conflict';
      result.detail = `${rebase.stderr || rebase.stdout}`.slice(0, 400);
      this._warn(`❌ [SecurityService] Rebase onto origin/${this.branch} failed: ${result.detail}`);
      return result;
    }

    const push = await this.runExec(`git push origin HEAD:${this.branch}`, { cwd: projectRoot });
    if (push.code !== 0) {
      result.failureReason = SecurityService.classifyPushFailure(`${push.stderr}\n${push.stdout}`);
      result.detail = `${push.stderr || push.stdout}`.slice(0, 400);
      this._warn(`❌ [SecurityService] Push rejected (${result.failureReason}): ${result.detail}`);
      return result;
    }

    // A zero exit code is not proof the remote moved. Verify.
    await this.runExec(`git fetch origin ${this.branch}`, { cwd: projectRoot });
    const { stdout: head } = await this.runExec('git rev-parse HEAD', { cwd: projectRoot });
    const { stdout: remote } = await this.runExec(`git rev-parse origin/${this.branch}`, { cwd: projectRoot });
    if (head.trim() && head.trim() === remote.trim()) {
      result.pushed = true;
      this._say(`✅ [SecurityService] Security fixes landed on origin/${this.branch}.`);
    } else {
      result.failureReason = 'remote-not-updated';
      result.detail = `local ${head.trim().slice(0, 7)} != origin ${remote.trim().slice(0, 7)}`;
      this._warn(`❌ [SecurityService] Push reported success but origin did not move (${result.detail}).`);
    }
    return result;
  }

  /**
   * Put the run's outcome somewhere other than a pm2 log line. Same meta/*
   * pattern and privacy linter the build info already uses.
   */
  async _publish(summary) {
    if (!this.firestoreSync || typeof this.firestoreSync.publishSecurityInfo !== 'function') return false;
    const payload = {
      lastRunAt: summary.finishedAt,
      ok: summary.ok,
      committed: summary.committed,
      pushed: summary.pushed,
      failureReason: summary.failureReason,
      remainingHighCritical: summary.remainingHighCritical,
      needsHuman: summary.needsHuman.slice(0, 20),
    };
    try {
      const BuildManager = require('./BuildManager');
      const verdict = BuildManager.assertPrivacy(payload, process.env);
      if (!verdict.ok) {
        this._warn(`❌ [SecurityService] Refusing to publish run summary: ${verdict.reason}`);
        return false;
      }
    } catch {
      /* linter unavailable — the payload carries counts and reasons only */
    }
    try {
      return await this.firestoreSync.publishSecurityInfo(payload);
    } catch (e) {
      this._warn(`⚠️ [SecurityService] publishSecurityInfo failed: ${e.message}`);
      return false;
    }
  }

  /** Entry point for the nightly job. Always resolves; returns the run summary. */
  async autoFixVulnerabilities() {
    this._say(`🛡️  [SecurityService] Starting daily Dependabot auto-fix routine...`);
    const summary = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ok: false,
      workspaces: [],
      committed: false,
      pushed: false,
      failureReason: null,
      needsHuman: [],
      remainingHighCritical: 0,
    };

    try {
      for (const dir of [this.repoRoot, this.mediaCasterDir]) {
        summary.workspaces.push(await this._processWorkspace(dir));
      }

      const push = await this._commitAndPushChanges(this.repoRoot);
      summary.committed = push.committed;
      summary.pushed = push.pushed;
      summary.failureReason = push.failureReason;
      summary.needsHuman = summary.workspaces.flatMap((w) => w.unresolved);
      summary.remainingHighCritical = summary.workspaces.reduce(
        (n, w) => n + w.remainingHighCritical,
        0
      );
      // Nothing to push is a clean outcome; failing to push is not.
      summary.ok = !summary.failureReason && summary.remainingHighCritical === 0;
    } catch (error) {
      summary.failureReason = `exception: ${error.message}`;
      this._warn(`❌ [SecurityService] Error during auto-fix routine: ${error.message}`);
    }

    summary.finishedAt = new Date().toISOString();
    await this._publish(summary);

    if (summary.ok) {
      this._say(`🛡️  [SecurityService] Routine completed clean.`);
    } else {
      this._warn(
        `❌ [SecurityService] Routine finished UNRESOLVED — ` +
          `${summary.remainingHighCritical} high/critical left, ` +
          `pushed=${summary.pushed}, reason=${summary.failureReason || 'none'}.`
      );
    }
    return summary;
  }
}

module.exports = SecurityService;
