/**
 * Возврат после входа на Android (ТЗ §5.5).
 *
 * Дорога та же, что у share-target, и по той же причине: ссылка из письма
 * поднимает приложение с нуля, и адрес приходит раньше, чем фронтенд успевает
 * подписаться. Поэтому дорог две — событие для «приложение уже работает» и
 * очередь `auth_take()` для «приложение только что стартовало». Подписка
 * забирает очередь сразу, иначе первый же холодный возврат терялся бы.
 *
 * Адрес нигде не печатается: во фрагменте едет токен сессии. Разбирает его
 * общий код `@zapiski/app` — оболочка только транспорт (ARCHITECTURE §1).
 */
import { parseAuthCallback, type AuthCallback } from '@zapiski/app';

import { COMMANDS, EVENTS, call, on } from './ipc';

export async function takeInitialAuthCallback(): Promise<AuthCallback | null> {
  const urls = await call<string[]>(COMMANDS.authTake).catch(() => [] as string[]);
  for (const url of urls) {
    const callback = parseAuthCallback(url);
    if (callback !== null) return callback;
  }
  return null;
}

export function onAuthCallback(handler: (callback: AuthCallback) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;

  void on<string>(EVENTS.authCallback, (url) => {
    if (disposed) return;
    const callback = parseAuthCallback(url);
    if (callback === null) return;
    /* Та же очередь, что и у холодного старта: ссылка кладётся и туда, и в
       событие. Не опустошить — и тот же токен приедет при следующем запуске,
       где размен уже невозможен, а человек увидит «Ссылка больше не
       действует» сразу после успешного входа. */
    void call<string[]>(COMMANDS.authTake).catch(() => undefined);
    handler(callback);
  }).then((stop) => {
    if (disposed) stop();
    else unlisten = stop;
  });

  return () => {
    disposed = true;
    unlisten?.();
  };
}
