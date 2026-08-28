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
  /* Системное «Поделиться» — `platform.rs::share_text`. */
  shareText: 'share_text',
  /* Байты вложения во временный файл — `files.rs::share_stage`. */
  shareStage: 'share_stage',
  /* Цвет значков системных панелей — `platform.rs::system_bar_icons`. */
  systemBarIcons: 'system_bar_icons',
  hapticImpact: 'haptic_impact',
  biometricsAvailable: 'biometrics_available',
  biometricsEnroll: 'biometrics_enroll',
  biometricsUnlock: 'biometrics_unlock',
  biometricsRemove: 'biometrics_remove',
  pdfRender: 'pdf_render',
  saveFile: 'save_file',
  updaterCheck: 'updater_check',
  shareTake: 'share_take',
  authTake: 'auth_take',
  /* Ассоциация `.md` — `platform.rs::open_file_take`/`read_opened_file`. */
  openFileTake: 'open_file_take',
  readOpenedFile: 'read_opened_file',
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
  /** Возврат после входа: deep-link или App Link (ТЗ §5.5). */
  authCallback: 'zapiski://auth-callback',
  /** ОС попросила открыть `.md` — ассоциация файлов (ТЗ §5.4). */
  openFile: 'zapiski://open-file',
} as const;

/** `invoke` без аргументов-заглушек и с человеческим типом. */
export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

/**
 * Размер куска при кодировании в base64.
 *
 * `String.fromCharCode(...bytes)` разворачивает массив в аргументы вызова, а
 * их число ограничено размером стека: на вложении в мегабайты это не «медленно»,
 * а `RangeError: Maximum call stack size exceeded`. 8192 — заведомо безопасно.
 */
const BASE64_CHUNK = 8192;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + BASE64_CHUNK));
  }
  return btoa(binary);
}

/**
 * `invoke` с телом-байтами: запись заметки, запись в папку SAF, экспорт файла.
 *
 * ── Почему base64, а не `Uint8Array`, как в документации ───────────────────
 *
 * Документация Tauri («Accessing Raw Request») говорит: пошлите `Uint8Array`,
 * примите `InvokeBody::Raw`. Здесь так и было — и на Android не работало
 * НИКОГДА. В транспорте Tauri (`tauri/scripts/ipc-protocol.js`) стоит
 * `const canUseCustomProtocol = osName !== 'android'`: на Android запрос
 * уходит не POST-ом со своим телом, а через `window.ipc.postMessage`, где всё
 * сообщение проходит через `JSON.stringify`. Сырого тела там не бывает в
 * принципе, и `Uint8Array` превращается в массив чисел.
 *
 * Цена была полной: ни одна заметка не могла сохраниться. Приложение
 * отвечало «тело запроса должно быть бинарным» на свои же данные.
 *
 * Раз тело всё равно станет JSON-ом, выбираем то представление, которое
 * дешевле: массив чисел даёт ~4 байта текста на байт данных и вектор из
 * миллионов значений при разборе, base64 — 1.33 байта и одну строку. На
 * вложении в 3 МБ это разница между десятками мегабайт кучи и четырьмя.
 *
 * Rust принимает оба вида (`src-tauri/src/body.rs`), так что путь своего
 * протокола на других платформах ничего не теряет.
 */
export function callRaw<T>(
  command: string,
  body: Uint8Array,
  headers?: Record<string, string>,
): Promise<T> {
  /* Имя поля — то же, что читает `src-tauri/src/body.rs`. Объект, а не голая
     строка: `InvokeArgs` строку не принимает. */
  return invoke<T>(command, { data: toBase64(body) }, headers === undefined ? undefined : { headers });
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
