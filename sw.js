/* AquaGestión Service Worker — offline-first cache */
const CACHE_VERSION = 'aquagestion-v27';
// Nota: NO se incluye './index.html' a propósito. En Cloudflare Pages (y Netlify)
// '/index.html' responde con una redirección 308 hacia '/', y la Cache API rechaza
// toda la operación addAll cuando un recurso redirige, lo que rompía el modo offline
// (error 404 al abrir la app instalada). Se cachea la raíz './' que sí responde 200.
const ASSETS = [
  './',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/utils.js',
  './js/export.js',
  './js/services.js',
  './js/finanzas.js',
  './js/libro.js',
  './js/views/pago.js',
  './js/views/caja.js',
  './js/views/dashboard.js',
  './js/views/clientes.js',
  './js/views/pedidos.js',
  './js/views/cobranza.js',
  './js/views/rutas.js',
  './js/views/seguimiento.js',
  './js/views/gastos.js',
  './js/views/mantenimiento.js',
  './js/views/inventario.js',
  './js/views/reportes.js',
  './js/views/configuracion.js',
  './vendor/xlsx.full.min.js',
  './vendor/jspdf.umd.min.js',
  './vendor/jspdf.plugin.autotable.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Se cachea cada recurso de forma individual y tolerante a fallos: si alguno
      // falla o redirige, no se aborta toda la instalación del Service Worker.
      Promise.allSettled(
        ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
            console.warn('SW: no se pudo precachear', url, err);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Network-first for navigation, cache fallback (offline)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        // Offline: se sirve la raíz cacheada ('./'). El enrutado es por hash,
        // así que index.html (raíz) reconstruye cualquier vista (#/dashboard, etc.).
        caches.match('./', { ignoreSearch: true })
          .then((cached) => cached || caches.match('./index.html'))
      )
    );
    return;
  }

  // Cache-first for everything else (static assets)
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Cache same-origin successful responses on the fly
        if (res && res.status === 200 && req.url.startsWith(self.location.origin)) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
