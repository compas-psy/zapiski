/**
 * Возврат после входа в вебе.
 *
 * Механизм платформы простой: браузер приходит на наш же origin с токеном
 * в адресе — либо `?token=` из письма, либо `#access_token=…` из редиректа
 * сервера (`AUTH_SUCCESS_REDIRECT`, см. `server/src/routes/auth.ts`).
 *
 * Здесь делается ровно транспорт, без единой строки продуктовой логики
 * (ARCHITECTURE §1):
 *
 *  1. адрес разбирается общим кодом `@zapiski/app` — трактовка одна на все
 *     три оболочки;
 *  2. адресная строка чистится СРАЗУ и до первого кадра: `history.replaceState`
 *     стирает токен и из строки, и из истории, и из `Referer` следующего
 *     перехода. Токен живёт в памяти ровно до того, как приложение его заберёт;
 *  3. служебный путь `/auth/…` заменяется корнем: перезагрузка страницы после
 *     входа не должна упираться в маршрут, которого нет в статике.
 */
import { parseAuthCallback, stripAuthParams, type AuthCallback } from '@zapiski/app';

/** Путь, на который сервер уводит браузер после успешного обмена. */
const AUTH_PATH = '/auth';

type Handler = (callback: AuthCallback) => void;

const handlers = new Set<Handler>();
/** Возврат, пойманный до монтирования React. Забирается ровно один раз. */
let pending: AuthCallback | null = null;

/**
 * Снять возврат с текущего адреса и вычистить адресную строку.
 * Возвращает `null`, если ко входу адрес отношения не имеет.
 */
function capture(): AuthCallback | null {
  if (typeof window === 'undefined') return null;
  const href = window.location.href;
  const callback = parseAuthCallback(href);
  if (callback === null) return null;

  const cleaned = new URL(stripAuthParams(href));
  if (cleaned.pathname === AUTH_PATH || cleaned.pathname.startsWith(`${AUTH_PATH}/`)) {
    cleaned.pathname = '/';
  }
  try {
    window.history.replaceState(window.history.state, '', cleaned.toString());
  } catch {
    /* Приватный режим или sandbox: адрес не переписался, но токен уже снят. */
  }
  return callback;
}

/**
 * Ловушка ставится на импорте модуля — раньше React и раньше первого кадра.
 * Токен не успевает попасть ни в один снимок адресной строки.
 */
export function armAuthCapture(): void {
  pending = capture() ?? pending;

  if (typeof window === 'undefined') return;
  const recheck = (): void => {
    const callback = capture();
    if (callback === null) return;
    if (handlers.size === 0) pending = callback;
    for (const handler of handlers) handler(callback);
  };
  /* Возврат в уже открытую вкладку: переход по ссылке из письма в том же
     табе меняет фрагмент, а не перезагружает страницу. */
  window.addEventListener('hashchange', recheck);
  window.addEventListener('popstate', recheck);
}

export async function takeInitialAuthCallback(): Promise<AuthCallback | null> {
  const callback = pending;
  pending = null;
  return callback;
}

export function onAuthCallback(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
