// Slotify service worker — enables notification display and (later) offline caching.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Handles a real push message arriving from the server — this is what lets a
// reminder fire even if the app is fully closed or the phone is locked.
self.addEventListener('push', (event) => {
  let data = { title: 'Slotify', body: 'You have a class coming up.' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) { /* fall back to default text above */ }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Slotify', {
      body: data.body || '',
      icon: data.icon || './icon-192.png',
      tag: 'slotify-reminder',
      vibrate: [200, 100, 200],
    })
  );
});

// Tapping a notification focuses an already-open tab, or opens a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

// Simple network passthrough for now — no offline caching yet.
self.addEventListener('fetch', () => {});

