const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const aiContext = require('./aiContext');

const MAX_OBSERVATIONS = 100;
const MAX_SUGGESTIONS = 30;

// Short glossary so Gemma can reason about the project's failure codes without
// us having to spell them out at every call site.
const FAILURE_GLOSSARY =
  'DISCOVERY_TIMEOUT=Nest Hub not found via mDNS in time (asleep / IP changed / Wi-Fi drop); ' +
  'ENCODING_TIMEOUT=ffmpeg encode too slow; ' +
  'SHORT_VIDEO/SHORT_PLAYBACK=clip ended early; ' +
  'CAST_ERROR=receiver rejected the stream; ' +
  'GENERATION_FAILED=image/video build error.';

// Off-critical-path intelligence layer. Owns the persistent memory buffer and
// runs only in quiet windows (guarded by OllamaService.isQuiet). It never gates,
// delays, or alters the live cast/recovery path — it explains and advises only.
class AdvisoryAgent {
  constructor({ ollama, playbackLogger, dataDir, timezone = 'America/Los_Angeles', scheduleFilePath }) {
    this.ollama = ollama;
    this.playbackLogger = playbackLogger;
    this.dataDir = dataDir;
    this.timezone = timezone;
    this.scheduleFilePath = scheduleFilePath;
    this.memoryPath = path.join(dataDir, 'ai-memory.json');
    this.blurbPath = path.join(dataDir, 'ai-blurb.json');
    this._failureQueue = [];
    this.log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch {
      /* dir already exists */
    }
  }

  _readMemory() {
    try {
      return JSON.parse(fs.readFileSync(this.memoryPath, 'utf8'));
    } catch {
      return { version: 1, observations: [], suggestions: [] };
    }
  }

  _writeMemory(mem) {
    if (mem.observations.length > MAX_OBSERVATIONS) mem.observations = mem.observations.slice(-MAX_OBSERVATIONS);
    if (mem.suggestions.length > MAX_SUGGESTIONS) mem.suggestions = mem.suggestions.slice(-MAX_SUGGESTIONS);
    try {
      fs.writeFileSync(this.memoryPath, JSON.stringify(mem, null, 2));
    } catch (e) {
      this.log(`⚠️ Failed to persist ai-memory: ${e.message}`);
    }
  }

  // --- Failure diagnosis (queued at failure time, drained in quiet windows) ---

  enqueueFailure(date, prayer, failureReason) {
    this._failureQueue.push({ date, prayer, failureReason, queuedAt: Date.now() });
  }

  async drainFailures() {
    if (!this._failureQueue.length) return;
    if (!this.ollama.isQuiet()) {
      this.log('🤖 Holding failure diagnosis — inside prayer critical window.');
      return;
    }
    if (!(await this.ollama.isAvailable())) return;

    const batch = this._failureQueue.splice(0, this._failureQueue.length);
    for (const f of batch) {
      const ev =
        this.playbackLogger
          .getAllEvents()
          .filter((e) => e.date === f.date && String(e.prayer).toLowerCase() === String(f.prayer).toLowerCase())
          .slice(-1)[0] || { date: f.date, prayer: f.prayer, status: 'FAILED', failureReason: f.failureReason };

      const sys =
        'You are a home-automation reliability assistant for an Islamic prayer (Adhan) caster on a Raspberry Pi 4 ' +
        'that casts audio + a dashboard to a Google Nest Hub and pauses an Android TV. Given ONE failed cast event, ' +
        'state the single most likely root cause in ONE short plain-English sentence (max 22 words). No JSON, no preamble.';
      const ctx =
        `Failed event:\n${JSON.stringify(
          {
            date: ev.date,
            prayer: ev.prayer,
            status: ev.status,
            failureReason: ev.failureReason || f.failureReason,
            discoveryDurationMs: ev.discoveryDurationMs,
            castConnectDurationMs: ev.castConnectDurationMs,
            triggerLatencyMs: ev.triggerLatencyMs,
            recoveryAttempts: ev.recoveryAttempts,
            cacheHit: ev.cacheHit,
            cacheStale: ev.cacheStale,
            usedFallback: ev.usedFallback,
            deviceName: ev.deviceName,
          },
          null,
          2,
        )}\n\nFailure-code meanings: ${FAILURE_GLOSSARY}`;

      const diagnosis = await this.ollama.ask(sys, ctx);
      if (diagnosis) {
        this.playbackLogger.upsertHistoricalEvent({ date: ev.date, prayer: ev.prayer, aiDiagnosis: diagnosis });
        const mem = this._readMemory();
        mem.observations.push({
          at: DateTime.now().setZone(this.timezone).toISO(),
          kind: 'failure',
          date: ev.date,
          prayer: ev.prayer,
          failureReason: ev.failureReason || f.failureReason,
          diagnosis,
        });
        this._writeMemory(mem);
        this.log(`🤖 Diagnosed ${ev.date} ${ev.prayer}: ${diagnosis}`);
      } else {
        // Couldn't diagnose now (busy/down) — requeue for the next drain.
        this._failureQueue.push(f);
      }
    }
  }

  // --- Daily dashboard blurb (cached per day) ---

  async generateDailyBlurb() {
    if (!this.ollama.isQuiet()) return;
    const today = DateTime.now().setZone(this.timezone).toISODate();
    if (this.getBlurb()) return; // already have today's
    if (!(await this.ollama.isAvailable())) return;

    const ctx = aiContext.buildStatusContext(this.scheduleFilePath, this.timezone, this.playbackLogger);
    const sys =
      'You are the dashboard greeter for an Islamic prayer (Adhan) caster. Write ONE warm, concise line ' +
      '(max 24 words) for today\'s dashboard: name the next prayer and add a brief respectful note. ' +
      'Plain text only — no emojis, no quotation marks.';
    const text = await this.ollama.ask(sys, ctx);
    if (text) {
      try {
        fs.writeFileSync(
          this.blurbPath,
          JSON.stringify({ date: today, text, generatedAt: DateTime.now().setZone(this.timezone).toISO() }, null, 2),
        );
        this.log('🤖 Daily blurb generated.');
      } catch (e) {
        this.log(`⚠️ Failed to persist ai-blurb: ${e.message}`);
      }
    }
  }

  getBlurb() {
    try {
      const cur = JSON.parse(fs.readFileSync(this.blurbPath, 'utf8'));
      const today = DateTime.now().setZone(this.timezone).toISODate();
      if (cur && cur.date === today && cur.text) return cur.text;
    } catch {
      /* no blurb yet */
    }
    return null;
  }

  // --- Tuning advisory (advisory-only; never auto-applied) ---

  async runTuningAdvisory() {
    if (!this.ollama.isQuiet()) return;
    if (!(await this.ollama.isAvailable())) return;

    const summary = this.playbackLogger.getMultiDaySummary(14);
    const recommendedLead = this.playbackLogger.getRecommendedCastLeadMs(2000);
    const mem = this._readMemory();

    const sys =
      'You are a reliability tuning advisor for an Adhan caster on a Raspberry Pi 4. You ONLY suggest; you never ' +
      'change anything and a human applies changes manually. Given 14-day stats and prior notes, output STRICT JSON: ' +
      '{"anomalies":["..."],"suggestions":[{"setting":"ENV_VAR","suggested":"...","reason":"..."}],"summary":"one sentence"}. ' +
      'Tunable env vars only: PRAYER_CAST_LEAD_MS, CAST_CACHE_TTL_HOURS, CAST_CACHE_STALE_STREAK, PRAYER_RETRY_WINDOW_MIN. ' +
      'Be conservative: if the system looks healthy, return empty arrays.';
    const ctx =
      `14-day stats:\n${JSON.stringify(
        {
          successRate: summary.successRate,
          recoveryRate: summary.recoveryRate,
          failed: summary.failed,
          recovered: summary.recovered,
          fallbackCount: summary.fallbackCount,
          avgLatencyMs: summary.avgLatencyMs,
          p95LatencyMs: summary.p95LatencyMs,
          avgDiscoveryMs: summary.avgDiscoveryMs,
          failureBreakdown: summary.failureBreakdown,
          streak: summary.streak,
        },
        null,
        2,
      )}\n\nLive adaptive cast-lead (rolling p75, ms): ${recommendedLead}\n` +
      `Recent prior suggestions: ${JSON.stringify((mem.suggestions || []).slice(-3))}`;

    const result = await this.ollama.askJson(sys, ctx, { timeoutMs: 30000 });
    if (result) {
      mem.suggestions.push({ at: DateTime.now().setZone(this.timezone).toISO(), ...result });
      this._writeMemory(mem);
      this.log(`🤖 Tuning advisory updated (${((result.suggestions) || []).length} suggestion(s)).`);
    }
  }

  getLatestAdvisory() {
    const mem = this._readMemory();
    return (mem.suggestions || []).slice(-1)[0] || null;
  }
}

module.exports = AdvisoryAgent;
