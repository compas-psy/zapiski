/**
 * Подключение Облака Записок как бэкенда синка.
 *
 * `ZapiskiCloudBackend` живёт в ядре и покрыт тестами на подставном `fetch` —
 * переписывать его незачем. Не хватало двух вещей, и обе платформенные, то
 * есть по месту здесь:
 *
 *  1. **Токен.** Бэкенд принимает строку и держит её всю жизнь, а access-токен
 *     живёт минуты. Поэтому `fetch` подменяется: заголовок `Authorization`
 *     ставится на каждый запрос из `SessionStore`, а 401 один раз приводит к
 *     обновлению и повтору. Пользователь обновления не видит (ТЗ §5.5).
 *
 *  2. **Пути.** Ядро ходит по ADR-0003 (`/vault/list`, `/vault/blob?path=`,
 *     `/vault/push`, `/vault/pull`, `/vault/subscribe`), сервер отвечает по
 *     `/vault/manifest`, `/vault/blob/<path>`, `/vault/crdt/:noteId` и
 *     `/vault/live` (`server/src/routes/vault.ts`, `routes/live.ts`).
 *     Расхождение отмечено ещё в документации; ядро и сервер трогать нельзя,
 *     поэтому согласование сделано здесь — в одном месте, явно и с проверкой.
 *
 * Заодно приводится к одному виду ETag: манифест отдаёт его в кавычках, а
 * заголовок `ETag` ядро от кавычек чистит. Без выравнивания движок синка
 * считал бы неизменившийся файл изменившимся на каждом обороте.
 */
import {
  API_PREFIX,
  ZapiskiCloudBackend,
  VAULT_ENDPOINTS,
  type Locale,
  type SyncCrypto,
  type WebSocketLike,
} from '@zapiski/core';
import type { SessionStore } from './session.js';

/** Пути сервера. Второй половиной таблицы владеет `server/src/routes`. */
const SERVER_ENDPOINTS = {
  manifest: `${API_PREFIX}/vault/manifest`,
  blob: `${API_PREFIX}/vault/blob`,
  crdt: `${API_PREFIX}/vault/crdt`,
  live: `${API_PREFIX}/vault/live`,
} as const;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CloudBackendOptions {
  /** База с префиксом версии, как её отдаёт `AppHost.cloudBaseUrl`. */
  cloudBaseUrl: string;
  session: SessionStore;
  locale?: Locale;
  fetch?: FetchLike;
  /** Фабрика websocket — платформенная; без неё мгновенного синка просто нет. */
  websocket?: (url: string) => WebSocketLike;
  /**
   * SEC-001: ключ шифрования синка.
   *
   * Прикладной путь Облака Записок обязан ходить сюда через
   * `createEncryptedCloudBackend` (`state/cloud-access.ts`), который
   * получает `sync` из разрешённого состояния и без ключа бэкенд вообще
   * не собирает. Эта фабрика оставлена принимающей `sync` отдельно, чтобы
   * не переписывать переходник путей и токена, — но вызывать её напрямую
   * для CMPAS Cloud больше нельзя.
   */
  sync?: SyncCrypto;
}

/**
 * Origin без `/api/v1`: ядро дописывает префикс само, а `cloudBaseUrl` его уже
 * содержит — иначе получилось бы `/api/v1/api/v1/vault/...`.
 */
export function originOf(cloudBaseUrl: string): string {
  return cloudBaseUrl.replace(/\/+$/, '').replace(new RegExp(`${API_PREFIX}$`), '');
}

export function createCloudBackend(options: CloudBackendOptions): ZapiskiCloudBackend {
  const session = options.session;
  const origin = originOf(options.cloudBaseUrl);
  const raw = options.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const current = session.current();

  return new ZapiskiCloudBackend({
    baseUrl: origin,
    // Живой токен ставится на каждый запрос ниже; это значение — только
    // для первого кадра, пока `accessToken()` ещё не спросили.
    token: current?.accessToken ?? '',
    deviceId: current?.deviceId ?? '',
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.sync ? { sync: options.sync } : {}),
    fetch: (input, init) => translate(String(input), init ?? {}, { raw, session, origin }),
    ...(options.websocket
      ? {
          websocket: (url: string) =>
            options.websocket!(liveUrl(url, origin, session.current()?.accessToken ?? '')),
        }
      : {}),
  });
}

interface Wiring {
  raw: FetchLike;
  session: SessionStore;
  origin: string;
}

/**
 * Перевод одного запроса ядра в один (или несколько) запросов сервера.
 *
 * Возвращается всегда `Response` той формы, которую ждёт ядро: подмена не
 * должна быть заметна ни бэкенду, ни его тестам.
 */
async function translate(input: string, init: RequestInit, wiring: Wiring): Promise<Response> {
  const url = new URL(input, wiring.origin);

  if (url.pathname === VAULT_ENDPOINTS.list) return manifest(url, init, wiring);
  if (url.pathname === VAULT_ENDPOINTS.blob) return blob(url, init, wiring);
  if (url.pathname === VAULT_ENDPOINTS.push) return push(init, wiring);
  if (url.pathname === VAULT_ENDPOINTS.pull) return pull(init, wiring);
  return authorized(url.toString(), init, wiring);
}

/** `GET /vault/list` → `GET /vault/manifest`; ETag приводится к виду ядра. */
async function manifest(url: URL, init: RequestInit, wiring: Wiring): Promise<Response> {
  const target = new URL(url.toString());
  target.pathname = SERVER_ENDPOINTS.manifest;
  const response = await authorized(target.toString(), init, wiring);
  if (!response.ok) return response;

  const body = (await response.json()) as {
    entries?: Array<{ path: string; etag: string; mtime: number; size: number }>;
    removed?: string[];
  };
  const entries = (body.entries ?? []).map((entry) => ({ ...entry, etag: unquote(entry.etag) }));
  /*
   * `removed` пропускаем дальше, а не отбрасываем.
   *
   * Переходник раньше собирал ответ заново из одного поля — и надгробия,
   * которые сервер честно присылал по `includeDeleted=1`, умирали здесь, на
   * последнем метре. Ядро их не видело никогда, поэтому удаление не доезжало с
   * устройства на устройство: «в облаке практически невозможно удалить
   * ЗАПИСКУ».
   */
  return jsonResponse(
    body.removed === undefined ? { entries } : { entries, removed: body.removed },
    response.status,
  );
}

/** `?path=` → сегменты пути: сервер читает путь из `*`, а не из query. */
async function blob(url: URL, init: RequestInit, wiring: Wiring): Promise<Response> {
  const path = url.searchParams.get('path') ?? '';
  const encoded = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const target = new URL(`${SERVER_ENDPOINTS.blob}/${encoded}`, wiring.origin);
  return authorized(target.toString(), init, wiring);
}

/**
 * `POST /vault/push` → по запросу на заметку: `POST /vault/crdt/:noteId`.
 *
 * Сервер принимает пачку апдейтов одной заметки, ядро шлёт пачку по всем
 * сразу. Раскладываем по заметкам и собираем ответ обратно в форму ядра.
 */
async function push(init: RequestInit, wiring: Wiring): Promise<Response> {
  const payload = parseBody<{ updates?: Array<{ noteId: string; update: string }> }>(init);
  const byNote = new Map<string, string[]>();
  for (const item of payload?.updates ?? []) {
    const bucket = byNote.get(item.noteId) ?? [];
    bucket.push(item.update);
    byNote.set(item.noteId, bucket);
  }

  let accepted = 0;
  const etags: Record<string, string> = {};
  for (const [noteId, updates] of byNote) {
    const target = new URL(`${SERVER_ENDPOINTS.crdt}/${encodeURIComponent(noteId)}`, wiring.origin);
    const response = await authorized(
      target.toString(),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updates }),
      },
      wiring,
    );
    if (!response.ok) return response;
    const body = (await response.json()) as { seq?: number; accepted?: number };
    accepted += body.accepted ?? updates.length;
    etags[noteId] = String(body.seq ?? '');
  }
  return jsonResponse({ accepted, etags }, 200);
}

/**
 * `POST /vault/pull` → `GET /vault/crdt/:noteId` по каждой заметке.
 *
 * Курсор у сервера — порядковый номер (`since`), у ядра — вектор состояния
 * CRDT; одно из другого не выводится. Поэтому берём весь журнал заметки:
 * применение Yjs-апдейта идемпотентно, лишние байты стоят трафика, но не
 * корректности. Точный курсор появится вместе с курсором в протоколе ядра.
 */
async function pull(init: RequestInit, wiring: Wiring): Promise<Response> {
  const payload = parseBody<{ stateVectors?: Array<{ noteId: string }> }>(init);
  const updates: Array<{ noteId: string; update: string }> = [];

  for (const item of payload?.stateVectors ?? []) {
    const target = new URL(`${SERVER_ENDPOINTS.crdt}/${encodeURIComponent(item.noteId)}`, wiring.origin);
    const response = await authorized(target.toString(), {}, wiring);
    if (!response.ok) return response;
    const body = (await response.json()) as {
      updates?: Array<{ noteId: string; update: string }>;
    };
    for (const envelope of body.updates ?? []) {
      updates.push({ noteId: envelope.noteId ?? item.noteId, update: envelope.update });
    }
  }
  return jsonResponse({ updates }, 200);
}

/**
 * Запрос с живым токеном. 401 значит «access протух»: обновляем и повторяем
 * ровно один раз — второй 401 честно уходит наверх и станет статусом синка.
 */
async function authorized(url: string, init: RequestInit, wiring: Wiring): Promise<Response> {
  const token = await wiring.session.accessToken();
  const deviceId = wiring.session.current()?.deviceId ?? '';
  const first = await wiring.raw(url, withAuth(init, token, deviceId));
  if (first.status !== 401) return first;

  const refreshed = await wiring.session.refresh();
  if (refreshed === null) return first;
  return wiring.raw(url, withAuth(init, refreshed.accessToken, refreshed.deviceId));
}

function withAuth(init: RequestInit, token: string | null, deviceId: string): RequestInit {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  // Ключи заголовков регистронезависимы, но дубликат в объекте — нет:
  // чистим оба написания, иначе поедет старый токен из значения ядра.
  delete headers['Authorization'];
  delete headers['authorization'];
  delete headers['X-Device-Id'];
  delete headers['x-device-id'];
  if (token !== null && token !== '') headers['authorization'] = `Bearer ${token}`;
  if (deviceId !== '') headers['x-device-id'] = deviceId;
  return { ...init, headers };
}

/**
 * Websocket мгновенного синка. Браузерный `WebSocket` заголовков не ставит,
 * поэтому токен идёт параметром — сервер его из журнала вычищает
 * (`routes/live.ts`).
 */
function liveUrl(url: string, origin: string, token: string): string {
  const target = new URL(url, origin.replace(/^http/, 'ws'));
  target.pathname = SERVER_ENDPOINTS.live;
  target.searchParams.delete('device');
  if (token !== '') target.searchParams.set('access_token', token);
  return target.toString();
}

function parseBody<T>(init: RequestInit): T | null {
  if (typeof init.body !== 'string') return null;
  try {
    return JSON.parse(init.body) as T;
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function unquote(value: string): string {
  return value.replace(/"/g, '');
}
