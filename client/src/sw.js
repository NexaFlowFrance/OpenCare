/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

const sw = /** @type {ServiceWorkerGlobalScope} */ (self);

// workbox-build (injectManifest) searches for the LITERAL string self.__WB_MANIFEST.
// Must reference self directly here; aliased access (sw.__WB_MANIFEST) is not detected.
// eslint-disable-next-line no-undef
const precacheManifest = self.__WB_MANIFEST;

// Versionne les caches : un changement de version purge automatiquement les
// anciens caches a l'activation (voir handler 'activate'). Indispensable pour
// eviter qu'un ancien bundle (ex. pointant vers une mauvaise URL d'API) reste
// servi indefiniment apres une mise a jour de l'application.
const CACHE_NAME = 'opencare-v3';
const API_CACHE_NAME = 'opencare-api-v3';
const OFFLINE_URL = '/index.html';

// Lectures API : au-dela de ce delai on sert le cache (reseau EHPAD lent).
const API_NETWORK_TIMEOUT_MS = 3000;
// Borne le cache API pour ne pas grossir indefiniment.
const API_CACHE_MAX_ENTRIES = 200;

// Routes API a NE JAMAIS mettre en cache:
// - routes publiques par token (fiche urgence /public/, lien aidant /link/);
// - /invites/info/ qui expose des PII (nom du proche, des aidants, email cible)
//   et n'a pas de raison d'etre conserve sur l'appareil.
const isUncacheableApiPath = (pathname) =>
    pathname.includes('/public/') ||
    pathname.includes('/link/') ||
    pathname.includes('/invites/info/');

const fetchWithTimeout = (request, timeoutMs) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('network timeout')), timeoutMs);
        fetch(request).then(
            (response) => {
                clearTimeout(timer);
                resolve(response);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });

const trimCache = async (cacheName, maxEntries) => {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= maxEntries) return;
    await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
};

sw.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            const urls = precacheManifest
                .filter((entry) => entry.url && !entry.url.startsWith('http'))
                .map((entry) => entry.url);
            // Always keep the app shell available for offline navigation.
            if (!urls.includes(OFFLINE_URL)) urls.push(OFFLINE_URL);
            return cache.addAll(urls).catch(() => {
                // Ignore individual failures (missing assets, etc.)
            });
        }).then(() => sw.skipWaiting())
    );
});

sw.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((k) => k !== CACHE_NAME && k !== API_CACHE_NAME)
                    .map((k) => caches.delete(k))
            )
        ).then(() => sw.clients.claim())
    );
});

// Purge du cache des reponses API a la deconnexion: ces reponses contiennent
// des donnees de sante et ne doivent pas rester lisibles hors ligne pour un autre
// utilisateur d'un appareil partage (tablette d'EHPAD, poste familial).
sw.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'PURGE_API_CACHE') {
        event.waitUntil(caches.delete(API_CACHE_NAME));
    }
});

sw.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // App navigations: try the network first, fall back to the cached shell when offline.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).catch(() =>
                caches.match(request).then((cached) => cached ?? caches.match(OFFLINE_URL))
            )
        );
        return;
    }

    // API reads: network-first (3s timeout) with a cache fallback so data
    // stays viewable offline. Public token routes are never cached.
    if (url.pathname.includes('/api/')) {
        if (isUncacheableApiPath(url.pathname)) return;
        event.respondWith(
            fetchWithTimeout(request, API_NETWORK_TIMEOUT_MS)
                .then((response) => {
                    if (response && response.ok) {
                        const clone = response.clone();
                        event.waitUntil(
                            caches
                                .open(API_CACHE_NAME)
                                .then((cache) => cache.put(request, clone))
                                .then(() => trimCache(API_CACHE_NAME, API_CACHE_MAX_ENTRIES))
                        );
                    }
                    return response;
                })
                .catch(() =>
                    caches.match(request).then((cached) => {
                        if (cached) return cached;
                        return new Response(
                            JSON.stringify({ success: false, error: 'offline', offline: true }),
                            { status: 503, headers: { 'Content-Type': 'application/json' } }
                        );
                    })
                )
        );
        return;
    }

    // Static assets: cache-first.
    event.respondWith(
        caches.match(request).then((cached) => cached ?? fetch(request))
    );
});

// ── Push notifications ───────────────────────────────────────────────────────

sw.addEventListener('push', (event) => {
    if (!event.data) return;

    let payload;
    try {
        payload = event.data.json();
    } catch {
        payload = { title: 'OpenCare', body: event.data.text() };
    }

    const title = payload.title ?? 'OpenCare';
    const options = {
        body: payload.body ?? '',
        icon: '/icon-192.png',
        badge: '/icon-72.png',
        tag: payload.tag ?? 'opencare',
        data: { url: payload.url ?? '/' },
        requireInteraction: false,
        vibrate: [200, 100, 200],
    };

    event.waitUntil(sw.registration.showNotification(title, options));
});

sw.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url ?? '/';

    event.waitUntil(
        sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) {
                    void client.focus();
                    void client.navigate(url);
                    return;
                }
            }
            return sw.clients.openWindow(url);
        })
    );
});
