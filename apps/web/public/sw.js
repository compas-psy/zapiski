/* eslint-env serviceworker */
/**
 * Service worker КОМПАС.ЗАПИСКИ.
 *
 * Оффлайн — нормальный режим работы, а не сбой (SCREENS §10), поэтому задача
 * воркера ровно одна: чтобы приложение открывалось без сети.
 *
 * Стратегии:
 *  • навигация — сеть, при отказе оболочка из кэша (приложение стартует и
 *    работает с локальным vault'ом);
 *  • `/assets/*` — кэш: имена содержат хеш содержимого, значит неизменяемы;
 *  • остальное с этого источника — сеть с тихой подстраховкой из кэша;
 *  • `/api/*` — только сеть. Кэшировать ответы API нельзя: очередь изменений
 *    ведёт ядро, и «свежий» ответ из кэша сломал бы синхронизацию.
 *
 * Файл лежит в `public/` и попадает в сборку как есть — поэтому здесь обычный
 * JS без сборочных зависимостей и без списка захешированных имён.
 */

const VERSION = 'v1';
const SHELL_CACHE = `zapiski-shell-${VERSION}`;
const ASSET_CACHE = `zapiski-assets-${VERSION}`;
const SHELL_URL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(['/', SHELL_URL, '/manifest.webmanifest']).catch(() => undefined);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      for (const name of await caches.keys()) {
        if (!keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
  event.respondWith(networkThenCache(request, SHELL_CACHE));
});

/** Обновление применяем только по явной команде — не рвём набор текста. */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting();
});

async function networkFirstShell(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    cache.put(SHELL_URL, response.clone());
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const cached = (await cache.match(SHELL_URL)) ?? (await cache.match('/'));
    if (cached) return cached;
    throw new Error('offline');
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkThenCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error('offline');
  }
}
