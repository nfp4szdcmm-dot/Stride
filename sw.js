/* Stride service worker — v16
   Strategy:
   - HTML (index.html, "./"):   NETWORK-FIRST so app updates show up immediately.
                                Falls back to cache only when offline.
   - React/ReactDOM CDN libs:   CACHE-FIRST. They never change for a pinned URL.
   - Anything else (assets):    CACHE-FIRST with network refresh on miss.

   Install hardening:
   - Use cache.add() per URL with .catch so a single 404 doesn't abort install.
   - Pre-cache the React CDN scripts so offline reload works after the first
     successful online visit (not just the HTML shell).
   - Cap the CDN cache at MAX_CDN_ENTRIES and prune oldest entries on overflow.

   Deploy note: this file is uploaded to GitHub Pages as `sw.js`. The HTML's
   navigator.serviceWorker.register("./sw.js") matches. The "-stride" suffix in
   the source filename only exists to distinguish it from sibling projects in
   the same outputs folder; rename to sw.js before deploying.
*/

const CACHE_VERSION = "stride-app-v17";
const MAX_CDN_ENTRIES = 30; // pruned LRU-style on overflow

// Files we expect to live at the same origin as the SW. Order matters: the
// most-critical ("./") goes first so an offline boot can still hand back the
// shell even if a later add fails.
const APP_SHELL = [
  "./",
  "./index.html",
];

// CDN URLs we want available offline after the first successful load.
const CDN_PREFETCH = [
  "https://unpkg.com/react@18.2.0/umd/react.production.min.js",
  "https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js",
];

// Per-URL safe add: log failures but don't abort the install. A missing CDN
// during install just means the first online load will populate the cache.
function safeAdd(cache, url) {
  return fetch(url, { cache: "reload" })
    .then((res) => {
      if (res && (res.status === 200 || res.type === "opaque")) {
        return cache.put(url, res);
      }
    })
    .catch((err) => {
      console.warn("[sw-stride] precache miss for", url, err);
    });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      // App shell first (must-have), then CDN (best-effort).
      return Promise.all([
        ...APP_SHELL.map((url) => safeAdd(cache, url)),
        ...CDN_PREFETCH.map((url) => safeAdd(cache, url)),
      ]);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function isHTMLRequest(req) {
  if (req.mode === "navigate") return true;
  const accept = req.headers.get("accept") || "";
  return accept.includes("text/html");
}

function isCDNRequest(req) {
  try {
    const u = new URL(req.url);
    return u.host === "unpkg.com" || u.host === "fonts.googleapis.com" || u.host === "fonts.gstatic.com";
  } catch (e) { return false; }
}

// Prune oldest entries from the cache when we exceed MAX_CDN_ENTRIES.
// Cache.keys() returns Request objects in insertion order — perfect for FIFO LRU-ish trim.
async function trimCache() {
  try {
    const cache = await caches.open(CACHE_VERSION);
    const keys = await cache.keys();
    // Only count CDN entries; never evict app-shell entries.
    const cdnKeys = keys.filter((req) => isCDNRequest(req));
    if (cdnKeys.length > MAX_CDN_ENTRIES) {
      const excess = cdnKeys.length - MAX_CDN_ENTRIES;
      for (let i = 0; i < excess; i++) {
        await cache.delete(cdnKeys[i]);
      }
    }
  } catch (e) {
    console.warn("[sw-stride] trimCache failed", e);
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // HTML: network-first → update the cache on success, serve cache on failure.
  // Final fallback when both fail: any cached index.html copy.
  if (isHTMLRequest(req)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) =>
            cached || caches.match("./index.html") || caches.match("./")
          )
        )
    );
    return;
  }

  // Static / CDN assets: cache-first, network fallback. After a network fill,
  // trim the cache to keep storage bounded.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && (res.status === 200 || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(CACHE_VERSION)
              .then((cache) => cache.put(req, copy))
              .then(() => { if (isCDNRequest(req)) trimCache(); })
              .catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
