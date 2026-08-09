/**
 * Возврат после входа на Windows.
 *
 * Транспорт и ничего больше (ARCHITECTURE §1): Rust отдаёт сюда адрес
 * `zapiski://…`, разбирает его общий код `@zapiski/app`, а решает, что с ним
 * делать, — приложение.
 *
 * Две дороги, потому что ссылка может прийти раньше подписки:
 *   • `auth_take` — очередь холодного старта (браузер запустил приложение);
 *   • событие — приложение уже работало, ссылку принёс второй процесс.
 *
 * Адрес нигде не печатается: во фрагменте едет токен сессии.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { parseAuthCallback, type AuthCallback } from '@zapiski/app';

/** Имена совпадают с `src-tauri/src/auth.rs`. */
const COMMAND_TAKE = 'auth_take';
const EVENT_AUTH_CALLBACK = 'zapiski://auth-callback';

export async function takeInitialAuthCallback(): Promise<AuthCallback | null> {
  const urls = await invoke<string[]>(COMMAND_TAKE).catch(() => [] as string[]);
  for (const url of urls) {
    const callback = parseAuthCallback(url);
    if (callback !== null) return callback;
  }
  return null;
}

export function onAuthCallback(handler: (callback: AuthCallback) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;

  void listen<string>(EVENT_AUTH_CALLBACK, (event) => {
    if (disposed) return;
    const callback = parseAuthCallback(event.payload);
    if (callback !== null) handler(callback);
  }).then((stop) => {
    if (disposed) stop();
    else unlisten = stop;
  });

  return () => {
    disposed = true;
    unlisten?.();
  };
}
