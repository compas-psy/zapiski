/**
 * Какая система под оболочкой.
 *
 * Оболочка одна на Windows и macOS — это решение учредителя от 19.08: один
 * код на все платформы, без флагов сборки, вырезающих функциональность.
 * Значит различия решаются В РАНТАЙМЕ, и спрашивать о них надо у того, кто
 * знает наверняка.
 *
 * Знает Rust: `platform::host_os` возвращает `cfg!(target_os = …)`, то есть
 * то, подо что бинарь СОБРАН. `navigator.userAgent` здесь не годится вовсе —
 * это строка вебвью, и она говорит о движке, а не о нашей сборке.
 */
import { invoke } from '@tauri-apps/api/core';

export type HostOs = 'windows' | 'macos' | 'linux';

/**
 * Спрашивается один раз за сеанс: система под ногами не меняется, а лишний
 * IPC-раунд на каждый вопрос о платформе — это задержка в отрисовке строки
 * заголовка.
 */
let cached: HostOs | null = null;

export async function hostOs(): Promise<HostOs> {
  if (cached !== null) return cached;
  const value = await invoke<string>('host_os').catch(() => 'windows');
  cached = value === 'macos' || value === 'linux' ? value : 'windows';
  return cached;
}

/** Уже известная система. `null` — ещё не спрашивали. */
export function knownHostOs(): HostOs | null {
  return cached;
}
