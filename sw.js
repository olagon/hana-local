// Service worker for hana-local. Precache the whole app shell so the app
// launches offline. Model weights are cached separately by WebLLM itself
// (Cache API), so this worker deliberately ignores cross-origin requests —
// it never adds a network dependency, it only removes them.

const CACHE = "hana-local-shell-v8";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./vendor/web-llm.js",
  "./vendor/preact.module.js",
  "./vendor/hooks.module.js",
  "./vendor/htm.module.js",
  "./fonts/fonts.css",
  "./fonts/Fraunces-italic-500.woff2",
  "./fonts/Fraunces-normal-400.woff2",
  "./fonts/Fraunces-normal-600.woff2",
  "./fonts/IBMPlexMono-normal-400.woff2",
  "./fonts/IBMPlexMono-normal-500.woff2",
  "./fonts/IBMPlexSans-normal-400.woff2",
  "./fonts/IBMPlexSans-normal-500.woff2",
  "./fonts/IBMPlexSans-normal-600.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Same-origin only, and never the model files: WebLLM keeps its own copy
  // in the browser cache, so caching them here would double ~2 GB on disk.
  if (url.origin !== location.origin) return;
  if (event.request.method !== "GET") return;
  if (url.pathname.includes("/models/")) return;

  // Network-first, revalidating: "no-cache" makes the browser check with the
  // server (a cheap 304 when unchanged) instead of trusting its heuristic
  // HTTP cache, so deploys show up on the next reload; offline, the cache
  // answers.
  event.respondWith(
    fetch(event.request, { cache: "no-cache" })
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return resp;
      })
      .catch(() =>
        caches
          .match(event.request, { ignoreSearch: true })
          .then((hit) => hit || Response.error())
      )
  );
});
