/* Stride service worker
   Strategy:
   - HTML (index.html, "./"): NETWORK-FIRST. Try the network first so app updates
     are picked up immediately. Fall back to cache only if offline.
   - Everything else (React CDN libs, etc.): CACHE-FIRST. These don't change.
   - Bump CACHE_VERSION on every release. The activate handler deletes any older
     caches, guaranteeing all users get the fresh version on their next visit.
*/

const CACHE_VERSION = "stride-app-v3";

const APP_SHELL = [
  "./",
  "./index.html",
];

// Install: pre-cache the app shell.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate: delete every cache that doesn't match the current version.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Helper: is this an HTML page request?
function isHTMLRequest(req) {
  if (req.mode === "navigate") return true;
  const accept = req.headers.get("accept") || "";
  return accept.includes("text/html");
}

// Fetch handler:
// - HTML: network-first (so updates show up). On network success, refresh the cache.
//   On network failure, fall back to the cached copy (offline mode).
// - Everything else: cache-first (instant, fine for static CDN libs).
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  if (isHTMLRequest(req)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }

  // Static assets (JS libs from CDN, etc.): cache-first.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && (res.status === 200 || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
