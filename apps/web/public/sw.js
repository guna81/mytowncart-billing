// SPDX-License-Identifier: Apache-2.0
// Offline app shell for the hosted web app (registered only when VITE_HOSTED=1).
// Shop data lives in IndexedDB, not here; this only caches the app's own files.
// Cross-origin requests (the MyTownCart API) are never touched or cached.
// The app lives at the site root, next to other pages (/download/, /app/
// redirect, robots.txt…), so only the app's own files are handled here.
const CACHE = "mtc-billing-shell-v2";
const APP_DIRS = ["assets/", "brand/", "pwa/"];
const APP_FILES = ["manifest.webmanifest"];

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, fallbackKey) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(fallbackKey ?? request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(fallbackKey ?? request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  const path = url.pathname.slice(scope.pathname.length);

  if (request.mode === "navigate") {
    // Only the app's own page; /download/ and the rest go straight to the network.
    if (path !== "" && path !== "index.html") return;
    // Always try for the newest app; offline, open the last one we saw.
    event.respondWith(networkFirst(request, new URL("./", scope).toString()));
  } else if (path.startsWith("assets/")) {
    // Vite's hashed bundles never change under the same name.
    event.respondWith(cacheFirst(request));
  } else if (APP_DIRS.some((d) => path.startsWith(d)) || APP_FILES.includes(path)) {
    event.respondWith(networkFirst(request));
  }
});
