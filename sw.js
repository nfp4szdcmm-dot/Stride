/* Stride service worker
   After the first successful online load, the app and its libraries are cached,
   so it opens instantly and works with no internet connection. */

const CACHE = "stride-app-v1";

// The core files the app needs to run. The CDN libraries are cached at runtime
// the first time they're fetched (see the fetch handler below).
const APP_SHELL = [
  "./",
  "./index.html",
];

// On install: pre-cache the app shell.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

// On activate: clean up any older caches.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// On fetch: serve from cache first (instant + offline), otherwise fetch from the
// network and store a copy for next time. This covers both the app's own files
// and the React libraries loaded from the CDN.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && (res.status === 200 || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
