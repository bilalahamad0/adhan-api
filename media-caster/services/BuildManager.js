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
    return { currentSha, newSha };
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
      await this._reloadCaster();

      result.success = true;
      result.reason = 'deployed';
      result.version = versionInfo.version;
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

  async _reloadCaster() {
    await this.runExec(`pm2 reload adhan-caster adb-keeper auto-updater`, { timeoutMs: 30_000 }).catch((e) => {
      this.log(`[BuildManager] pm2 reload warning: ${e.message}`);
    });
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
      version: result.sha ? `pending-${result.sha.slice(0, 7)}` : (existing.currentVersion || null),
      shortSha: result.sha ? result.sha.slice(0, 7) : null,
      ts: this.nowFn().toISO(),
      stage: result.stage,
      failedChecks: result.smokeResult?.failedChecks || [],
    };
    const merged = { ...existing, lastFailure: failure };
    if (this.fs.existsSync(this.dataDir) === false) this.fs.mkdirSync(this.dataDir, { recursive: true });
    this.fs.writeFileSync(this._buildInfoPath, JSON.stringify(merged, null, 2));
    if (this.firestoreSync && typeof this.firestoreSync.publishBuildInfo === 'function') {
      try { await this.firestoreSync.publishBuildInfo(merged); }
      catch (e) { this.log(`[BuildManager] publishBuildInfo (failure) error: ${e.message}`); }
    }
  }

  /**
   * Privacy gate: refuse to publish a payload that contains any process.env
   * value longer than 4 chars. Returns { ok: true } or { ok: false, reason }.
   */
  static assertPrivacy(payload, env = process.env) {
    const stringified = JSON.stringify(payload || {});
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== 'string') continue;
      if (v.length <= 4) continue;
      if (stringified.includes(v)) {
        return { ok: false, reason: `env value of ${k} appears in payload` };
      }
    }
    return { ok: true };
  }
}

module.exports = BuildManager;
module.exports.PRIORITY_BY_TYPE = PRIORITY_BY_TYPE;
module.exports.SAFE_PRAYER_GAP_MIN = SAFE_PRAYER_GAP_MIN;
