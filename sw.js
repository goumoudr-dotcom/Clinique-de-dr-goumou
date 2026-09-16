/* =========================================================================
   CMCD App — Service Worker
   Stratégie :
   - App Shell (index.html, manifest, icônes) : cache-first, mise à jour en
     arrière-plan (stale-while-revalidate) pour rester à jour sans bloquer.
   - Librairies Firebase (CDN gstatic) : cache-first avec fallback réseau —
     une fois chargées une fois, l'app peut redémarrer hors-ligne.
   - Tout le reste (API Firebase Auth/Firestore, appels réseau dynamiques) :
     jamais intercepté — on laisse le SDK Firebase gérer sa propre
     persistance offline (voir enablePersistence() dans index.html).
========================================================================= */

const CACHE_VERSION = "cmcd-v1";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const CDN_CACHE = `${CACHE_VERSION}-cdn`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

// Domaines dont les ressources sont mises en cache "cache-first"
// (librairies statiques versionnées, ne changent jamais une fois publiées)
const CDN_HOSTS = ["www.gstatic.com"];

// Domaines Firebase à NE JAMAIS intercepter (auth, données temps réel)
const NEVER_CACHE_HOSTS = [
  "firestore.googleapis.com",
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "firebaseinstallations.googleapis.com",
  "www.googleapis.com",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("cmcd-") && k !== SHELL_CACHE && k !== CDN_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // ne jamais intercepter POST/PUT (écritures Firestore, etc.)

  const url = new URL(req.url);

  // 1. Ne jamais toucher aux endpoints Firebase dynamiques (auth, firestore).
  if (NEVER_CACHE_HOSTS.some((h) => url.hostname === h)) {
    return; // laisse passer directement au réseau
  }

  // 2. Librairies Firebase CDN : cache-first, avec mise à jour silencieuse.
  if (CDN_HOSTS.some((h) => url.hostname === h)) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }

  // 3. Même origine (app shell) : stale-while-revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }

  // 4. Tout le reste : réseau, avec fallback cache si dispo.
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) {
    // Rafraîchit en arrière-plan sans bloquer la réponse
    fetchAndCache(request, cacheName).catch(() => {});
    return cached;
  }
  return fetchAndCache(request, cacheName);
}

async function staleWhileRevalidate(request, cacheName) {
  const cached = await caches.match(request);
  const networkPromise = fetchAndCache(request, cacheName).catch(() => null);
  if (cached) {
    return cached;
  }
  const fresh = await networkPromise;
  if (fresh) return fresh;
  // Dernier recours pour une navigation offline sans cache : renvoyer l'index.
  if (request.mode === "navigate") {
    const fallback = await caches.match("./index.html");
    if (fallback) return fallback;
  }
  throw new Error("Ressource indisponible hors-ligne : " + request.url);
}

async function fetchAndCache(request, cacheName) {
  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

// Permet à la page de déclencher l'activation immédiate d'une nouvelle version
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
