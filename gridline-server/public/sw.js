// GridWatch service worker — exists purely to satisfy Chrome's installability requirement for the
// "Add to Home Screen"/"Install app" prompt: a web app manifest with icons (see manifest.json) is
// not enough on its own; Chrome also requires a registered service worker with a fetch handler,
// even if that handler does nothing but pass every request straight through to the network. This
// file deliberately does NOT cache anything and does NOT provide offline support — GRIDLINE is a
// live, realtime-data app, so serving a stale cached copy while offline would be actively
// misleading (wrong breaker states, wrong feeder data). If offline support is ever wanted later,
// add a cache strategy here deliberately, rather than accidentally inheriting one.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
