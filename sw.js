/* Stride service worker — v18
   Strategy:
   - HTML (index.html, "./"):   NETWORK-FIRST so app updates show up immediately.
                                Falls back to cache in specificity order when offline
                                (exact URL → ./index.html → ./ → minimal offline shell).
   - React/ReactDOM CDN libs:   CACHE-FIRST. They never change for a pinned URL.
   - Anything else (assets):    CACHE-FIRST with network refresh on miss.

   Install hardening:
   - Use cache.add() per URL with .catch so a single 404 doesn't abort install.
   - Pre-cache the React CDN scripts so offline reload works after the first
     successful online visit (not just the HTML shell).
   - Cap the CDN cache at MAX_CDN_ENTRIES and prune oldest entries on overflow.

   Deploy note (CRITICAL — do not skip):
   - The HTML calls navigator.serviceWorker.register("./sw.js")
   - The DEPLOYED filename on GitHub Pages MUST be exactly `sw.js`
   - The source-side name is `sw-stride.js` only to distinguish it from sibling
     projects in the same outputs folder. Rename to `sw.js` before every upload.
   - If register("./sw.js") 404s in DevTools/Web Inspector, the file was NOT
     renamed. That's the entire cause; there's no other config to adjust.
   - Keep CACHE_VERSION bumped each deploy so users get the new SW on next reload.
*/

const CACHE_VERSION = "stride-app-v20";
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
  //
  // Offline fallback is an EXPLICIT async chain: cache-match for the exact URL,
  // then ./index.html, then ./. The old `||` chain didn't work because
  // caches.match returns a Promise (always truthy in a boolean context), so
  // the fallback options after the first were unreachable. This version awaits
  // each and only falls through when the previous returned no cached response.
  if (isHTMLRequest(req)) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch (err) {
        // Network failed — try the cache in order of specificity.
        const cache = await caches.open(CACHE_VERSION);
        const forReq = await cache.match(req);
        if (forReq) return forReq;
        const indexHtml = await cache.match("./index.html");
        if (indexHtml) return indexHtml;
        const root = await cache.match("./");
        if (root) return root;
        // Last resort: a minimal offline shell so the browser doesn't show
        // its own "no internet" chrome. Users seeing this means the first
        // load never completed successfully on this device.
        return new Response(
          "<!doctype html><meta charset=utf-8><title>Stride offline</title>" +
          "<style>body{font-family:-apple-system,sans-serif;padding:40px;text-align:center;color:#333}</style>" +
          "<h1>Offline</h1><p>Stride needs a first online load before it can work offline. " +
          "Connect to Wi-Fi or cellular, then reload.</p>",
          { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 200 }
        );
      }
    })());
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
