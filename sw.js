// Slotify service worker — push notifications + offline app shell.
// Bump CACHE_VERSION whenever you deploy changes so everyone gets the update.
const CACHE_VERSION = 'slotify-v3';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './bg-pattern.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates show up straight away), cache as the offline fallback.
// Only same-origin GET requests are cached — database/API calls always go to the network.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/.netlify/')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))
      )
  );
});

// A real push message arriving from the server — works even when the app is closed.
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
