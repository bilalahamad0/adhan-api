/*
 * Adhan Operations Dashboard — prayer-time push opt-in (client side).
 *
 * A bell toggle embedded in the header turns prayer alerts on/off:
 *  - ON : register sw.js, request permission (real tap), subscribe with the
 *         VAPID public key, store the PushSubscription in Firestore
 *         (collection `pushSubscriptions`, one doc per device).
 *  - OFF: unsubscribe the device and delete its Firestore doc.
 * The Raspberry Pi reads that collection and pushes at each prayer time.
 *
 * Multi-device: every device gets its own doc (id = sha256 of its push
 * endpoint), so any number of iPhones can enroll, and toggling off on one
 * device only removes that device.
 *
 * iOS requires the page ADDED TO THE HOME SCREEN and opened from there.
 * VAPID public key comes from <meta name="vapid-public-key" content="...">.
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

  var btn, toastEl, toastTimer, state = 'off'; // 'off' | 'on' | 'busy'

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

  async function getRegAndSub() {
    var reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    if (!reg) return { reg: null, sub: null };
    var sub = await reg.pushManager.getSubscription();
    return { reg: reg, sub: sub };
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
  }

  // Best-effort: remove this device's doc. If rules forbid delete, the Pi
  // prunes the now-dead subscription on its next send (404/410) anyway.
  async function deleteSubscription(sub) {
    try {
      var db = getDb();
      if (!db) return;
      var id = await sha256Hex(sub.endpoint);
      await db.collection(SUB_COLLECTION).doc(id).delete();
    } catch (_) { /* non-fatal */ }
  }

  // ---- UI ----------------------------------------------------------------
  function bellSVG(filled) {
    var fill = filled ? 'currentColor' : 'none';
    return (
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="' + fill + '" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>' +
      '<path d="M13.73 21a2 2 0 0 1-3.46 0" fill="none"/></svg>'
    );
  }

  function render() {
    if (!btn) return;
    var label, color, border, bg, title;
    if (state === 'on') {
      label = 'Alerts on'; color = '#4ade80'; border = 'rgba(74,222,128,.45)';
      bg = 'rgba(74,222,128,.12)'; title = 'Prayer alerts on — tap to turn off';
    } else if (state === 'busy') {
      label = '…'; color = '#cbd5e1'; border = 'rgba(148,163,184,.25)';
      bg = 'rgba(148,163,184,.08)'; title = 'Working…';
    } else {
      label = 'Alerts off'; color = '#cbd5e1'; border = 'rgba(148,163,184,.25)';
      bg = 'rgba(148,163,184,.08)'; title = 'Tap to enable prayer alerts';
    }
    btn.innerHTML = bellSVG(state === 'on') + '<span>' + label + '</span>';
    btn.style.color = color;
    btn.style.borderColor = border;
    btn.style.background = bg;
    btn.title = title;
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = '0'; }, 3500);
  }

  function injectUI() {
    toastEl = document.createElement('div');
    toastEl.style.cssText =
      'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9999;' +
      'background:rgba(15,23,42,.94);color:#e2e8f0;font:500 12px Inter,system-ui,sans-serif;' +
      'padding:8px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.45);opacity:0;' +
      'transition:opacity .25s;pointer-events:none;max-width:84vw;text-align:center;';
    document.body.appendChild(toastEl);

    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'notif-toggle';
    btn.setAttribute('aria-label', 'Toggle prayer alerts');
    btn.style.cssText =
      'display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(148,163,184,.25);' +
      'background:rgba(148,163,184,.08);color:#cbd5e1;border-radius:999px;padding:6px 12px;' +
      'font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap;line-height:1;';
    btn.addEventListener('click', onToggle);

    var host = document.querySelector('.header-meta');
    if (host) host.insertBefore(btn, host.firstChild);
    else document.body.appendChild(btn);

    render();
  }

  async function enable() {
    if (!vapidPublicKey()) { toast('Alerts not configured (missing key).'); throw new Error('no vapid key'); }
    if (isIOS && !isStandalone) {
      toast('On iPhone: Share → Add to Home Screen, open it from the icon, then enable.');
      throw new Error('not installed');
    }
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications are blocked — enable them in Settings.'); throw new Error('denied'); }

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
    state = 'on';
    toast('Prayer alerts on');
  }

  async function disable() {
    var info = await getRegAndSub();
    if (info.sub) {
      await deleteSubscription(info.sub);
      try { await info.sub.unsubscribe(); } catch (_) { /* ignore */ }
    }
    state = 'off';
    toast('Prayer alerts off');
  }

  async function onToggle() {
    if (state === 'busy') return;
    var prev = state;
    state = 'busy'; render();
    try {
      if (prev === 'on') await disable();
      else await enable();
    } catch {
      // enable()/disable() already toasted the reason; restore real state.
      await refreshState();
      return;
    }
    render();
  }

  // Reflect the actual current state on load — no forced/persistent message.
  async function refreshState() {
    try {
      if (Notification.permission === 'granted') {
        var info = await getRegAndSub();
        if (info.sub) {
          try { await saveSubscription(info.sub); } catch (_) { /* keep state even if save fails */ }
          state = 'on'; render(); return;
        }
      }
    } catch (_) { /* fall through to off */ }
    state = 'off'; render();
  }

  function init() {
    if (!supported) return;
    injectUI();
    refreshState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
