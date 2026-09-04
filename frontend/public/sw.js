/*
 * Service worker — offline app shell plus last-fetch API cache.
 *
 * Plain JS in `public/` rather than a bundled `src/sw.ts` entry. A second
 * Rollup entry point would need its own output naming and would still not know
 * the hashed asset filenames without a manifest plugin, so the precache list
 * could not be authored by hand either way. Runtime caching sidesteps the whole
 * problem: the first visit populates the cache with whatever the app actually
 * requested, hashes and all, and subsequent loads work offline. The cost is that
 * a cold first load must be online — acceptable, and true of any install flow.
 *
 * Strategies:
 *   navigation   → network-first, fall back to the cached shell
 *   static asset → cache-first (hashed filenames, so they are immutable)
 *   API read     → network-first, fall back to cache, and mark the fallback
 *   API write    → never cached, never queued
 *   SSE          → never touched; a stream must not pass through a cache
 */

const VERSION = "v1";
const SHELL = `concaretti-shell-${VERSION}`;
const ASSETS = `concaretti-assets-${VERSION}`;
const DATA = `concaretti-data-${VERSION}`;

/**
 * Reads worth keeping for offline viewing. Everything else stays live-only.
 *
 * Deliberately excludes `/api/auth/me` and `/api/conca/status`. Both are
 * role-scoped answers cached under a role-independent URL key, so a cache hit
 * could hand one session the role and agent grants of another. Worse, the store
 * falls back to `public` when `me` fails — least privilege — and a cached
 * response would override that with whatever role was last online. An offline
 * reload dropping to the Public screen is the correct outcome; an offline reload
 * showing staff chrome is not. A stale policy view is also the one thing a
 * security demo must never present as current.
 */
const CACHEABLE_API = [
  "/api/sessions",
  "/api/calendar/events",
  "/api/diary",
  "/api/artifacts",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg"]))
      // A failed shell precache must not abort installation — runtime caching
      // will pick these up on first navigation anyway.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL, ASSETS, DATA]);
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

const isStaticAsset = (url) =>
  /\.(js|css|woff2?|png|jpe?g|svg|webp|ico)$/.test(url.pathname) ||
  url.pathname.startsWith("/assets/");

const isCacheableApi = (url) =>
  CACHEABLE_API.some(
    (p) => url.pathname === p || url.pathname.startsWith(`${p}/`),
  );

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirst(request, cacheName, { stamp = false } = {}) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (!hit) throw err;
    if (!stamp) return hit;
    // Tell the client this body is stale so the UI can say so rather than
    // presenting week-old data as current.
    const headers = new Headers(hit.headers);
    headers.set("X-Concaretti-Cache", "stale");
    return new Response(hit.body, {
      status: hit.status,
      statusText: hit.statusText,
      headers,
    });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Cross-origin and non-GET go straight to the network. In particular a POST
  // must never be replayed from here: re-sending an email or an SMS because a
  // cache decided to retry would be precisely the class of unsupervised action
  // the rest of this app exists to prevent.
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // An event stream through a cache is a hang, not an optimisation.
  if (url.pathname.startsWith("/sse/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("/").then((hit) => hit ?? Response.error()),
      ),
    );
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, ASSETS));
    return;
  }

  if (isCacheableApi(url)) {
    event.respondWith(networkFirst(request, DATA, { stamp: true }));
    return;
  }

  // Everything else — including /api/memory/recall, which must not serve a
  // stale answer, and /api/agents/* which is inherently live.
});
