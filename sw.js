const CACHE_NAME = "english-word-trainer-v24";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=1.3.15",
  "./app.js?v=1.3.15",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

function shouldFetchFresh(request) {
  if (request.mode === "navigate") return true;
  const destination = request.destination;
  return destination === "script" || destination === "style" || destination === "document";
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (shouldFetchFresh(event.request)) {
    event.respondWith(
      fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      }).catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) =>
      cached || fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      }).catch(() => caches.match("./index.html"))
    )
  );
});
