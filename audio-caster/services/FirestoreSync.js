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
    const db = this._initFirestore();
    if (!db) return;

    try {
      const { DateTime } = require('luxon');
      const today = DateTime.now().setZone(this._timezone).toISODate();
      const summary = logger.getDailySummary();
      const events = logger.getTodayEvents();

      // Timeout guard: don't block Pi if network is slow
      const writePromise = this._batchWrite(db, today, summary, events);
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firestore write timeout')), WRITE_TIMEOUT_MS),
      );

      await Promise.race([writePromise, timeout]);
      this._lastWriteMs = Date.now();
      console.log(`[FirestoreSync] Synced ${today}: ${events.length} events`);
    } catch (e) {
      console.error(`[FirestoreSync] Sync failed: ${e.message}`);
    }
  }

  async _batchWrite(db, date, summary, events) {
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

    batch.set(db.collection('meta').doc('latest'), {
      date,
      summary,
      events,
      uploadedAt: new Date().toISOString(),
    });

    await batch.commit();
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
