const { spawn } = require('child_process');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 90 * 1000;
const SMOKE_PORT = 3099;

class SmokeRunner {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, port = SMOKE_PORT, log = console.log } = {}) {
    this.timeoutMs = timeoutMs;
    this.port = port;
    this.log = log;
  }

  async run({ stagingPath, extraEnv = {}, spawnImpl } = {}) {
    if (!stagingPath) throw new Error('SmokeRunner.run requires stagingPath');
    const childSpawn = spawnImpl || spawn;
    const bootJs = path.join('audio-caster', 'boot.js');
    const env = {
      ...process.env,
      SERVER_PORT: String(this.port),
      SMOKE_DRY_RUN: '1',
      ...extraEnv,
    };

    return new Promise((resolve) => {
      const started = Date.now();
      const child = childSpawn('node', [bootJs, '--smoke'], {
        cwd: stagingPath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      const append = (chunk) => { output += chunk.toString(); };
      if (child.stdout) child.stdout.on('data', append);
      if (child.stderr) child.stderr.on('data', append);

      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve(this._summarize(output, Date.now() - started, 'TIMEOUT'));
      }, this.timeoutMs);

      child.on('exit', (code) => {
        clearTimeout(killTimer);
        const reason = code === 0 ? 'OK' : `EXIT_${code}`;
        resolve(this._summarize(output, Date.now() - started, reason, code));
      });

      child.on('error', (err) => {
        clearTimeout(killTimer);
        output += `\n[spawn-error] ${err.message}`;
        resolve(this._summarize(output, Date.now() - started, 'SPAWN_ERROR', -1));
      });
    });
  }

  _summarize(output, durationMs, reason, exitCode = null) {
    const passedMatch = output.match(/(\d+)\s+passed/i);
    const failedMatch = output.match(/(\d+)\s+failed/i);
    const failedChecks = [];
    const failRegex = /❌\s+FAIL:\s+([^—\n]+?)(?:\s+—|\s*$)/gm;
    let m;
    while ((m = failRegex.exec(output)) !== null) {
      const name = m[1].trim();
      if (name && !failedChecks.includes(name)) failedChecks.push(name);
    }

    const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
    const failed = failedMatch ? parseInt(failedMatch[1], 10) : (reason === 'OK' ? 0 : 1);
    const ok = reason === 'OK' && failed === 0;

    return {
      passed,
      failed,
      failedChecks,
      ok,
      reason,
      exitCode,
      durationMs,
      outputTail: output.split('\n').slice(-30).join('\n'),
    };
  }
}

module.exports = SmokeRunner;
