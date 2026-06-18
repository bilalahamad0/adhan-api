/*
 * PushNotifier — sends the prayer-time Web Push to subscribed iPhones/devices.
 *
 * The dashboard (GitHub Pages) stores each device's PushSubscription in
 * Firestore (collection `pushSubscriptions`). At each prayer trigger the
 * CoreScheduler calls notifyPrayer(); this reads those subscriptions (via
 * firebase-admin, same credential path as FirestoreSync) and sends a standard
 * Web Push with the `web-push` library. Apple's APNs delivers it to Home-Screen
 * web apps on iOS 16.4+. No Apple Developer account, no cloud cron, no Vercel.
 *
 * Disabled gracefully (no-op) unless FIREBASE_SERVICE_KEY + VAPID keys are set,
 * and every call is wrapped so it can NEVER throw into the cast path.
 *
 * Required env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (generate once with
 * `node scripts/generate-vapid.cjs`), optional VAPID_SUBJECT (mailto:...).
 */
'use strict';

const DASHBOARD_URL = 'https://bilalahamad0.github.io/adhan-api/dashboard.html';

class PushNotifier {
  constructor(serviceKeyBase64, opts = {}) {
    this._serviceKeyBase64 = serviceKeyBase64;
    this._publicKey = opts.publicKey || process.env.VAPID_PUBLIC_KEY || '';
    this._privateKey = opts.privateKey || process.env.VAPID_PRIVATE_KEY || '';
    this._subject = opts.subject || process.env.VAPID_SUBJECT || 'mailto:bilalahamad0@gmail.com';
    this._collection = opts.collection || 'pushSubscriptions';
    this._db = null;
    this._webpush = null;
    this._enabled = Boolean(this._publicKey && this._privateKey && this._serviceKeyBase64);

    if (!this._enabled) {
      console.log('[PushNotifier] Disabled (need FIREBASE_SERVICE_KEY + VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY).');
      return;
    }
    try {
      this._webpush = require('web-push');
      this._webpush.setVapidDetails(this._subject, this._publicKey, this._privateKey);
      console.log('[PushNotifier] Enabled — Web Push ready.');
    } catch (e) {
      console.warn('[PushNotifier] web-push unavailable, disabling:', e.message);
      this._enabled = false;
    }
  }

  _initDb() {
    if (this._db) return this._db;
    try {
      const admin = require('firebase-admin');
      if (!admin.apps.length) {
        const credentials = JSON.parse(
          Buffer.from(this._serviceKeyBase64, 'base64').toString('utf8'),
        );
        admin.initializeApp({
          credential: admin.credential.cert(credentials),
          projectId: credentials.project_id,
        });
      }
      this._db = admin.firestore();
      return this._db;
    } catch (e) {
      console.error('[PushNotifier] Firestore init failed:', e.message);
      return null;
    }
  }

  /**
   * Send a prayer notification to every subscribed device. Fire-and-forget:
   * resolves silently and never rejects, so the caller's cast flow is unaffected.
   * @param {string} prayerName e.g. "Maghrib"
   * @param {{body?:string, url?:string, time?:string}} [opts] `time` is the
   *   scheduled Adhan time label (e.g. "8:31 PM") shown in the notification.
   */
  async notifyPrayer(prayerName, opts = {}) {
    if (!this._enabled) return;
    try {
      const db = this._initDb();
      if (!db) return;

      const snap = await db.collection(this._collection).get();
      if (snap.empty) {
        console.log('[PushNotifier] No push subscriptions to notify.');
        return;
      }

      const time = opts.time ? String(opts.time).trim() : '';
      const body = opts.body || (time
        ? `It’s time for ${prayerName} prayer (${time}).`
        : `It’s time for ${prayerName} prayer.`);

      const payload = JSON.stringify({
        title: time ? `${prayerName} • Adhan • ${time}` : `${prayerName} • Adhan`,
        body,
        tag: `adhan-${String(prayerName).toLowerCase()}`,
        url: opts.url || DASHBOARD_URL,
      });

      let sent = 0;
      let pruned = 0;
      await Promise.all(snap.docs.map(async (doc) => {
        const sub = doc.data();
        if (!sub || !sub.endpoint || !sub.keys) return;
        try {
          await this._webpush.sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            payload,
            { TTL: 600 },
          );
          sent += 1;
        } catch (err) {
          const code = err && err.statusCode;
          if (code === 404 || code === 410) {
            try { await doc.ref.delete(); pruned += 1; } catch (_) { /* ignore */ }
          } else {
            console.error(`[PushNotifier] send failed (${code}):`, (err && err.body) || (err && err.message));
          }
        }
      }));

      console.log(`[PushNotifier] ${prayerName}: pushed to ${sent} device(s)${pruned ? `, pruned ${pruned} expired` : ''}.`);
    } catch (e) {
      console.error('[PushNotifier] notifyPrayer error (non-fatal):', e.message);
    }
  }
}

module.exports = PushNotifier;
