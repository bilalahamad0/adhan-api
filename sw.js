/*
 * Adhan Operations Dashboard — Web Push service worker.
 *
 * Hosted at /adhan-api/sw.js (GitHub Pages), scope /adhan-api/. Receives the
 * push sent by the Raspberry Pi (media-caster PushNotifier, via the standard
 * Web Push/VAPID protocol that Apple's APNs honours for Home-Screen web apps on
 * iOS 16.4+) and renders the prayer notification. No Firebase here — this is a
 * plain W3C Push API worker.
 */
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Adhan';
  const options = {
    body: data.body || 'It’s time for prayer.',
    icon: data.icon || 'icons/icon-192.png',
    badge: data.badge || 'icons/icon-192.png',
    tag: data.tag || 'adhan-prayer',
    renotify: true,
    requireInteraction: false,
    data: { url: data.url || './dashboard.html' },
  };

  // userVisibleOnly:true subscriptions MUST show a notification for every push,
  // or iOS may revoke the subscription — so always resolve via showNotification.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './dashboard.html';
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
