/*
 * Adhan Operations Dashboard — prayer-time push opt-in (client side).
 *
 * Flow: the user taps "Enable prayer alerts" → we register sw.js, request
 * Notification permission (must be from a real tap on iOS), subscribe with the
 * VAPID public key, and store the PushSubscription in Firestore
 * (collection `pushSubscriptions`, one doc per device). The Raspberry Pi reads
 * that collection and pushes at each prayer time.
 *
 * iOS requires the page to be ADDED TO THE HOME SCREEN and opened from there —
 * push does nothing in a normal Safari tab. We detect that and show guidance.
 *
 * The VAPID public key is read from <meta name="vapid-public-key" content="...">.
 */
(function () {
  'use strict';

  var SUB_COLLECTION = 'pushSubscriptions';
  var SW_URL = 'sw.js';   // resolves to /adhan-api/sw.js
  var SW_SCOPE = './';     // scope = /adhan-api/

  var supported =
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  var isStandalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;

  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  function vapidPublicKey() {
    var m = document.querySelector('meta[name="vapid-public-key"]');
    return ((m && m.content) || '').trim();
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function sha256Hex(str) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.prototype.map
      .call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); })
      .join('')
      .slice(0, 32);
  }

  // Reuse the dashboard's already-initialised default Firebase app.
  function getDb() {
    if (window.firebase && firebase.apps && firebase.apps.length && firebase.firestore) {
      try { return firebase.firestore(); } catch (_) { return null; }
    }
    return null;
  }

  async function saveSubscription(sub) {
    var db = getDb();
    if (!db) throw new Error('Firestore not ready');
    var json = sub.toJSON();
    var id = await sha256Hex(json.endpoint);
    await db.collection(SUB_COLLECTION).doc(id).set({
      endpoint: json.endpoint,
      keys: json.keys,
      ua: navigator.userAgent,
      updatedAt: new Date().toISOString(),
    });
    return id;
  }

  // --- Minimal floating UI -------------------------------------------------
  var btn, statusEl;

  function injectUI() {
    var wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;flex-direction:column;' +
      'align-items:flex-end;gap:6px;font-family:Inter,system-ui,sans-serif;';

    btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '🔔 Enable prayer alerts';
    btn.style.cssText =
      'border:0;border-radius:999px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;' +
      'color:#fff;background:linear-gradient(180deg,#1f8a5b,#0b6b43);box-shadow:0 6px 18px rgba(0,0,0,.35);';

    statusEl = document.createElement('div');
    statusEl.style.cssText =
      'font-size:11px;color:#cbd5e1;background:rgba(15,23,42,.85);padding:4px 8px;border-radius:8px;' +
      'max-width:240px;text-align:right;display:none;';

    wrap.appendChild(statusEl);
    wrap.appendChild(btn);
    document.body.appendChild(wrap);

    btn.addEventListener('click', onEnableClick);
  }

  function setStatus(text, show) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.style.display = show && text ? 'block' : 'none';
  }

  function markOn() {
    if (btn) {
      btn.textContent = '🔔 Prayer alerts on';
      btn.style.background = 'rgba(74,222,128,.18)';
      btn.style.color = '#4ade80';
      btn.style.cursor = 'default';
    }
    setStatus('You’ll be notified at each prayer time.', true);
  }

  async function onEnableClick() {
    try {
      if (!vapidPublicKey()) {
        setStatus('Not configured yet: missing VAPID public key.', true);
        return;
      }
      // On iOS, push only works inside the installed Home-Screen app.
      if (isIOS && !isStandalone) {
        setStatus('On iPhone: tap Share → "Add to Home Screen", open it from the icon, then enable.', true);
        return;
      }
      setStatus('Requesting permission…', true);
      var perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setStatus('Notifications blocked. Enable them in Settings, then retry.', true);
        return;
      }
      var reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
      await navigator.serviceWorker.ready;

      var sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey()),
        });
      }
      await saveSubscription(sub);
      markOn();
    } catch (err) {
      console.error('[notifications] enable failed:', err);
      setStatus('Could not enable alerts: ' + (err && err.message || err), true);
    }
  }

  // If already granted + subscribed, refresh the stored subscription on open
  // (iOS rotates subscriptions; re-saving keeps Firestore current).
  async function refreshIfAlreadyOn() {
    try {
      if (Notification.permission !== 'granted') return;
      var reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
      if (!reg) return;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      await saveSubscription(sub);
      markOn();
    } catch (_) { /* non-fatal */ }
  }

  function init() {
    if (!supported) return; // Old iOS / unsupported browser — show nothing.
    injectUI();
    refreshIfAlreadyOn();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
