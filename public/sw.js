/* Card profit service worker.
 *
 * Strategy: NETWORK FIRST, cache as the offline fallback. A deployed update is
 * therefore picked up on the very next load even if the browser still holds an
 * old worker; the cache can never mask a new version while you are online.
 *
 * To force-refresh every cached file, bump VERSION here AND APP_VERSION in
 * app.js (the old cache is deleted on activate).
 */
const VERSION = "1.0";
const CACHE = "card-profit-v" + VERSION;
const NETWORK_TIMEOUT_MS = 4000;

const ASSETS = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  "icons/favicon-32.png",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: "reload" bypasses the HTTP cache so we never precache stale files
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // live-rate APIs etc. go straight to the network
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);

  const network = fetch(req, { cache: "no-cache" }).then((res) => {
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  });

  const cached = () =>
    cache.match(req, { ignoreSearch: true }).then((hit) =>
      hit || (req.mode === "navigate" ? cache.match("index.html") : undefined));

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(cached()), NETWORK_TIMEOUT_MS);   // slow network: use the cache if we have one
  });

  try {
    const res = await Promise.race([network, timeout]);
    clearTimeout(timer);
    if (res) return res;
    return await network;                                              // slow and nothing cached: keep waiting
  } catch (err) {
    clearTimeout(timer);
    const hit = await cached();                                        // offline
    if (hit) return hit;
    throw err;
  }
}
