/* eslint-env serviceworker */
/**
 * Service worker ЗАПИСОК.
 *
 * Оффлайн — нормальный режим работы, а не сбой (SCREENS §10), поэтому задача
 * воркера ровно одна: чтобы приложение открывалось без сети.
 *
 * Стратегии:
 *  • навигация — сеть, при отказе оболочка из кэша (приложение стартует и
 *    работает с локальным vault'ом). Оболочку кэширует только сама оболочка:
 *    на домене есть и обычные страницы, и любая из них, попав под ключ
 *    оболочки, подменила бы собой приложение;
 *  • `/assets/*` — кэш: имена содержат хеш содержимого, значит неизменяемы;
 *  • остальное с этого источника — сеть с тихой подстраховкой из кэша;
 *  • `/api/*` — только сеть. Кэшировать ответы API нельзя: очередь изменений
 *    ведёт ядро, и «свежий» ответ из кэша сломал бы синхронизацию.
 *
 * Файл лежит в `public/` и попадает в сборку как есть — поэтому здесь обычный
 * JS без сборочных зависимостей и без списка захешированных имён.
 */

/*
 * Версия кэша. Поднята с v1 намеренно: на устройствах, где хоть раз открывали
 * промостраницу, под ключом оболочки лежит ОНА (см. `refreshShell` ниже).
 * Переименование кэша — единственный способ выбросить это наверняка: `activate`
 * удаляет всё, чего нет в `keep`.
 */
const VERSION = 'v2';
const SHELL_CACHE = `zapiski-shell-${VERSION}`;
const ASSET_CACHE = `zapiski-assets-${VERSION}`;
const SHELL_URL = '/index.html';
/** Куда приходит возврат после входа. Это маршрут приложения, а не файл. */
const AUTH_ROUTE = '/auth';

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

  /*
   * Ссылку из письма воркер НЕ ТРОГАЕТ. Раньше трогал, и вот чем это кончалось.
   *
   * Правило заводилось, когда сервер ждал `device_id` отдельно, а знал его
   * только клиент: переход уводился в веб-приложение, и обмен делало оно.
   * Потом сервер стал класть `device_id` в саму ссылку — всегда, на любой
   * платформе, — и правило осталось лишним. Не безобидно лишним.
   *
   * Воркер живёт на ВЕСЬ домен (`scope: '/'`), а ссылка из письма приходит и
   * тем, кто просил её из приложения. На телефоне, где хоть раз открывали
   * zapiski.cmpas.ru, воркер перехватывал переход и уводил человека в
   * веб-приложение — вместо сервера, который по платформе вернул бы его в
   * ЗАПИСКИ по `zapiski://`. Вход из приложения на Android не замыкался
   * никогда, а выглядело это как «сайт вместо приложения».
   *
   * Теперь решение принимает сервер — единственный, кто знает платформу,
   * записанную к токену.
   */
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    /* Возврат после входа — маршрут приложения, а не файл на диске: отдаём
       оболочку, не спрашивая сеть. Иначе статика ответила бы 404 на адрес,
       которого в ней нет, и токен пропал бы вместе со страницей. */
    if (url.pathname === AUTH_ROUTE || url.pathname.startsWith(`${AUTH_ROUTE}/`)) {
      event.respondWith(appShell());
      return;
    }
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

/** Оболочка приложения: из кэша, а если её там нет — с сервера. */
async function appShell() {
  const cache = await caches.open(SHELL_CACHE);
  const cached = (await cache.match(SHELL_URL)) ?? (await cache.match('/'));
  if (cached) return cached;
  const response = await fetch(SHELL_URL);
  if (response.ok) cache.put(SHELL_URL, response.clone());
  return response;
}

/**
 * Как часто перечитывать оболочку. Раз в пять минут: чаще незачем, реже —
 * человек будет неделю сидеть на старой сборке.
 */
const SHELL_REFRESH_MS = 5 * 60 * 1000;
let shellRefreshedAt = 0;

/**
 * Обновление оболочки — ОТДЕЛЬНЫМ запросом за `/index.html`.
 *
 * Раньше под ключом оболочки сохранялся ответ на текущий переход, какой бы он
 * ни был. А на этом домене по обычным адресам лежат обычные страницы: /promo,
 * /terms, /privacy, /macos-warning. Стоило открыть промостраницу — и она
 * становилась «оболочкой приложения»: дальше любой переход, отвеченный из
 * кэша, показывал промо. Заказчик так и описал: после ссылки из письма
 * открывается промо со ссылками на скачивание.
 */
async function refreshShell() {
  const now = Date.now();
  if (now - shellRefreshedAt < SHELL_REFRESH_MS) return;
  shellRefreshedAt = now;
  const response = await fetch(SHELL_URL, { cache: 'no-store' }).catch(() => null);
  if (response && response.ok) {
    const cache = await caches.open(SHELL_CACHE);
    await cache.put(SHELL_URL, response.clone());
  }
}

async function networkFirstShell(request) {
  try {
    const response = await fetch(request);
    /* Ответ на ЭТОТ переход не становится оболочкой ни при каких условиях. */
    void refreshShell();
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
