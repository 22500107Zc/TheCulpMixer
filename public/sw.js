/*
 * The Culp Mixer's service worker.
 *
 * The Culp Mixer is a single static bundle with no backend, so "offline" means holding
 * the shell — index, script, stylesheet, icons — and serving it when the
 * network is not there.
 *
 * Three things this has to get right, and each of them used to be wrong.
 *
 * 1. Offline has to work after the *first* visit. A worker does not intercept
 *    the page load that registered it, so a runtime-only cache is still empty
 *    when that visit ends: the app opened once, the creator went offline, and
 *    the tab failed to load at all. So the shell is precached during install,
 *    from a list written by the build, rather than hoped for as a side effect
 *    of traffic.
 *
 * 2. The cache has to be keyed to the build. A constant name means a rebuild
 *    writes new files into the same box beside the old ones, which then stay
 *    there for ever. BUILD is stamped in at build time, so each version gets
 *    its own cache and the previous one is released when it is no longer in
 *    use by an open tab.
 *
 * 3. Cleanup must not reach past The Culp Mixer. The old activate step deleted *every*
 *    cache on the origin that was not its own — someone else's app on the same
 *    host, or The Culp Mixer's own model cache. Only caches this worker owns are
 *    touched, by prefix, and the model cache is deliberately not one of them:
 *    the depth model is forty megabytes and does not change between builds.
 */

// Both lines are rewritten by the build (see stampServiceWorker in
// vite.config.ts). The values here are what an unprocessed copy uses — a dev
// server, or someone opening public/sw.js directly — and stay valid JavaScript
// so that copy still works.
const BUILD = 'dev'; // __KLINE_BUILD__
const PRECACHE = ['./']; // __KLINE_PRECACHE__

const SHELL = `The Culp Mixer-shell-${BUILD}`;
/** Big immutable downloads. Survives a shell update on purpose. */
const LARGE = 'The Culp Mixer-large-v1';
/** Everything this worker is allowed to delete. */
const OWNED = /^The Culp Mixer-(shell|large)-/;

/** Downloads too large to hold in a per-build cache. */
function isLarge(pathname) {
  return /\/(models|ort)\//.test(pathname) || pathname.endsWith('.onnx') || pathname.endsWith('.wasm');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // One at a time rather than addAll: addAll rejects as a unit, so a single
    // missing file would leave the app with no offline support at all instead
    // of offline support minus one icon.
    await Promise.all(PRECACHE.map(async (path) => {
      try {
        const response = await fetch(new Request(path, { cache: 'reload' }));
        if (response.ok) await cache.put(path, response);
      } catch {
        /* Best effort; the runtime cache will pick it up later. */
      }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      // Only ours, and only the builds that are no longer current. Anything
      // else on this origin belongs to somebody else.
      if (OWNED.test(key) && key !== SHELL && key !== LARGE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// The page offers the creator a reload when a new version is waiting; this is
// how that reload takes effect. Nothing activates over a running tab unasked.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'kline:activate-update') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    // Navigations go to the network first so a rebuild is picked up straight
    // away, and fall back to the cached shell so the app opens offline.
    if (request.mode === 'navigate') {
      const shell = await caches.open(SHELL);
      try {
        const fresh = await fetch(request);
        if (fresh.ok) shell.put('./', fresh.clone());
        return fresh;
      } catch {
        return (await shell.match('./'))
          ?? (await shell.match('./index.html'))
          ?? (await caches.match('./'))
          ?? Response.error();
      }
    }

    const cache = await caches.open(isLarge(url.pathname) ? LARGE : SHELL);
    const cached = await cache.match(request);
    if (cached) {
      // Hashed assets never change under their name, so there is nothing to
      // revalidate; anything else is refreshed quietly for the next load.
      if (!/\/assets\/.*-[A-Za-z0-9_-]{8,}\./.test(url.pathname)) {
        event.waitUntil(fetch(request)
          .then((r) => (r.ok ? cache.put(request, r.clone()) : undefined))
          .catch(() => undefined));
      }
      return cached;
    }
    const response = await fetch(request);
    if (response.ok) event.waitUntil(cache.put(request, response.clone()));
    return response;
  })());
});
