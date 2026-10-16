const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { DateTime } = require('luxon');

const SAFE_PRAYER_GAP_MIN = 5;
const PRIORITY_BY_TYPE = {
  fix: 'high',
  hotfix: 'high',
  perf: 'high',
  feat: 'medium',
  refactor: 'medium',
  chore: 'low',
  docs: 'low',
  style: 'low',
  test: 'low',
  build: 'low',
  ci: 'low',
};
const KNOWN_TYPES = Object.keys(PRIORITY_BY_TYPE);
// pm2 apps a deploy reloads, in order (names from ecosystem.config.cjs).
const PM2_APPS = ['adhan-caster', 'adb-keeper', 'auto-updater'];
// Right after the deploy's npm ci writes, the pm2 CLI on the Pi took 54-144s
// just to reach the daemon; the old 30s limit killed every reload from
// 2026-10-06 on.
const PM2_RELOAD_TIMEOUT_MS = 5 * 60_000;
// SecurityService's commit identity; SECURITY_GIT_EMAIL overrides it in both.
const SECURITY_BOT_EMAIL = 'security-bot@adhan-api.local';
// The only files a SecurityService commit stages.
const MANIFEST_PATH = /(^|\/)(package(-lock)?\.json|ip-patch\/.+)$/;
const SHA = /^[0-9a-f]{7,40}$/i;

function defaultRunExec(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: opts.timeoutMs || 60_000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

class BuildManager {
  constructor({
    repoRoot,
    stagingPath,
    dataDir,
    branch = 'main',
    smokeRunner,
    firestoreSync = null,
    runExec = defaultRunExec,
    fsApi = fs,
    log = console.log,
    nowFn = () => DateTime.now(),
    prayerWindowProvider = null,
    timezone = 'America/Los_Angeles',
    pm2Apps = PM2_APPS,
    selfPm2App = null,
    securityBotEmail = process.env.SECURITY_GIT_EMAIL || SECURITY_BOT_EMAIL,
  } = {}) {
    if (!repoRoot) throw new Error('BuildManager requires repoRoot');
    if (!stagingPath) throw new Error('BuildManager requires stagingPath');
    if (!dataDir) throw new Error('BuildManager requires dataDir');
    if (!smokeRunner) throw new Error('BuildManager requires smokeRunner');

    this.repoRoot = repoRoot;
    this.stagingPath = stagingPath;
    this.dataDir = dataDir;
    this.branch = branch;
    this.smokeRunner = smokeRunner;
    this.firestoreSync = firestoreSync;
    this.runExec = runExec;
    this.fs = fsApi;
    this.log = log;
    this.nowFn = nowFn;
    this.prayerWindowProvider = prayerWindowProvider;
    this.timezone = timezone;
    this.pm2Apps = pm2Apps;
    this.selfPm2App = selfPm2App;
    this.securityBotEmail = securityBotEmail;
    this._inProgress = false;
    this._fileModeApplied = false;
    this._buildInfoPath = path.join(dataDir, 'build-info.json');
    this._sentinelPath = path.join(repoRoot, '.deploy-in-progress');
  }

  isLocked() { return this._inProgress; }

  async checkForUpdate() {
    await this.runExec(`git -C ${this.repoRoot} fetch origin ${this.branch} --quiet`, { timeoutMs: 60_000 });
    const { stdout: head } = await this.runExec(`git -C ${this.repoRoot} rev-parse HEAD`);
    const { stdout: remote } = await this.runExec(`git -C ${this.repoRoot} rev-parse origin/${this.branch}`);
    const currentSha = head.trim();
    const newSha = remote.trim();
    if (!newSha || !currentSha) throw new Error('git rev-parse returned empty SHA');
    if (currentSha === newSha) return { currentSha, newSha: null };
    const localOnly = await this._unpushedSecurityCommits(currentSha, newSha);
    if (localOnly > 0) {
      this.log(`[BuildManager] HEAD is the deployed origin/${this.branch} plus ${localOnly} unpushed security-bot commit(s); nothing to deploy`);
      return { currentSha, newSha: null, localOnly };
    }
    return { currentSha, newSha };
  }

  /**
   * How many commits HEAD carries on top of origin when every one of them is a
   * SecurityService commit that never reached origin; 0 otherwise. Redeploying
   * origin over those only resets them away: the Pi ran that loop nightly, a
   * 00:01 security commit followed by a 02:00 reset and full redeploy.
   *
   * Only applies when build-info.json says origin's tip is what is deployed,
   * since a security rebase can move the files on disk to a newer origin
   * without a deploy, and that still needs one. Any doubt returns 0, which
   * deploys as before.
   */
  async _unpushedSecurityCommits(currentSha, remoteSha) {
    const deployed = this.readBuildInfo();
    if (!deployed || deployed.sha !== remoteSha) return 0;
    if (!SHA.test(currentSha) || !SHA.test(remoteSha)) return 0;
    const git = `git -C ${this.repoRoot}`;
    try {
      const { stdout: behind } = await this.runExec(`${git} rev-list --count ${currentSha}..${remoteSha}`);
      if (behind.trim() !== '0') return 0;
      const { stdout: authors } = await this.runExec(`${git} log --format=%ae ${remoteSha}..${currentSha}`);
      const commits = authors.split('\n').map((a) => a.trim()).filter(Boolean);
      if (!commits.length || !commits.every((a) => a === this.securityBotEmail)) return 0;
      const { stdout: files } = await this.runExec(`${git} diff --name-only ${remoteSha} ${currentSha}`);
      if (!files.split('\n').filter(Boolean).every((f) => MANIFEST_PATH.test(f.trim()))) return 0;
      return commits.length;
    } catch {
      return 0;
    }
  }

  async safeToApply() {
    if (!this.prayerWindowProvider) return { safe: true };
    const now = this.nowFn();
    const upcoming = await this.prayerWindowProvider();
    if (!upcoming || !Array.isArray(upcoming) || upcoming.length === 0) return { safe: true };
    for (const p of upcoming) {
      const dt = DateTime.fromISO(p.iso, { zone: this.timezone });
      if (!dt.isValid) continue;
      const diffMin = dt.diff(now, 'minutes').minutes;
      if (diffMin >= 0 && diffMin < SAFE_PRAYER_GAP_MIN) {
        return { safe: false, reason: `Prayer ${p.name} starts in ${diffMin.toFixed(1)} min` };
      }
    }
    return { safe: true };
  }

  async attemptUpdate({ targetSha = null, dryRun = false, force = false } = {}) {
    if (this._inProgress) {
      return { success: false, reason: 'update-already-in-progress' };
    }
    this._inProgress = true;
    const startedAt = this.nowFn().toISO();
    const result = {
      success: false,
      reason: null,
      startedAt,
      sha: null,
      previousSha: null,
      smokeResult: null,
      drift: null,
      postSwapDrift: null,
      stage: 'init',
    };

    try {
      if (!force) {
        const guard = await this.safeToApply();
        if (!guard.safe) {
          result.reason = `prayer-window-guard: ${guard.reason}`;
          result.stage = 'guard';
          return result;
        }
      }

      await this._ensureFileMode();

      result.stage = 'drift-preflight';
      const drift = await this._detectDrift();
      result.drift = drift;
      if (drift && drift.total > 0) {
        this.log(`[BuildManager] drift detected: ${drift.total} items (${drift.modified.length} modified, ${drift.deleted.length} deleted, ${drift.untracked.length} untracked, ${drift.modeOnly.length} mode-only)`);
        if (drift.modified.length > 0) this.log(`[BuildManager]   modified: ${drift.modified.slice(0, 5).join(', ')}${drift.modified.length > 5 ? ' ...' : ''}`);
        if (drift.untracked.length > 0) this.log(`[BuildManager]   untracked: ${drift.untracked.slice(0, 5).join(', ')}${drift.untracked.length > 5 ? ' ...' : ''}`);
        if (drift.modeOnly.length > 0) this.log(`[BuildManager]   mode-only: ${drift.modeOnly.slice(0, 5).join(', ')}${drift.modeOnly.length > 5 ? ' ...' : ''}`);
        if (drift.deleted.length > 0) this.log(`[BuildManager]   deleted: ${drift.deleted.slice(0, 5).join(', ')}${drift.deleted.length > 5 ? ' ...' : ''}`);
      } else {
        this.log('[BuildManager] drift preflight: working tree clean');
      }

      result.stage = 'check';
      const { currentSha } = await this._currentSha();
      result.previousSha = currentSha;

      let newSha = targetSha;
      if (!newSha) {
        const upd = await this.checkForUpdate();
        if (!upd.newSha) {
          // After a swap, HEAD already equals origin, so an app whose reload
          // failed would stay on old code until the next commit. Retry it here.
          const pending = this.readBuildInfo()?.pendingReload;
          if (!dryRun && Array.isArray(pending) && pending.length > 0) {
            return await this._retryPendingReload(pending, result);
          }
          result.success = true;
          result.reason = 'no-update';
          await this._publishCurrentState(upd.currentSha);
          return result;
        }
        newSha = upd.newSha;
      }
      result.sha = newSha;

      result.stage = 'staging';
      await this._prepareStaging(newSha);

      result.stage = 'deps';
      await this._installDeps();

      result.stage = 'smoke';
      const smoke = await this.smokeRunner.run({ stagingPath: this.stagingPath });
      result.smokeResult = {
        passed: smoke.passed,
        failed: smoke.failed,
        failedChecks: smoke.failedChecks,
        durationMs: smoke.durationMs,
        reason: smoke.reason,
      };
      if (!smoke.ok) {
        result.reason = `smoke-failed:${smoke.reason}`;
        await this._writeFailure(result);
        return result;
      }

      if (dryRun) {
        result.stage = 'dry-run';
        result.success = true;
        result.reason = 'dry-run-passed';
        return result;
      }

      const guard2 = force ? { safe: true } : await this.safeToApply();
      if (!guard2.safe) {
        result.stage = 'guard-late';
        result.reason = `prayer-window-guard: ${guard2.reason}`;
        await this._writeFailure(result);
        return result;
      }

      result.stage = 'swap';
      await this._atomicSwap(newSha);

      result.stage = 'post-swap-check';
      const postDrift = await this._detectDrift();
      result.postSwapDrift = postDrift;
      if (postDrift && postDrift.total > 0) {
        this.log(`[BuildManager] post-swap drift: ${postDrift.total} items remain (${postDrift.modified.length} modified, ${postDrift.untracked.length} untracked, ${postDrift.modeOnly.length} mode-only)`);
      }

      result.stage = 'publish';
      const versionInfo = await this._computeVersionLabel(newSha);
      const buildRecord = {
        currentVersion: versionInfo.version,
        currentShortSha: versionInfo.shortSha,
        currentDeployedAt: this.nowFn().toISO(),
        currentChangePriority: versionInfo.priority,
        previousVersion: await this._previousVersionLabel(),
        previousShortSha: currentSha ? currentSha.slice(0, 7) : null,
        lastSuccessfulSmoke: {
          passed: smoke.passed,
          failed: smoke.failed,
          ts: this.nowFn().toISO(),
        },
        lastFailure: await this._readPreviousFailure(),
        driftSnapshot: BuildManager.summarizeDrift(drift),
        postSwapDrift: BuildManager.summarizeDrift(postDrift),
      };

      const privacyCheck = BuildManager.assertPrivacy(buildRecord, process.env);
      if (!privacyCheck.ok) {
        result.stage = 'privacy';
        result.reason = `privacy-violation:${privacyCheck.reason}`;
        await this._writeFailure(result);
        return result;
      }

      await this.writeBuildInfo({
        ...buildRecord,
        sha: newSha,
        previousSha: currentSha,
      });

      if (this.firestoreSync && typeof this.firestoreSync.publishBuildInfo === 'function') {
        try { await this.firestoreSync.publishBuildInfo(buildRecord); }
        catch (e) { this.log(`[BuildManager] publishBuildInfo failed: ${e.message}`); }
      }

      result.stage = 'reload';
      result.version = versionInfo.version;
      const reload = await this._reloadApps();
      result.restartSelf = reload.restartSelf;
      if (reload.failed.length > 0) {
        // The new code is on disk but some app is still running the old code.
        // This counts as a failed deploy, and it is published to meta/build
        // so it shows on the dashboard instead of only in a pm2 log.
        result.reloadFailures = reload.failed;
        result.reason = `reload-failed: ${reload.failed.map((f) => `${f.app} (${f.error})`).join(', ')}`;
        await this._writeFailure(result);
        return result;
      }

      result.success = true;
      result.reason = 'deployed';
      return result;
    } catch (e) {
      result.reason = `${result.stage}-error: ${e.message}`;
      try { await this._writeFailure(result); } catch { /* ignore */ }
      return result;
    } finally {
      try { await this._cleanupStaging(); } catch { /* ignore */ }
      this._inProgress = false;
    }
  }

  async writeBuildInfo(record) {
    if (!this.fs.existsSync(this.dataDir)) this.fs.mkdirSync(this.dataDir, { recursive: true });
    this.fs.writeFileSync(this._buildInfoPath, JSON.stringify(record, null, 2));
  }

  readBuildInfo() {
    try {
      if (!this.fs.existsSync(this._buildInfoPath)) return null;
      return JSON.parse(this.fs.readFileSync(this._buildInfoPath, 'utf8'));
    } catch { return null; }
  }

  async _publishCurrentState(sha) {
    if (!this.firestoreSync || typeof this.firestoreSync.publishBuildInfo !== 'function') return;
    const existing = this.readBuildInfo();
    if (existing && existing.currentVersion) {
      try { await this.firestoreSync.publishBuildInfo(existing); }
      catch (e) { this.log(`[BuildManager] publishCurrentState failed: ${e.message}`); }
      return;
    }
    const versionInfo = await this._computeVersionLabel(sha).catch(() => ({
      version: `v${this.nowFn().toFormat('yyyy.MM.dd')}-chore.0`,
      shortSha: sha.slice(0, 7),
      priority: 'low',
    }));
    const record = {
      currentVersion: versionInfo.version,
      currentShortSha: versionInfo.shortSha || sha.slice(0, 7),
      currentDeployedAt: this.nowFn().toISO(),
      currentChangePriority: versionInfo.priority || 'low',
      lastFailure: null,
    };
    await this.writeBuildInfo({ ...record, sha, previousSha: null });
    try { await this.firestoreSync.publishBuildInfo(record); }
    catch (e) { this.log(`[BuildManager] publishCurrentState failed: ${e.message}`); }
  }

  async _currentSha() {
    const { stdout } = await this.runExec(`git -C ${this.repoRoot} rev-parse HEAD`);
    return { currentSha: stdout.trim() };
  }

  async _ensureFileMode() {
    if (this._fileModeApplied) return;
    try {
      await this.runExec(`git -C ${this.repoRoot} config --local core.fileMode false`);
      this._fileModeApplied = true;
      this.log('[BuildManager] core.fileMode set to false');
    } catch (e) {
      this.log(`[BuildManager] failed to set core.fileMode: ${e.message}`);
    }
  }

  async _detectDrift() {
    try {
      const { stdout: statusOut } = await this.runExec(
        `git -C ${this.repoRoot} status --porcelain=v1 -uall`,
        { timeoutMs: 15_000 },
      );
      let diffSummary = '';
      try {
        const { stdout } = await this.runExec(
          `git -C ${this.repoRoot} diff --summary`,
          { timeoutMs: 15_000 },
        );
        diffSummary = stdout;
      } catch { /* diff --summary is optional */ }
      return BuildManager.parseDriftOutput(statusOut, diffSummary);
    } catch (e) {
      this.log(`[BuildManager] drift detection failed: ${e.message}`);
      return null;
    }
  }

  async _prepareStaging(sha) {
    if (this.fs.existsSync(this.stagingPath)) {
      await this.runExec(`git -C ${this.repoRoot} worktree remove --force ${this.stagingPath}`)
        .catch(() => this.runExec(`rm -rf ${this.stagingPath}`));
    }
    await this.runExec(`git -C ${this.repoRoot} worktree add --detach ${this.stagingPath} ${sha}`, { timeoutMs: 60_000 });
  }

  async _installDeps() {
    await this.runExec(`cd ${this.stagingPath} && npm ci --omit=dev --no-audit --no-fund`, { timeoutMs: 6 * 60_000 });
    const mediaCaster = path.join(this.stagingPath, 'media-caster');
    if (this.fs.existsSync(path.join(mediaCaster, 'package.json'))) {
      await this.runExec(`cd ${mediaCaster} && npm ci --omit=dev --no-audit --no-fund`, { timeoutMs: 6 * 60_000 });
    }
  }

  async _atomicSwap(sha) {
    this.fs.writeFileSync(this._sentinelPath, `${sha}\n${this.nowFn().toISO()}\n`);
    const excludes = [
      // Pi-local data — never overwrite from staging
      '.env', 'audio/', '.adhan-data/', 'annual_schedule.json',
      '.cast-cache.json', 'node_modules/', '.git', '.deploy-in-progress',
      // Dev / test artifacts — keep the release build lean
      '*.test.js', 'tests/', '*.md', 'jest.config*',
      '.github/', '.eslintrc*', '.prettierrc*',
    ].map((p) => `--exclude='${p}'`).join(' ');
    await this.runExec(
      `rsync -a --delete-after ${excludes} ${this.stagingPath}/ ${this.repoRoot}/`,
      { timeoutMs: 5 * 60_000 },
    );
    await this._installLiveDeps();
    await this.runExec(`git -C ${this.repoRoot} fetch origin ${this.branch} --quiet`).catch(() => {});
    await this.runExec(`git -C ${this.repoRoot} reset --hard ${sha}`).catch(() => {});
    if (this.fs.existsSync(this._sentinelPath)) this.fs.unlinkSync(this._sentinelPath);
  }

  async _installLiveDeps() {
    await this.runExec(`cd ${this.repoRoot} && npm ci --omit=dev --no-audit --no-fund`, { timeoutMs: 6 * 60_000 });
    const mediaCaster = path.join(this.repoRoot, 'media-caster');
    if (this.fs.existsSync(path.join(mediaCaster, 'package.json'))) {
      await this.runExec(`cd ${mediaCaster} && npm ci --omit=dev --no-audit --no-fund`, { timeoutMs: 6 * 60_000 });
    }
  }

  /**
   * Reload each pm2 app onto the new code with its own `pm2 reload <name>`.
   * pm2's `reload` takes exactly one name: `pm2 reload a b c` reloads `a` and
   * silently ignores the rest, which left adb-keeper and auto-updater on stale
   * code after every deploy.
   *
   * `exec` hands the shell's PID to the pm2 CLI. On Debian 13, dash keeps
   * `sh -c` as the parent, so a timeout killed only the shell and left the
   * CLI running orphaned, after the deploy had already been reported.
   *
   * Skips selfPm2App, the app this code is running in. pm2 kills a reloading
   * app's whole process tree (treekill), which would also kill the CLI that
   * asked for the reload. The caller restarts that app itself once the cycle
   * is recorded (result.restartSelf).
   */
  async _reloadApps(apps = this.pm2Apps) {
    const failed = [];
    for (const app of apps) {
      if (app === this.selfPm2App) continue;
      const startedMs = Date.now();
      try {
        await this.runExec(`exec pm2 reload ${app}`, { timeoutMs: PM2_RELOAD_TIMEOUT_MS });
        this.log(`[BuildManager] pm2 reload ${app} ok (${((Date.now() - startedMs) / 1000).toFixed(1)}s)`);
      } catch (e) {
        const error = BuildManager.describeExecFailure(e, PM2_RELOAD_TIMEOUT_MS);
        failed.push({ app, error });
        // The CLI output stays in the local log. It can carry paths and env
        // values, so it never goes into the published failure.
        const output = String(e.stderr || e.stdout || '').trim().slice(0, 500);
        this.log(`[BuildManager] pm2 reload ${app} FAILED: ${error}${output ? ` | ${output}` : ''}`);
      }
    }
    return { failed, restartSelf: apps.includes(this.selfPm2App) };
  }

  /**
   * Reload the apps a previous deploy failed to reload. On success, move
   * currentDeployedAt to now. That marks when every app actually got the
   * code, and it clears the dashboard banner (shown while lastFailure.ts >
   * currentDeployedAt). On failure, refresh lastFailure and keep whichever
   * apps are still pending.
   */
  async _retryPendingReload(pending, result) {
    result.stage = 'reload-retry';
    this.log(`[BuildManager] retrying pm2 reload left pending by the last deploy: ${pending.join(', ')}`);
    const reload = await this._reloadApps(pending);
    result.restartSelf = reload.restartSelf;
    if (reload.failed.length > 0) {
      result.reloadFailures = reload.failed;
      result.reason = `reload-failed: ${reload.failed.map((f) => `${f.app} (${f.error})`).join(', ')}`;
      await this._writeFailure(result);
      return result;
    }

    const record = { ...(this.readBuildInfo() || {}), currentDeployedAt: this.nowFn().toISO() };
    delete record.pendingReload;
    await this.writeBuildInfo(record);
    if (this.firestoreSync && typeof this.firestoreSync.publishBuildInfo === 'function') {
      try { await this.firestoreSync.publishBuildInfo(record); }
      catch (e) { this.log(`[BuildManager] publishBuildInfo failed: ${e.message}`); }
    }
    result.success = true;
    result.reason = 'reload-retried';
    return result;
  }

  /** A short cause for a runExec rejection, safe to publish; never its output. */
  static describeExecFailure(e, timeoutMs) {
    if (e?.killed) return `timed out after ${Math.round(timeoutMs / 1000)}s`;
    if (Number.isInteger(e?.code)) return `exit ${e.code}`;
    if (e?.signal) return `killed by ${e.signal}`;
    return 'failed';
  }

  async _cleanupStaging() {
    if (!this.fs.existsSync(this.stagingPath)) return;
    await this.runExec(`git -C ${this.repoRoot} worktree remove --force ${this.stagingPath}`)
      .catch(() => this.runExec(`rm -rf ${this.stagingPath}`));
  }

  async _computeVersionLabel(sha) {
    const { stdout: subject } = await this.runExec(`git -C ${this.stagingPath} log -1 --pretty=%s ${sha}`)
      .catch(async () => this.runExec(`git -C ${this.repoRoot} log -1 --pretty=%s ${sha}`));
    const type = BuildManager.parseConventionalType(subject);
    const priority = PRIORITY_BY_TYPE[type] || 'low';
    const today = this.nowFn().toFormat('yyyy.MM.dd');
    const seq = await this._dailySequence(today, type);
    const shortSha = sha.slice(0, 7);
    return { version: `v${today}-${type}.${seq}`, shortSha, priority, type };
  }

  static parseConventionalType(subject) {
    if (!subject) return 'chore';
    const m = String(subject).trim().match(/^([a-zA-Z]+)(\([^)]+\))?!?:/);
    if (!m) return 'chore';
    const type = m[1].toLowerCase();
    return KNOWN_TYPES.includes(type) ? type : 'chore';
  }

  /**
   * Parse `git status --porcelain=v1 -uall` and optional `git diff --summary`
   * into categorized drift buckets.
   */
  static parseDriftOutput(statusOutput, diffSummary = '') {
    const drift = { modified: [], deleted: [], untracked: [], modeOnly: [], total: 0 };

    const statusLines = (statusOutput || '').split('\n').filter(Boolean);
    for (const line of statusLines) {
      const xy = line.slice(0, 2);
      const filePath = line.slice(3);
      if (xy === '??') {
        drift.untracked.push(filePath);
      } else if (xy.includes('D')) {
        drift.deleted.push(filePath);
      } else {
        drift.modified.push(filePath);
      }
    }

    const modeSet = new Set();
    const modeLines = (diffSummary || '').split('\n').filter((l) => l.includes('mode change'));
    for (const line of modeLines) {
      const match = line.match(/mode change \d+ => \d+ (.+)/);
      if (match) {
        const fp = match[1].trim();
        modeSet.add(fp);
        drift.modeOnly.push(fp);
      }
    }
    if (modeSet.size > 0) {
      drift.modified = drift.modified.filter((f) => !modeSet.has(f));
    }

    drift.total = drift.modified.length + drift.deleted.length
      + drift.untracked.length + drift.modeOnly.length;
    return drift;
  }

  static summarizeDrift(drift) {
    if (!drift || drift.total === 0) return null;
    return {
      modified: drift.modified.length,
      deleted: drift.deleted.length,
      untracked: drift.untracked.length,
      modeOnly: drift.modeOnly.length,
      total: drift.total,
      samples: [
        ...drift.modified.slice(0, 3),
        ...drift.untracked.slice(0, 3),
        ...drift.modeOnly.slice(0, 2),
      ],
    };
  }

  async _dailySequence(today, type) {
    const prev = this.readBuildInfo();
    if (!prev) return 1;
    const prevVer = prev.currentVersion || '';
    const re = new RegExp(`^v${today.replace(/\./g, '\\.')}-${type}\\.(\\d+)$`);
    const m = prevVer.match(re);
    if (m) return parseInt(m[1], 10) + 1;
    if (prevVer.startsWith(`v${today}-`)) {
      const m2 = prevVer.match(/-(\d+)$/);
      if (m2) return parseInt(m2[1], 10) + 1;
    }
    return 1;
  }

  async _previousVersionLabel() {
    const prev = this.readBuildInfo();
    return prev?.currentVersion || null;
  }

  async _readPreviousFailure() {
    const prev = this.readBuildInfo();
    return prev?.lastFailure || null;
  }

  async _writeFailure(result) {
    const existing = this.readBuildInfo() || {};
    const failure = {
      version: result.version
        || (result.sha ? `pending-${result.sha.slice(0, 7)}` : (existing.currentVersion || null)),
      shortSha: result.sha ? result.sha.slice(0, 7) : null,
      ts: this.nowFn().toISO(),
      stage: result.stage,
      // The dashboard banner lists these, so a failed reload names its apps.
      failedChecks: result.reloadFailures
        ? result.reloadFailures.map((f) => `pm2 reload ${f.app}: ${f.error}`)
        : (result.smokeResult?.failedChecks || []),
    };
    const merged = { ...existing, lastFailure: failure };
    // Local-only (publishBuildInfo's allow-list drops it): the apps the next
    // no-update cycle retries.
    if (result.reloadFailures) merged.pendingReload = result.reloadFailures.map((f) => f.app);
    if (this.fs.existsSync(this.dataDir) === false) this.fs.mkdirSync(this.dataDir, { recursive: true });
    this.fs.writeFileSync(this._buildInfoPath, JSON.stringify(merged, null, 2));
    if (this.firestoreSync && typeof this.firestoreSync.publishBuildInfo === 'function') {
      try { await this.firestoreSync.publishBuildInfo(merged); }
      catch (e) { this.log(`[BuildManager] publishBuildInfo (failure) error: ${e.message}`); }
    }
  }

  /** Every string value reachable in a payload, keys included. */
  static stringLeaves(value, out = []) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => BuildManager.stringLeaves(v, out));
    else if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) {
        out.push(k);
        BuildManager.stringLeaves(v, out);
      }
    return out;
  }

  /**
   * Privacy gate: refuse to publish a payload that contains any process.env
   * value longer than 4 chars. Returns { ok: true } or { ok: false, reason }.
   *
   * Matches against the payload's string leaves rather than its serialised JSON.
   * Serialising folds structure into the haystack, so an env var set to the
   * string "false" collides with a JSON boolean and blocks publishing forever
   * — a live env var tripped exactly that. Only strings can carry a secret;
   * booleans, numbers and null cannot.
   */
  static assertPrivacy(payload, env = process.env) {
    const leaves = BuildManager.stringLeaves(payload || {});
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== 'string') continue;
      if (v.length <= 4) continue;
      if (leaves.some((leaf) => leaf.includes(v))) {
        return { ok: false, reason: `env value of ${k} appears in payload` };
      }
    }
    return { ok: true };
  }
}

module.exports = BuildManager;
module.exports.PRIORITY_BY_TYPE = PRIORITY_BY_TYPE;
module.exports.SAFE_PRAYER_GAP_MIN = SAFE_PRAYER_GAP_MIN;
module.exports.PM2_APPS = PM2_APPS;
module.exports.PM2_RELOAD_TIMEOUT_MS = PM2_RELOAD_TIMEOUT_MS;
module.exports.SECURITY_BOT_EMAIL = SECURITY_BOT_EMAIL;
