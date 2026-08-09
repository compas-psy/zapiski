/**
 * Разбор возврата после входа — общий для всех трёх оболочек.
 *
 * Механизм доставки у платформ разный (адресная строка в вебе, `zapiski://`
 * в Tauri, intent на Android), а формат один: сервер кладёт полезную нагрузку
 * либо в query, либо во фрагмент. Поэтому разбор живёт здесь, в `packages/app`,
 * и оболочкам остаётся только передать сюда адрес (ARCHITECTURE §1).
 *
 * Что бывает в адресе (см. `server/src/routes/auth.ts`):
 *
 *  • `?token=…` — одноразовый токен из письма. Сервер ждёт к нему `device_id`,
 *    поэтому обменять его может только приложение;
 *  • `#access_token=…&refresh_token=…&expires_in=…` — сервер уже обменял токен
 *    и отдал сессию через `AUTH_SUCCESS_REDIRECT`. Фрагмент выбран не случайно:
 *    он не уходит на сервер и не оседает в чужих журналах;
 *  • `?error=…` — отказ. Код машинный, текст берётся из реестра BEHAVIOR §11.
 *
 * Фрагмент разбирается наравне с query, потому что оба варианта реальны:
 * веб получает фрагмент, а Android-интент — обычные query-параметры.
 */
import type { AuthCallback } from '../contract.js';

/**
 * Всё, что после разбора обязано исчезнуть из адресной строки.
 *
 * `code` и `state` тоже здесь: OAuth-возврат Яндекса может пройти через наш
 * origin, и оставлять их в истории браузера незачем.
 */
export const AUTH_CALLBACK_PARAMS = [
  'token',
  'access_token',
  'refresh_token',
  'expires_in',
  'error',
  'error_description',
  'code',
  'state',
] as const;

/** Параметры, само присутствие которых означает «это возврат из входа». */
const SIGNIFICANT = ['token', 'access_token', 'refresh_token', 'error'] as const;

/**
 * Пары «ключ-значение» из query и из фрагмента.
 *
 * Фрагмент бывает и хвостом маршрута (`#/settings?token=…`), поэтому берём
 * часть после первого `?`, если он есть, иначе весь фрагмент.
 */
function paramsOf(url: URL): URLSearchParams {
  const merged = new URLSearchParams(url.search);
  for (const [key, value] of new URLSearchParams(splitHash(url.hash).query)) {
    if (!merged.has(key)) merged.append(key, value);
  }
  return merged;
}

/**
 * Фрагмент — это либо параметры (`#access_token=…`), либо маршрут приложения
 * (`#/settings`), либо и то и другое (`#/settings?token=…`). Разделять их
 * приходится по форме: маршрут начинается со слэша, у параметров есть `=`.
 * Иначе `#/settings` разбирался бы как параметр с именем `/settings` — и
 * очистка адреса ломала бы маршрут.
 */
function splitHash(rawHash: string): { head: string; query: string } {
  const hash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
  if (hash.length === 0) return { head: '', query: '' };
  const question = hash.indexOf('?');
  if (question !== -1) return { head: hash.slice(0, question), query: hash.slice(question + 1) };
  if (hash.startsWith('/') || !hash.includes('=')) return { head: hash, query: '' };
  return { head: '', query: hash };
}

/** Разбор адреса. `null` — обычный адрес, ко входу отношения не имеет. */
export function parseAuthCallback(href: string): AuthCallback | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const params = paramsOf(url);
  if (!SIGNIFICANT.some((key) => nonEmpty(params.get(key)))) return null;

  const callback: AuthCallback = {};

  const error = params.get('error');
  if (nonEmpty(error)) callback.error = error;

  const magicToken = params.get('token');
  if (nonEmpty(magicToken)) callback.magicToken = magicToken;

  const accessToken = params.get('access_token');
  if (nonEmpty(accessToken)) callback.accessToken = accessToken;

  const refreshToken = params.get('refresh_token');
  if (nonEmpty(refreshToken)) callback.refreshToken = refreshToken;

  const expiresIn = Number(params.get('expires_in'));
  if (Number.isFinite(expiresIn) && expiresIn > 0) callback.expiresIn = expiresIn;

  return callback;
}

/** Есть ли в адресе что-то от входа — без разбора самого содержимого. */
export function hasAuthCallback(href: string): boolean {
  return parseAuthCallback(href) !== null;
}

/**
 * Тот же адрес без единого следа токена: и в query, и во фрагменте.
 *
 * Нужен вебу для `history.replaceState` — токен не должен остаться ни в
 * адресной строке, ни в истории браузера, ни в `Referer` следующего перехода.
 * Пустые `?` и `#` тоже убираются: адрес обязан выглядеть так, будто по ссылке
 * никто не приходил.
 */
export function stripAuthParams(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }

  for (const key of AUTH_CALLBACK_PARAMS) url.searchParams.delete(key);

  const { head, query } = splitHash(url.hash);
  if (query.length > 0) {
    const tail = new URLSearchParams(query);
    for (const key of AUTH_CALLBACK_PARAMS) tail.delete(key);
    const rest = tail.toString();
    // Фрагмент без параметров — это либо маршрут, либо ничего.
    url.hash = rest.length > 0 ? `${head}?${rest}` : head;
  }

  const text = url.toString();
  return text.replace(/\?(?=#|$)/, '').replace(/#$/, '');
}

function nonEmpty(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Адресная строка
// ─────────────────────────────────────────────────────────────────────────────

/** То немногое от `window`, что нужно для разбора возврата. */
export interface AddressBar {
  location: { href: string };
  history: {
    state: unknown;
    replaceState(state: unknown, title: string, url: string): void;
  };
}

export interface AddressBarOptions {
  /**
   * Служебный путь возврата. После разбора адрес заменяется корнем: перезагрузка
   * страницы после входа не должна упираться в маршрут, которого нет в статике.
   */
  authPath?: string;
}

/**
 * Снять возврат с адресной строки и вычистить её.
 *
 * Живёт в `packages/app`, а не в веб-оболочке, ровно по правилу
 * ARCHITECTURE §1: трактовка адреса — общее поведение, а не платформенная
 * особенность. Оболочке остаётся один вызов.
 *
 * `replaceState`, а не `pushState`: токен не должен остаться ни в адресной
 * строке, ни в истории браузера, ни в `Referer` следующего перехода.
 */
export function takeAuthFromAddressBar(
  win: AddressBar,
  options: AddressBarOptions = {},
): AuthCallback | null {
  const authPath = options.authPath ?? '/auth';
  const href = win.location.href;
  const callback = parseAuthCallback(href);
  if (callback === null) return null;

  let cleaned = stripAuthParams(href);
  try {
    const url = new URL(cleaned);
    if (url.pathname === authPath || url.pathname.startsWith(`${authPath}/`)) {
      url.pathname = '/';
      cleaned = url.toString();
    }
  } catch {
    /* Не URL — чистить нечего, но токен уже снят. */
  }

  try {
    win.history.replaceState(win.history.state, '', cleaned);
  } catch {
    /* Приватный режим или sandbox: адрес не переписался, токен уже снят. */
  }
  return callback;
}
