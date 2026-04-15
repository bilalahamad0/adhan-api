const DEBOUNCE_MS = 30000; // Min 30s between Firestore writes to conserve Pi CPU
const WRITE_TIMEOUT_MS = 15000;

class FirestoreSync {
  constructor(serviceKeyBase64, timezone) {
    this._serviceKeyBase64 = serviceKeyBase64;
    this._timezone = timezone;
    this._db = null; // Lazy: firebase-admin loaded only on first write
    this._pendingTimer = null;
    this._pendingPayload = null;
    this._lastWriteMs = 0;
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
      await this.syncDate(logger, today, { updateLatest: true });
      this._lastWriteMs = Date.now();
    } catch (e) {
      console.error(`[FirestoreSync] Sync failed: ${e.message}`);
    }
  }

  async _writeDay(db, date, summary, events, { updateLatest = true } = {}) {
    const batch = db.batch();

    batch.set(db.collection('dailyMetrics').doc(date), {
      ...summary,
      date,
      updatedAt: new Date().toISOString(),
    });

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
}

module.exports = FirestoreSync;
