const fs = require('fs');
const path = require('path');
const DEBOUNCE_MS = 30000; // Min 30s between Firestore writes to conserve Pi CPU
const WRITE_TIMEOUT_MS = 15000;

const PRAYER_NAMES = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

class FirestoreSync {
  /**
   * Parse Aladhan `annual_schedule` day entry timings into HH:mm (24h) strings.
   * @param {object|null} todayEntry — one day from calendarByCity annual payload
   * @returns {Record<string, string>}
   */
  static extractPrayerTimesHHmm(todayEntry) {
    const times = {};
    if (!todayEntry || !todayEntry.timings) return times;
    for (const p of PRAYER_NAMES) {
      const raw = todayEntry.timings[p];
      if (raw == null) continue;
      const token = String(raw).trim().split(/\s+/)[0];
      // Minutes may be one or two digits from some API responses (e.g. 21:5).
      const m = token.match(/^(\d{1,2}):(\d{1,2})/);
      if (!m) continue;
      const hh = String(Math.max(0, Math.min(23, parseInt(m[1], 10)))).padStart(2, '0');
      const mm = String(Math.max(0, Math.min(59, parseInt(m[2], 10)))).padStart(2, '0');
      times[p] = `${hh}:${mm}`;
    }
    return times;
  }

  constructor(serviceKeyBase64, timezone, scheduleFilePath) {
    this._serviceKeyBase64 = serviceKeyBase64;
    this._timezone = timezone;
    this._scheduleFilePath = scheduleFilePath || path.join(__dirname, '..', 'annual_schedule.json');
    this._db = null; // Lazy: firebase-admin loaded only on first write
    this._pendingTimer = null;
    this._pendingPayload = null;
    this._lastWriteMs = 0;
  }

  _resolveScheduleEntryForLuxonDate(dt) {
    try {
      if (!fs.existsSync(this._scheduleFilePath)) return null;
      const annualData = JSON.parse(fs.readFileSync(this._scheduleFilePath, 'utf8'));
      const monthData = annualData?.data?.[dt.month.toString()];
      if (!Array.isArray(monthData)) return null;
      return monthData.find((d) => parseInt(d?.date?.gregorian?.day, 10) === dt.day) || null;
    } catch {
      return null;
    }
  }

  _getScheduledTimesForISODate(isoDate) {
    const { DateTime } = require('luxon');
    const dt = DateTime.fromISO(isoDate, { zone: this._timezone });
    if (!dt.isValid) return {};
    const entry = this._resolveScheduleEntryForLuxonDate(dt);
    return FirestoreSync.extractPrayerTimesHHmm(entry);
  }

  /**
   * Writes meta/prayerSchedule and merges scheduledTimes onto dailyMetrics/{date}
   * so the dashboard shows all HH:mm even before every prayer has logged an event.
   */
  /** For health/debug: how many prayer HH:mm values resolve from disk for a given YYYY-MM-DD. */
  scheduleSummaryForDate(isoDate) {
    const times = this._getScheduledTimesForISODate(isoDate);
    return { date: isoDate, prayersScheduled: Object.keys(times).length, times };
  }

  async ensureTodayScheduleOnFirestore(isoDate) {
    const times = this._getScheduledTimesForISODate(isoDate);
    if (Object.keys(times).length === 0) {
      console.warn(`[FirestoreSync] No schedule times in file for ${isoDate}`);
      return false;
    }
    const db = this._initFirestore();
    if (!db) return false;
    try {
      await this.publishPrayerSchedule(isoDate, times);
      await db.collection('dailyMetrics').doc(isoDate).set(
        {
          date: isoDate,
          scheduledTimes: times,
          scheduleUpdatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
      return true;
    } catch (e) {
      console.error(`[FirestoreSync] ensureTodayScheduleOnFirestore failed: ${e.message}`);
      return false;
    }
  }

  _initFirestore() {
    if (this._db) return this._db;
    if (!this._serviceKeyBase64) {
      console.warn('[FirestoreSync] No FIREBASE_SERVICE_KEY set, sync disabled.');
      return null;
    }
    try {
      const admin = require('firebase-admin');
      const credentials = JSON.parse(
        Buffer.from(this._serviceKeyBase64, 'base64').toString('utf8'),
      );
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(credentials),
          projectId: credentials.project_id,
        });
      }
      this._db = admin.firestore();
      console.log('[FirestoreSync] Firestore initialized for project: ' + credentials.project_id);
      return this._db;
    } catch (e) {
      console.error('[FirestoreSync] Init failed:', e.message);
      return null;
    }
  }

  /**
   * Sync today's metrics to Firestore. Debounced to avoid hammering
   * the network on rapid successive prayer events.
   */
  syncNow(playbackLogger) {
    const payload = { logger: playbackLogger, requestedAt: Date.now() };
    const elapsed = Date.now() - this._lastWriteMs;

    if (elapsed < DEBOUNCE_MS) {
      // Debounce: schedule for later, replacing any pending timer
      this._pendingPayload = payload;
      if (!this._pendingTimer) {
        const waitMs = DEBOUNCE_MS - elapsed + 500;
        this._pendingTimer = setTimeout(() => {
          this._pendingTimer = null;
          if (this._pendingPayload) {
            this._doSync(this._pendingPayload.logger);
            this._pendingPayload = null;
          }
        }, waitMs);
      }
      return;
    }

    this._doSync(playbackLogger);
  }

  async _doSync(logger) {
    try {
      const { DateTime } = require('luxon');
      const today = DateTime.now().setZone(this._timezone).toISODate();
      await this.ensureTodayScheduleOnFirestore(today);
      await this.syncDate(logger, today, { updateLatest: true });
      this._lastWriteMs = Date.now();
    } catch (e) {
      console.error(`[FirestoreSync] Sync failed: ${e.message}`);
    }
  }

  async _writeDay(db, date, summary, events, { updateLatest = true } = {}) {
    const batch = db.batch();
    const scheduledTimes = this._getScheduledTimesForISODate(date);
    const metricsDoc = {
      ...summary,
      date,
      updatedAt: new Date().toISOString(),
      ...(Object.keys(scheduledTimes).length > 0 ? { scheduledTimes } : {}),
    };

    // merge: true so a metrics write never drops fields written earlier in the same flow
    // (e.g. scheduledTimes from ensureTodayScheduleOnFirestore) if this payload omits them.
    batch.set(db.collection('dailyMetrics').doc(date), metricsDoc, { merge: true });

    batch.set(db.collection('dailyEvents').doc(date), {
      events,
      date,
      updatedAt: new Date().toISOString(),
    });

    if (updateLatest) {
      batch.set(db.collection('meta').doc('latest'), {
        date,
        summary,
        events,
        uploadedAt: new Date().toISOString(),
      });
    }

    await batch.commit();
  }

  async syncDate(logger, date, { updateLatest = false, allowEmpty = false } = {}) {
    const db = this._initFirestore();
    if (!db) return false;

    const summary = logger.getDailyStats(date);
    const events = logger.getDateRange(date, date);
    if (!allowEmpty && events.length === 0 && (!summary || !summary.total || summary.total === 0)) {
      console.log(`[FirestoreSync] Skip ${date}: no events to sync`);
      return false;
    }

    const writePromise = this._writeDay(db, date, summary, events, { updateLatest });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Firestore write timeout')), WRITE_TIMEOUT_MS),
    );

    await Promise.race([writePromise, timeout]);
    console.log(`[FirestoreSync] Synced ${date}: ${events.length} events`);
    return true;
  }

  async backfillRecentDays(logger, days = 7) {
    const { DateTime } = require('luxon');
    const now = DateTime.now().setZone(this._timezone);
    let syncedCount = 0;
    for (let i = 0; i < days; i++) {
      const date = now.minus({ days: i }).toISODate();
      try {
        const synced = await this.syncDate(logger, date, { updateLatest: false });
        if (synced) syncedCount++;
      } catch (e) {
        console.error(`[FirestoreSync] Backfill failed for ${date}: ${e.message}`);
      }
    }
    console.log(`[FirestoreSync] Backfill complete: ${syncedCount}/${days} days synced`);
  }

  /**
   * End-of-day full sync. Bypasses debounce.
   */
  async forceSync(playbackLogger) {
    this._lastWriteMs = 0; // Reset debounce
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
      this._pendingPayload = null;
    }
    await this._doSync(playbackLogger);
  }

  /**
   * Publish canonical prayer clock times for a calendar day (Pi timezone).
   * Lets the operations dashboard show HH:mm before any playback events exist.
   */
  async publishPrayerSchedule(date, prayerTimesHHmm) {
    const db = this._initFirestore();
    if (!db || !date) return false;
    try {
      await db.collection('meta').doc('prayerSchedule').set({
        date,
        times: prayerTimesHHmm || {},
        timezone: this._timezone,
        updatedAt: new Date().toISOString(),
      });
      return true;
    } catch (e) {
      console.error(`[FirestoreSync] publishPrayerSchedule failed: ${e.message}`);
      return false;
    }
  }
}

module.exports = FirestoreSync;
