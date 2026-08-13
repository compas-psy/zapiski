/**
 * Единственное место, где оболочка знает имена команд и событий Rust-части.
 *
 * Всё, что ниже, — транспорт. Ни одного продуктового решения здесь нет и быть
 * не может (ARCHITECTURE §1).
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Команды Rust-части (`src-tauri/src/*.rs`). */
export const COMMANDS = {
  vaultOpen: 'vault_open',
  vaultRoot: 'vault_root',
  vaultDefaultRoot: 'vault_default_root',
  vaultWriteAtomic: 'vault_write_atomic',
  /* Папка пользователя через SAF (ТЗ §4.1 п. 1) — `src-tauri/src/saf.rs`. */
  safPick: 'saf_pick',
  safProbe: 'saf_probe',
  safPersisted: 'saf_persisted',
  safRelease: 'saf_release',
  safList: 'saf_list',
  safRead: 'saf_read',
  safWrite: 'saf_write',
  safStat: 'saf_stat',
  safMkdir: 'saf_mkdir',
  safOpen: 'saf_open',
  safRemove: 'saf_remove',
  safRename: 'saf_rename',
  secureFlag: 'secure_flag',
  hapticImpact: 'haptic_impact',
  biometricsAvailable: 'biometrics_available',
  biometricsEnroll: 'biometrics_enroll',
  biometricsUnlock: 'biometrics_unlock',
  biometricsRemove: 'biometrics_remove',
  pdfRender: 'pdf_render',
  saveFile: 'save_file',
  updaterCheck: 'updater_check',
  updaterInstall: 'updater_download_install',
  shareTake: 'share_take',
  authTake: 'auth_take',
  widgetsPublish: 'widgets_publish',
  widgetsTakeCommands: 'widgets_take_commands',
} as const;

/**
 * События, которые Rust шлёт фронтенду. Имена совпадают с константами в
 * `src-tauri/src/platform.rs` — при переименовании ломается ровно одно место
 * с каждой стороны.
 */
export const EVENTS = {
  /** ОС передала контент через share-target (BEHAVIOR §8). */
  share: 'zapiski://share',
  /** Быстрая заметка: плитка Quick Settings или виджет 1×1. */
  quickNote: 'zapiski://quick-note',
  /** Тап по чекбоксу в виджете «Закреплённая». */
  widgetCommand: 'zapiski://widget-command',
  /** Прогресс скачивания обновления, 0…1. */
  updateProgress: 'zapiski://update-progress',
  /** Возврат после входа: deep-link или App Link (ТЗ §5.5). */
  authCallback: 'zapiski://auth-callback',
} as const;

/** `invoke` без аргументов-заглушек и с человеческим типом. */
export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

/**
 * `invoke` с сырым телом: байты уходят как есть, а не как JSON-массив чисел.
 * Разница не косметическая — на вложении в несколько мегабайт JSON-путь
 * стоит секунд и утраивает пиковую память.
 */
export function callRaw<T>(
  command: string,
  body: Uint8Array,
  headers?: Record<string, string>,
): Promise<T> {
  // ArrayBufferView передаётся в IPC как InvokeBody::Raw.
  return invoke<T>(command, body, headers === undefined ? undefined : { headers });
}

export function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (message) => handler(message.payload));
}

/**
 * Заголовки допускают только ASCII, а пути в vault'е кириллические.
 * `encodeURIComponent` даёт ровно то, что понимает `percent_decode` в Rust.
 */
export function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value);
}
