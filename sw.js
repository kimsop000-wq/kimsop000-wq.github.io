/* sw.js - TripGrid PWA Offline */

importScripts("/sw-version.js");

const SCOPE_URL = new URL(self.registration.scope);
const CACHE_VERSION =
  typeof self.__SW_VERSION__ === "string" && self.__SW_VERSION__
    ? self.__SW_VERSION__
    : "dev";
const CACHE_NAME = `tripgrid-shell-${CACHE_VERSION}`;
const CACHE_PREFIX = "tripgrid-shell-";
const MAX_CACHE_GENERATIONS = 3;
const PRECACHE_MANIFEST_URL = joinBase("precache.json");

const CORE_ASSETS = [
  "index.html",
  "manifest.webmanifest",
  "vite.svg",
  "icons/pwa-192x192.png",
  "icons/pwa-512x512.png",
  "icons/pwa-maskable-512x512.png",
].map(joinBase);

function joinBase(relPath) {
  return new URL(relPath, SCOPE_URL).pathname;
}

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function toCacheKey(input) {
  const url = new URL(input, self.location.origin);
  return `${url.pathname}${url.search}`;
}

async function cacheOne(cache, url) {
  const key = toCacheKey(url);
  try {
    const res = await fetch(new Request(key, { cache: "reload" }));
    if (res && (res.ok || res.type === "opaque")) {
      await cache.put(key, res.clone());
      return { url: key, ok: true };
    }
    return { url: key, ok: false, reason: `bad response: ${res && res.status}` };
  } catch (error) {
    return { url: key, ok: false, reason: String(error) };
  }
}

async function loadPrecacheList() {
  try {
    const res = await fetch(new Request(PRECACHE_MANIFEST_URL, { cache: "no-store" }));
    if (!res.ok) return [];
    const list = await res.json();
    if (!Array.isArray(list)) return [];
    return list.map(toCacheKey);
  } catch {
    return [];
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const key = toCacheKey(request.url);

  const cached = await cache.match(key);
  if (cached) return cached;

  try {
    const res = await fetch(request);
    if (res && (res.ok || res.type === "opaque")) {
      await cache.put(key, res.clone());
    }
    return res;
  } catch (error) {
    const fallback = await cache.match(key);
    if (fallback) return fallback;
    throw error;
  }
}

async function appShellNavigate() {
  const cache = await caches.open(CACHE_NAME);
  const indexKey = joinBase("index.html");

  const cachedIndex = await cache.match(indexKey);
  if (cachedIndex) return cachedIndex;

  try {
    const res = await fetch(new Request(indexKey, { cache: "no-store" }));
    if (res && res.ok) {
      await cache.put(indexKey, res.clone());
    }
    return res;
  } catch {
    return new Response(
      "Offline: index.html is not cached yet. Open once online to prime the cache.",
      {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }
    );
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      self.skipWaiting();
      const cache = await caches.open(CACHE_NAME);

      const coreResults = await Promise.allSettled(CORE_ASSETS.map((asset) => cacheOne(cache, asset)));
      const manifestList = await loadPrecacheList();
      const merged = Array.from(new Set([...CORE_ASSETS, ...manifestList]));
      const precacheResults = await Promise.allSettled(merged.map((asset) => cacheOne(cache, asset)));

      const values = (results) =>
        results.map((r) => (r.status === "fulfilled" ? r.value : null)).filter(Boolean);
      const failed = [...values(coreResults), ...values(precacheResults)].filter((item) => !item.ok);
      if (failed.length) {
        console.warn("[SW] install: some assets failed to cache", failed);
      }
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const shellKeys = keys.filter((key) => key.startsWith(CACHE_PREFIX));
      const keep = new Set(shellKeys.slice(-MAX_CACHE_GENERATIONS));

      await Promise.all(
        keys.map((key) => {
          if (!key.startsWith(CACHE_PREFIX)) return caches.delete(key);
          if (key === CACHE_NAME) return undefined;
          if (keep.has(key)) return undefined;
          return caches.delete(key);
        })
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (!isSameOrigin(url)) return;

  const accept = req.headers.get("accept") || "";
  const isNavigation = req.mode === "navigate" || accept.includes("text/html");
  if (isNavigation) {
    event.respondWith(appShellNavigate());
    return;
  }

  const path = url.pathname;
  const isStaticAsset =
    path.startsWith(joinBase("assets/")) ||
    path.startsWith(joinBase("icons/")) ||
    path === joinBase("manifest.webmanifest");

  if (isStaticAsset) {
    event.respondWith(cacheFirst(req));
    return;
  }
});
