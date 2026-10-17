// Kinex PWA Service Worker
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

// Always fetch live data from the server for real-time fintech balances
self.addEventListener('fetch', (event) => {
    event.respondWith(fetch(event.request));
});