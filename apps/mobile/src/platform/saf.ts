/**
 * `VaultStorage` поверх дерева `content://` (Storage Access Framework).
 *
 * ── Почему это вообще есть ──────────────────────────────────────────────────
 *
 * Умолчание не изменилось: каталог приложения с настоящими `.md` и атомарной
 * записью (`vault.ts`). Но ТЗ §4.1 п. 1 называет ключевым сценарий
 * «LocalFolder — в т.ч. папка, которую синкает сторонний клиент»: заметки в
 * папке приложения Яндекс.Диска синхронизируются бесплатно и без нашего
 * облака. На Android чужая папка доступна только через SAF, и раньше мы
 * закрывали этот сценарий целиком — ради формального соответствия §4.3.
 *
 * ── Что здесь честно, а что нет ─────────────────────────────────────────────
 *
 * Атомарной записи «tmp + rename поверх существующего» SAF не даёт. Мы делаем
 * максимум возможного (см. `Saf.kt`) и сообщаем фактический режим наверх:
 * `staged` — временный документ и замена в два шага, `direct` — запись прямо
 * в документ. Интерфейс показывает ровно то, что вернулось отсюда: обещать
 * §4.3 там, где его нет, нельзя.
 */
import type { VaultEntry, VaultPath, VaultStat, VaultStorage, VaultWriteMode } from '@zapiski/core';

import { COMMANDS, call, callRaw, encodeHeaderValue } from './ipc';

/** Заголовки сырого запроса записи — их разбирает `saf.rs`. */
const TREE_HEADER = 'x-saf-tree';
const PATH_HEADER = 'x-vault-path';

/** Дерево, выбранное пользователем, как его отдаёт Rust. */
export interface SafTree {
  uri: string;
  label: string;
  supportsRename: boolean;
}

/** Запись в дереве, как её отдаёт `Saf.list` (JSON от Java-стороны). */
interface SafEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
}

/**
 * Режим записи по возможностям провайдера. `atomic` здесь не бывает никогда:
 * поверх SAF его не существует, и притворяться нельзя.
 */
export function writeModeOf(tree: SafTree): VaultWriteMode {
  return tree.supportsRename ? 'staged' : 'direct';
}

function assertVaultPath(path: VaultPath): void {
  if (path.startsWith('/') || path.startsWith('\\')) {
    throw new Error(`путь должен быть относительным: ${path}`);
  }
  for (const segment of path.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new Error(`недопустимый сегмент пути: ${path}`);
    }
  }
}

function toEntry(dir: VaultPath, entry: SafEntry): VaultEntry {
  return {
    path: dir.length === 0 ? entry.name : `${dir}/${entry.name}`,
    name: entry.name,
    isDirectory: entry.isDirectory,
  };
}

/** Хранилище поверх выбранного дерева. */
export function createSafStorage(tree: string): VaultStorage {
  return {
    async read(path) {
      assertVaultPath(path);
      try {
        const bytes = await call<ArrayBuffer | number[]>(COMMANDS.safRead, { tree, path });
        return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes);
      } catch {
        // Контракт `VaultStorage.read`: «нет файла» — это `null`, а не
        // исключение. Провайдер не различает отсутствие и отказ, поэтому
        // любая неудача чтения выглядит как отсутствие — ядро в обоих
        // случаях поступает одинаково и ничего не теряет.
        return null;
      }
    },

    async write(path, data) {
      assertVaultPath(path);
      // Путь и дерево — в заголовках, байты — телом: вложение на несколько
      // мегабайт не должно превращаться в JSON-массив чисел по дороге.
      await callRaw<string>(COMMANDS.safWrite, data, {
        [TREE_HEADER]: encodeHeaderValue(tree),
        [PATH_HEADER]: encodeHeaderValue(path),
      });
    },

    async remove(path) {
      assertVaultPath(path);
      await call<void>(COMMANDS.safRemove, { tree, path });
    },

    async rename(from, to) {
      assertVaultPath(from);
      assertVaultPath(to);
      await call<void>(COMMANDS.safRename, { tree, from, to });
    },

    async list(dir) {
      if (dir.length > 0) assertVaultPath(dir);
      const raw = await call<string>(COMMANDS.safList, { tree, path: dir });
      const entries = JSON.parse(raw) as SafEntry[];
      return entries.map((entry) => toEntry(dir, entry));
    },

    async stat(path) {
      assertVaultPath(path);
      const raw = await call<string | null>(COMMANDS.safStat, { tree, path }).catch(() => null);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as { size: number; mtime: number };
      const result: VaultStat = { size: parsed.size, mtime: parsed.mtime };
      return result;
    },

    async mkdir(dir) {
      assertVaultPath(dir);
      await call<void>(COMMANDS.safMkdir, { tree, path: dir });
    },
  };
}

/** Системный выбор папки. `null` — пользователь отменил выбор. */
export function pickSafTree(): Promise<SafTree | null> {
  return call<SafTree | null>(COMMANDS.safPick);
}

/**
 * Проверить дерево, выбранное в прошлый запуск. `null` — доступа больше нет:
 * разрешение отозвали в настройках Android либо папку удалили. Тогда
 * приложение возвращается в каталог приложения, а не пишет в пустоту.
 */
export function probeSafTree(tree: string): Promise<SafTree | null> {
  return call<SafTree | null>(COMMANDS.safProbe, { tree });
}

/**
 * Открыть вложение системным приложением (замечание 16).
 *
 * `false` — открывать нечем: на устройстве нет приложения для такого типа
 * файла, либо файла больше нет. Это ответ, а не сбой, поэтому исключения тут
 * не бросаются.
 */
export function openSafFile(tree: string, path: string): Promise<boolean> {
  return call<boolean>(COMMANDS.safOpen, { tree, path });
}
