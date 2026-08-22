// Porcupine Service Worker — sw.js
// Handles background notifications when transfer completes

const CACHE_NAME = 'porcupine-v1';
const STATIC_ASSETS = ['/', '/index.html', '/css/style.css', '/js/app.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// Listen for messages from the main page
self.addEventListener('message', (event) => {
  if (event.data?.type === 'NOTIFY') {
    const { title, body } = event.data;
    self.registration.showNotification(title, {
      body,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: 'porcupine-transfer',
      renotify: true,
    });
  }
});
