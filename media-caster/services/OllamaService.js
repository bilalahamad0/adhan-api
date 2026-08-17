const axios = require('axios');
const fs = require('fs');
const { DateTime } = require('luxon');
const { exec } = require('child_process');

// All OLLAMA_* env vars are read at construction time, NOT module load:
// boot.js requires this module before dotenv.config() runs, so module-level
// reads would never see values set in media-caster/.env.

// Critical cast window around every prayer. Gemma is forbidden from running
// inside it: inference takes ~5-10s on a Pi 4 CPU and the cast fires ~2s
// before prayer, so any LLM work here would threaten on-time Adhan playback.
const CRITICAL_PRE_MIN = 5;
const CRITICAL_POST_MIN = 8;

const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

class OllamaService {
  constructor({
    scheduleFilePath = null,
    timezone = 'America/Los_Angeles',
    // Local Ollama daemon. Bound to loopback on the Pi; never leaves the device.
    model = process.env.OLLAMA_MODEL || 'gemma3-constrained',
    baseUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    failureThreshold = 2,
    cooldownDurationMs = 60000,
    restartCmd = null,
    // Master switch. Off unless OLLAMA_ENABLED is exactly "true": a Pi without
    // an Ollama install must never see probes, queries, or watchdog restarts.
    enabled = String(process.env.OLLAMA_ENABLED || '').toLowerCase() === 'true',
  } = {}) {
    this.enabled = !!enabled;
    this.scheduleFilePath = scheduleFilePath;
    this.timezone = timezone;
    this.model = model;
    this.baseUrl = baseUrl;
    // Single-flight: a Pi 4 cannot run two inferences at once, so all callers
    // serialize through this promise chain regardless of success/failure.
    this._queue = Promise.resolve();
    this.log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

    // Circuit Breaker & Watchdog State
    this._state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this._consecutiveFailures = 0;
    this._failureThreshold = failureThreshold;
    this._cooldownDurationMs = cooldownDurationMs;
    this._cooldownUntil = 0;
    this._restartCmd = restartCmd || process.env.OLLAMA_RESTART_CMD || (process.platform === 'linux' ? 'sudo systemctl restart ollama' : null);
  }

  // Returns the model's trimmed text response, or null on any error/timeout so
  // every caller can degrade gracefully. Calls are serialized (single-flight).
  async ask(systemPrompt, userContext, { timeoutMs = 90000, json = false } = {}) {
    if (!this.enabled) return null;
    const run = async () => {
      // 1. Circuit Breaker Check
      if (this._state === 'OPEN') {
        if (Date.now() < this._cooldownUntil) {
          this.log(`⚠️ Circuit open: failing-fast on Ollama query.`);
          return null;
        }
        // Cooldown period expired, try probe in HALF_OPEN state
        this._state = 'HALF_OPEN';
        this.log(`🔄 Circuit cooldown expired. Attempting probe in HALF_OPEN state.`);
      }

      try {
        const body = {
          model: this.model,
          prompt: `${systemPrompt}\n\n${userContext}`,
          stream: false,
          keep_alive: -1,
          options: { num_ctx: 2048, num_predict: 150 },
        };
        if (json) body.format = 'json';
        const resp = await axios.post(`${this.baseUrl}/api/generate`, body, {
          timeout: timeoutMs,
          headers: { 'Content-Type': 'application/json' },
        });
        const text = resp && resp.data && resp.data.response;
        
        this._handleSuccess();
        return typeof text === 'string' ? text.trim() : null;
      } catch (e) {
        this.log(`❌ Ollama request failed: ${e.message}`);
        this._handleFailure(e);
        return null;
      }
    };
    const result = this._queue.then(run, run);
    // Keep the chain alive but swallow settlement so one failure can't poison it.
    this._queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async askJson(systemPrompt, userContext, opts = {}) {
    const text = await this.ask(systemPrompt, userContext, { ...opts, json: true });
    return OllamaService.parseJson(text);
  }

  // Strips ```json ... ``` fences (and stray prose) then JSON.parses. Returns
  // null if the text can't be parsed, so callers never throw on bad output.
  static parseJson(text) {
    if (!text || typeof text !== 'string') return null;
    let s = text.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    if (s[0] !== '{' && s[0] !== '[') {
      const block = s.match(/[{[][\s\S]*[}\]]/);
      if (block) s = block[0];
    }
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  async isAvailable(timeoutMs = 2000) {
    if (!this.enabled) return false;
    // Circuit Breaker Check
    if (this._state === 'OPEN') {
      if (Date.now() < this._cooldownUntil) {
        return false;
      }
      this._state = 'HALF_OPEN';
    }

    try {
      const resp = await axios.get(`${this.baseUrl}/api/tags`, { timeout: timeoutMs });
      if (resp.status === 200) {
        if (this._state !== 'CLOSED') {
          this._handleSuccess();
        }
        return true;
      }
      throw new Error(`Non-200 status code: ${resp.status}`);
    } catch (e) {
      this._handleFailure(e);
      return false;
    }
  }

  // Pre-load the model into Ollama's memory so the first real query gets the
  // fast (~4s) warm path instead of the slow (~28s) cold-load path. Fire-and-
  // forget; failure is harmless — the first query will just cold-start instead.
  async warmup() {
    if (!this.enabled) return;
    try {
      if (!(await this.isAvailable(3000))) return;
      this.log('🔥 Warming up Ollama model...');
      await axios.post(`${this.baseUrl}/api/generate`, {
        model: this.model,
        prompt: 'hi',
        stream: false,
        keep_alive: -1,
        options: { num_ctx: 32, num_predict: 1 },
      }, { timeout: 60000 });
      this.log('✅ Ollama model warm and loaded in memory.');
    } catch (e) {
      this.log(`⚠️ Ollama warmup failed (non-fatal): ${e.message}`);
    }
  }

  _handleSuccess() {
    if (this._state !== 'CLOSED') {
      this.log(`✅ Ollama connection recovered. Resetting circuit breaker.`);
    }
    this._consecutiveFailures = 0;
    this._state = 'CLOSED';
  }

  _handleFailure(error) {
    this._consecutiveFailures++;
    this.log(`⚠️ Ollama consecutive failure logged (${this._consecutiveFailures}/${this._failureThreshold}): ${error.message}`);
    if (this._consecutiveFailures >= this._failureThreshold && this._state !== 'OPEN') {
      this._tripCircuit(error);
    }
  }

  _tripCircuit(error) {
    this._state = 'OPEN';
    this._cooldownUntil = Date.now() + this._cooldownDurationMs;
    this.log(`🚨 Circuit breaker TRIPPED. Cooldown active for ${this._cooldownDurationMs / 1000}s. Last error: ${error.message}`);
    this._triggerRestart();
  }

  _triggerRestart() {
    if (!this._restartCmd) {
      this.log(`⚠️ No Ollama restart command configured. Skipping restart.`);
      return;
    }
    this.log(`🔄 Watchdog: Triggering Ollama restart command: ${this._restartCmd}`);
    // Run the restart command asynchronously so we don't block any runtime code path
    exec(this._restartCmd, (err, stdout, stderr) => {
      if (err) {
        this.log(`❌ Watchdog: Ollama restart command failed: ${err.message}`);
        if (stderr) this.log(`Stderr: ${stderr.trim()}`);
      } else {
        this.log(`✅ Watchdog: Ollama restart command executed successfully.`);
        if (stdout) this.log(`Stdout: ${stdout.trim()}`);
      }
    });
  }

  // True when NOW falls inside the critical window of any prayer today. If the
  // schedule can't be read we fail safe (return true) so background jobs hold off.
  isNearPrayer(now = null) {
    if (!this.scheduleFilePath) return false;
    try {
      const n = now || DateTime.now().setZone(this.timezone);
      const annual = JSON.parse(fs.readFileSync(this.scheduleFilePath, 'utf8'));
      const monthData = annual && annual.data && annual.data[n.month.toString()];
      const entry = Array.isArray(monthData)
        ? monthData.find((d) => parseInt(d && d.date && d.date.gregorian && d.date.gregorian.day, 10) === n.day)
        : null;
      if (!entry || !entry.timings) return false;
      for (const p of PRAYERS) {
        const t = String(entry.timings[p] || '').split(' ')[0];
        const [h, m] = t.split(':').map((x) => parseInt(x, 10));
        if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
        const pt = n.set({ hour: h, minute: m, second: 0, millisecond: 0 });
        const diffMin = n.diff(pt, 'minutes').minutes; // negative = before prayer
        if (diffMin >= -CRITICAL_PRE_MIN && diffMin <= CRITICAL_POST_MIN) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  // Quiet-window guard for all off-critical-path background jobs.
  isQuiet(now = null) {
    return !this.isNearPrayer(now);
  }
}

module.exports = OllamaService;
module.exports.PRAYERS = PRAYERS;
