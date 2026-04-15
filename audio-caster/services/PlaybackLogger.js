const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB rotation threshold

class PlaybackLogger {
  constructor(dataDir, timezone = 'America/Los_Angeles') {
    this.dataDir = dataDir;
    this.timezone = timezone;
    this.logFilePath = path.join(dataDir, 'playback_log.json');
    this.pendingEvents = new Map(); // key: "YYYY-MM-DD:Prayer" -> partial event

    fs.mkdirSync(dataDir, { recursive: true });
    this._ensureFile();
  }

  _ensureFile() {
    if (!fs.existsSync(this.logFilePath)) {
      fs.writeFileSync(this.logFilePath, JSON.stringify({ version: 1, events: [] }, null, 2));
    }
  }

  _readLog() {
    try {
      return JSON.parse(fs.readFileSync(this.logFilePath, 'utf8'));
    } catch {
      const fresh = { version: 1, events: [] };
      fs.writeFileSync(this.logFilePath, JSON.stringify(fresh, null, 2));
      return fresh;
    }
  }

  _writeLog(data) {
    this._rotateIfNeeded();
    fs.writeFileSync(this.logFilePath, JSON.stringify(data, null, 2));
  }

  _rotateIfNeeded() {
    try {
      if (!fs.existsSync(this.logFilePath)) return;
      const stat = fs.statSync(this.logFilePath);
      if (stat.size < MAX_FILE_SIZE) return;

      const now = DateTime.now().setZone(this.timezone);
      const archiveName = `playback_log_${now.toFormat('yyyy-MM')}.json`;
      const archivePath = path.join(this.dataDir, archiveName);

      if (fs.existsSync(archivePath)) {
        const existing = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
        const current = this._readLog();
        existing.events = existing.events.concat(current.events);
        fs.writeFileSync(archivePath, JSON.stringify(existing, null, 2));
      } else {
        fs.copyFileSync(this.logFilePath, archivePath);
      }

      fs.writeFileSync(this.logFilePath, JSON.stringify({ version: 1, events: [] }, null, 2));
    } catch (e) {
      console.error(`[PlaybackLogger] Rotation error: ${e.message}`);
    }
  }

  _eventKey(date, prayer) {
    return `${date}:${prayer}`;
  }

  _now() {
    return DateTime.now().setZone(this.timezone);
  }

  // --- Event Lifecycle ---

  startEvent(prayer, scheduledTime) {
    const now = this._now();
    const date = now.toISODate();
    const key = this._eventKey(date, prayer);

    this.pendingEvents.set(key, {
      date,
      prayer,
      scheduledTime: scheduledTime || null,
      triggerTime: now.toISO(),
      playbackStartTime: null,
      completedTime: null,
      status: 'PENDING',
      triggerLatencyMs: null,
      encodingDurationMs: null,
      discoveryDurationMs: null,
      recoveryAttempts: 0,
      auditResult: null,
      failureReason: null,
      usedFallback: false,
      deviceName: null,
      _encodingStart: now.toMillis(),
      _discoveryStart: null,
    });

    return key;
  }

  recordEncodingComplete(prayer) {
    const key = this._eventKey(this._now().toISODate(), prayer);
    const ev = this.pendingEvents.get(key);
    if (!ev) return;
    ev.encodingDurationMs = this._now().toMillis() - ev._encodingStart;
  }

  recordEncodingFailed(prayer, reason) {
    const key = this._eventKey(this._now().toISODate(), prayer);
    const ev = this.pendingEvents.get(key);
    if (!ev) return;
    ev.encodingDurationMs = this._now().toMillis() - ev._encodingStart;
    ev.failureReason = reason;
  }

  recordDiscoveryStart(prayer) {
    const key = this._eventKey(this._now().toISODate(), prayer);
    const ev = this.pendingEvents.get(key);
    if (!ev) return;
    ev._discoveryStart = this._now().toMillis();
  }

  recordDeviceDiscovered(prayer, deviceName) {
    const key = this._eventKey(this._now().toISODate(), prayer);
    const ev = this.pendingEvents.get(key);
    if (!ev) return;
    ev.deviceName = deviceName;
    if (ev._discoveryStart) {
      ev.discoveryDurationMs = this._now().toMillis() - ev._discoveryStart;
    }
  }

  recordPlaybackStarted(prayer, scheduledTimeObj) {
    const key = this._eventKey(this._now().toISODate(), prayer);
    const ev = this.pendingEvents.get(key);
    if (!ev) return;
    const now = this._now();
    ev.playbackStartTime = now.toISO();
    if (scheduledTimeObj) {
      ev.triggerLatencyMs = now.toMillis() - scheduledTimeObj.toMillis();
    }
  }

  recordUsedFallback(prayer) {
    const key = this._eventKey(this._now().toISODate(), prayer);
    const ev = this.pendingEvents.get(key);
    if (!ev) return;
    ev.usedFallback = true;
  }

  recordCompleted(prayer) {
    const key = this._eventKey(this._now().toISODate(), prayer);
    const ev = this.pendingEvents.get(key);
    if (!ev) return;
    ev.completedTime = this._now().toISO();
    ev.status = ev.recoveryAttempts > 0 ? 'RECOVERED' : 'PLAYED';
    this._finalizeEvent(key);
  }

  recordFailed(prayer, reason) {
    const key = this._eventKey(this._now().toISODate(), prayer);
    const ev = this.pendingEvents.get(key);
    if (!ev) return;
    ev.status = 'FAILED';
    ev.failureReason = reason || ev.failureReason;
    this._finalizeEvent(key);
  }

  recordAuditResult(prayer, passed) {
    const key = this._eventKey(this._now().toISODate(), prayer);
    const ev = this.pendingEvents.get(key);
    if (ev) {
      ev.auditResult = passed ? 'PASS' : 'FAIL';
      if (!passed) ev.recoveryAttempts = (ev.recoveryAttempts || 0) + 1;
    } else {
      // Audit for an event already finalized -- update the last matching event in the log
      const log = this._readLog();
      const today = this._now().toISODate();
      for (let i = log.events.length - 1; i >= 0; i--) {
        if (log.events[i].date === today && log.events[i].prayer === prayer) {
          log.events[i].auditResult = passed ? 'PASS' : 'FAIL';
          if (!passed) log.events[i].recoveryAttempts = (log.events[i].recoveryAttempts || 0) + 1;
          this._writeLog(log);
          break;
        }
      }
    }
  }

  _finalizeEvent(key) {
    const ev = this.pendingEvents.get(key);
    if (!ev) return;

    // Strip internal timing fields
    const record = { ...ev };
    delete record._encodingStart;
    delete record._discoveryStart;

    const log = this._readLog();
    log.events.push(record);
    this._writeLog(log);
    this.pendingEvents.delete(key);
  }

  // --- Query Methods ---

  logEvent(eventData) {
    const log = this._readLog();
    log.events.push(eventData);
    this._writeLog(log);
  }

  getAllEvents() {
    const log = this._readLog();
    // Also include events from archives
    const allEvents = [...log.events];
    try {
      const files = fs.readdirSync(this.dataDir)
        .filter(f => f.startsWith('playback_log_') && f.endsWith('.json'))
        .sort();
      for (const file of files) {
        const archive = JSON.parse(fs.readFileSync(path.join(this.dataDir, file), 'utf8'));
        allEvents.unshift(...archive.events);
      }
    } catch { /* ignore archive read errors */ }
    return allEvents;
  }

  getTodayEvents() {
    const today = this._now().toISODate();
    const log = this._readLog();
    return log.events.filter(e => e.date === today);
  }

  getDateRange(startDate, endDate) {
    const all = this.getAllEvents();
    return all.filter(e => e.date >= startDate && e.date <= endDate);
  }

  upsertHistoricalEvent(eventData) {
    if (!eventData || !eventData.date || !eventData.prayer) {
      throw new Error('date and prayer are required');
    }
    const log = this._readLog();
    const idx = log.events.findIndex(
      e => e.date === eventData.date && String(e.prayer).toLowerCase() === String(eventData.prayer).toLowerCase(),
    );
    if (idx >= 0) {
      log.events[idx] = { ...log.events[idx], ...eventData };
    } else {
      log.events.push(eventData);
    }
    this._writeLog(log);
  }

  getDailyStats(date) {
    const events = this.getAllEvents().filter(e => e.date === date);
    return this._computeStats(events, date);
  }

  _computeStats(events, label) {
    const total = events.length;
    const played = events.filter(e => e.status === 'PLAYED').length;
    const recovered = events.filter(e => e.status === 'RECOVERED').length;
    const failed = events.filter(e => e.status === 'FAILED').length;
    const pending = events.filter(e => e.status === 'PENDING').length;

    const successCount = played + recovered;
    const successRate = total > 0 ? Math.round((successCount / total) * 10000) / 100 : null;
    const recoveryRate = (recovered + failed) > 0
      ? Math.round((recovered / (recovered + failed)) * 10000) / 100
      : null;

    const latencies = events
      .filter(e => e.triggerLatencyMs != null)
      .map(e => e.triggerLatencyMs)
      .sort((a, b) => a - b);
    const avgLatency = latencies.length > 0
      ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
      : null;
    const p95Latency = latencies.length > 0
      ? latencies[Math.floor(latencies.length * 0.95)]
      : null;

    const encodingDurations = events
      .filter(e => e.encodingDurationMs != null)
      .map(e => e.encodingDurationMs);
    const avgEncoding = encodingDurations.length > 0
      ? Math.round(encodingDurations.reduce((s, v) => s + v, 0) / encodingDurations.length)
      : null;

    const discoveryDurations = events
      .filter(e => e.discoveryDurationMs != null)
      .map(e => e.discoveryDurationMs);
    const avgDiscovery = discoveryDurations.length > 0
      ? Math.round(discoveryDurations.reduce((s, v) => s + v, 0) / discoveryDurations.length)
      : null;

    const fallbackCount = events.filter(e => e.usedFallback).length;

    const failureBreakdown = {};
    events.filter(e => e.failureReason).forEach(e => {
      failureBreakdown[e.failureReason] = (failureBreakdown[e.failureReason] || 0) + 1;
    });

    const prayers = {};
    for (const e of events) {
      prayers[e.prayer] = {
        status: e.status,
        scheduledTime: e.scheduledTime,
        playbackStartTime: e.playbackStartTime,
        triggerLatencyMs: e.triggerLatencyMs,
        auditResult: e.auditResult,
        usedFallback: e.usedFallback,
      };
    }

    return {
      label,
      total,
      played,
      recovered,
      failed,
      pending,
      successRate,
      recoveryRate,
      avgLatencyMs: avgLatency,
      p95LatencyMs: p95Latency,
      avgEncodingMs: avgEncoding,
      avgDiscoveryMs: avgDiscovery,
      fallbackCount,
      failureBreakdown,
      prayers,
    };
  }

  getDailySummary() {
    const today = this._now().toISODate();
    const stats = this.getDailyStats(today);
    stats.uploadedAt = this._now().toISO();
    return stats;
  }

  getMultiDaySummary(days) {
    const now = this._now();
    const endDate = now.toISODate();
    const startDate = now.minus({ days: days - 1 }).toISODate();
    const events = this.getDateRange(startDate, endDate);

    const byDate = {};
    for (const e of events) {
      if (!byDate[e.date]) byDate[e.date] = [];
      byDate[e.date].push(e);
    }

    const dailyStats = [];
    for (let i = 0; i < days; i++) {
      const date = now.minus({ days: i }).toISODate();
      const dayEvents = byDate[date] || [];
      dailyStats.unshift(this._computeStats(dayEvents, date));
    }

    // Compute streak: consecutive days with 100% success
    let streak = 0;
    for (let i = dailyStats.length - 1; i >= 0; i--) {
      if (dailyStats[i].total > 0 && dailyStats[i].successRate === 100) streak++;
      else if (dailyStats[i].total > 0) break;
    }

    const allInRange = this._computeStats(events, `${startDate} to ${endDate}`);
    allInRange.dailyStats = dailyStats;
    allInRange.streak = streak;
    allInRange.startDate = startDate;
    allInRange.endDate = endDate;

    return allInRange;
  }
}

module.exports = PlaybackLogger;
