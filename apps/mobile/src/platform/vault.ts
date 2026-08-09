/**
 * `VaultStorage` поверх нативной файловой системы Android.
 *
 * Чтение, обход каталога, `stat`, `mkdir`, `remove`, `rename` делает
 * `@tauri-apps/plugin-fs`: это обычные вызовы, и своя команда для них ничего
 * бы не добавила.
 *
 * **Запись — исключение.** ТЗ §4.3 требует атомарности: «прерывание синка на
 * любом байте не портит файл». Из JS это недостижимо — между `writeFile(tmp)`
 * и `rename(tmp, dst)` проходит два IPC-раунда, и убийство процесса (а Android
 * убивает фоновые процессы регулярно и без предупреждения) оставит временный
 * файл и устаревший оригинал. Поэтому `tmp → fsync → rename` выполняется
 * целиком внутри одной Rust-команды: `vault_write_atomic`.
 */
import {
  mkdir,
  readDir,
  readFile,
  remove,
  rename,
  stat,
  type DirEntry,
} from '@tauri-apps/plugin-fs';
import type { VaultEntry, VaultPath, VaultStat, VaultStorage } from '@zapiski/core';

import { COMMANDS, call, callRaw, encodeHeaderValue } from './ipc';

/** Заголовок, которым путь внутри vault'а едет к `vault_write_atomic`. */
const PATH_HEADER = 'x-vault-path';

/**
 * Проверка пути на стороне JS. Rust проверяет ещё раз и по-настоящему — здесь
 * это ранняя диагностика: ошибка видна на вызывающей стороне, а не в виде
 * отказа IPC.
 */
function assertVaultPath(path: VaultPath): void {
  if (path.length === 0) throw new Error('пустой путь внутри vault\'а');
  if (path.startsWith('/') || path.startsWith('\\')) {
    throw new Error(`путь должен быть относительным: ${path}`);
  }
  for (const segment of path.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new Error(`недопустимый сегмент пути: ${path}`);
    }
  }
}

function toEntry(dir: VaultPath, entry: DirEntry): VaultEntry {
  return {
    path: dir.length === 0 ? entry.name : `${dir}/${entry.name}`,
    name: entry.name,
    isDirectory: entry.isDirectory,
  };
}

/**
 * Хранилище, привязанное к абсолютному пути корня.
 *
 * Корень открывается командой `vault_open`, которая выдаёт каталог в
 * рантайм-скоуп плагина fs. До этого приложение не имеет доступа ни к одному
 * файлу пользователя.
 */
export function createVaultStorage(root: string): VaultStorage {
  const absolute = (path: VaultPath): string => {
    assertVaultPath(path);
    return `${root}/${path}`;
  };

  return {
    async read(path) {
      try {
        return await readFile(absolute(path));
      } catch {
        // Контракт: «нет файла» — это `null`, а не исключение. Отличить
        // отсутствие от других ошибок ФС плагин не даёт, поэтому любая
        // неудача чтения выглядит как отсутствие; ядро в обоих случаях
        // поступает одинаково — считает заметку отсутствующей и не теряет
        // ничего из уже прочитанного.
        return null;
      }
    },

    async write(path, data) {
      assertVaultPath(path);
      // Путь — в заголовке, байты — телом. Кириллица percent-encoded:
      // заголовки HTTP допускают только ASCII.
      await callRaw<void>(COMMANDS.vaultWriteAtomic, data, {
        [PATH_HEADER]: encodeHeaderValue(path),
      });
    },

    async remove(path) {
      await remove(absolute(path), { recursive: true });
    },

    async rename(from, to) {
      await rename(absolute(from), absolute(to));
    },

    async list(dir) {
      const target = dir.length === 0 ? root : absolute(dir);
      const entries = await readDir(target);
      return entries.map((entry) => toEntry(dir, entry));
    },

    async stat(path) {
      try {
        const info = await stat(absolute(path));
        const result: VaultStat = {
          size: info.size,
          mtime: info.mtime === null ? 0 : info.mtime.getTime(),
        };
        return result;
      } catch {
        return null;
      }
    },

    async mkdir(dir) {
      await mkdir(absolute(dir), { recursive: true });
    },
  };
}

/**
 * Открыть каталог как vault и получить хранилище.
 *
 * Возвращает `null`, если каталог открыть не удалось: у порта нет способа
 * сообщить причину, а ронять приложение из-за недоступной папки нельзя —
 * BEHAVIOR §11 предписывает показать «Папка недоступна…», а это решение
 * принимает `packages/app`, не оболочка.
 */
export async function openVault(path: string): Promise<VaultStorage | null> {
  try {
    const opened = await call<string>(COMMANDS.vaultOpen, { path });
    return createVaultStorage(opened);
  } catch {
    return null;
  }
}

/** Абсолютный путь уже открытого vault'а. `null` — ещё не открывали. */
export function currentVaultRoot(): Promise<string | null> {
  return call<string | null>(COMMANDS.vaultRoot);
}

/**
 * Путь vault'а по умолчанию для Android.
 *
 * Каталог приложения во внешней памяти: настоящие файлы `.md` на настоящей
 * ФС, атомарная запись `tmp → fsync → rename` (ТЗ §4.3), «file over app»
 * соблюдён полностью. Это умолчание и надёжный путь.
 *
 * Произвольная папка тоже доступна — через системный выбор (SAF, см.
 * `saf.ts`), но её свойства другие, и пользователь узнаёт об этом до выбора.
 * Здесь их нет и не будет: смешивать надёжный путь с оговорками нельзя.
 */
export function defaultVaultRoot(): Promise<string> {
  return call<string>(COMMANDS.vaultDefaultRoot);
}
