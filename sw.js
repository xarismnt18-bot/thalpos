// Thalpos service worker: makes the dashboard installable on a phone and shows a
// friendly page when the PC (or the connection) is down. It never caches the
// app or /api data, so readings are always live and updates show at once.
const CACHE = "thalpos-offline-v2";
const OFFLINE = "offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, "icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return; // everything else: straight to the network
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});
