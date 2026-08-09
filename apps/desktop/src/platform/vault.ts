/**
 * Порт `VaultStorage` поверх нативной файловой системы Windows.
 *
 * Чтение, обход, `stat`, `mkdir`, `remove` и `rename` идут через
 * `@tauri-apps/plugin-fs` — это обычные операции, и своя команда для них
 * ничего бы не добавила.
 *
 * Запись — исключение. Контракт ядра требует, чтобы `write` был **атомарным**
 * (`packages/core/src/contract.ts`, ТЗ §4.3). Сделать это в JS нельзя:
 * «записать во временный файл» и «переименовать» — два отдельных IPC-вызова,
 * и падение процесса между ними оставит на диске мусор и устаревший оригинал.
 * Поэтому вся последовательность tmp → fsync → rename выполняется одной
 * командой Rust (`vault_write_atomic`, см. `src-tauri/src/vault.rs`), а
 * `fs:allow-write-file` оболочке намеренно не выдан — записать в обход
 * атомарной команды нечем.
 */
import { invoke } from '@tauri-apps/api/core';
import {
  exists,
  mkdir,
  readDir,
  readFile,
  remove,
  rename,
  stat,
} from '@tauri-apps/plugin-fs';
import type { VaultEntry, VaultPath, VaultStat, VaultStorage } from '@zapiski/core';

/** Заголовок, которым путь едет к `vault_write_atomic` (там же он и разбирается). */
const PATH_HEADER = 'x-vault-path';

/**
 * Открыть каталог как vault. Rust канонизирует путь и выдаёт каталог в
 * рантайм-скоупы `fs` и `asset` — до этого момента приложение не имеет
 * доступа ни к одному файлу пользователя.
 */
export async function openVaultAt(path: string): Promise<VaultStorage> {
  const root = await invoke<string>('vault_open', { path });
  return new NativeVaultStorage(root);
}

/** Корень уже открытого vault'а, если приложение его помнит. */
export async function currentVaultRoot(): Promise<string | null> {
  return (await invoke<string | null>('vault_root')) ?? null;
}

class NativeVaultStorage implements VaultStorage {
  /**
   * Разделитель берётся из самого корня, а не из `navigator.platform`.
   * Смешивать `C:\vault` с `/` нельзя: скоупы plugin-fs сверяют путь
   * пошагово, и путь со смешанными разделителями может не совпасть с
   * выданным каталогом — доступ отвалится там, где всё разрешено.
   */
  private readonly separator: string;

  constructor(private readonly root: string) {
    this.separator = root.includes('\\') ? '\\' : '/';
  }

  async read(path: VaultPath): Promise<Uint8Array | null> {
    const absolute = this.absolute(path);
    try {
      return await readFile(absolute);
    } catch (error) {
      /* Файла нет — обычный исход: индекс мог отстать от диска. Всё
         остальное (нет прав, диск отвалился) обязано долететь до вызывающего,
         иначе потеря заметки выглядит как пустая заметка. */
      if (await exists(absolute)) throw error;
      return null;
    }
  }

  async write(path: VaultPath, data: Uint8Array): Promise<void> {
    /* Сырые байты, а не JSON-массив чисел: вложение на несколько мегабайт
       иначе стоило бы дороже самой записи. Путь едет заголовком —
       percent-encoded, потому что заголовки HTTP допускают только ASCII, а
       имена заметок кириллические. */
    await invoke('vault_write_atomic', data, {
      headers: { [PATH_HEADER]: encodeURIComponent(path) },
    });
  }

  async remove(path: VaultPath): Promise<void> {
    const absolute = this.absolute(path);
    try {
      await remove(absolute, { recursive: true });
    } catch (error) {
      /* Удаление идемпотентно: файла уже нет — цель достигнута. */
      if (await exists(absolute)) throw error;
    }
  }

  async rename(from: VaultPath, to: VaultPath): Promise<void> {
    /* Переименование внутри vault'а часто означает и переезд в другую папку
       («Идея.md» → «Проекты/Идея.md»), а её может ещё не быть. */
    const parent = parentOf(to);
    if (parent !== null) await this.mkdir(parent);
    await rename(this.absolute(from), this.absolute(to));
  }

  async list(dir: VaultPath): Promise<VaultEntry[]> {
    const absolute = dir === '' ? this.root : this.absolute(dir);
    let entries;
    try {
      entries = await readDir(absolute);
    } catch (error) {
      /* Каталога нет — он пуст. Так ведёт себя свежий vault, в котором ещё
         не создан ни `.zapiski/`, ни одна папка. */
      if (await exists(absolute)) throw error;
      return [];
    }
    return entries.map((entry) => ({
      path: dir === '' ? entry.name : `${dir}/${entry.name}`,
      name: entry.name,
      isDirectory: entry.isDirectory,
    }));
  }

  async stat(path: VaultPath): Promise<VaultStat | null> {
    const absolute = this.absolute(path);
    try {
      const info = await stat(absolute);
      return { size: info.size, mtime: info.mtime?.getTime() ?? 0 };
    } catch (error) {
      if (await exists(absolute)) throw error;
      return null;
    }
  }

  async mkdir(dir: VaultPath): Promise<void> {
    const absolute = this.absolute(dir);
    if (await exists(absolute)) return;
    await mkdir(absolute, { recursive: true });
  }

  /**
   * `VaultPath` → абсолютный путь. Проверка на выход за пределы vault'а
   * повторяет проверку в Rust (`resolve_in_root`): здесь она ловит ошибку
   * раньше и с понятным текстом, там — не пускает вообще ничего.
   */
  private absolute(path: VaultPath): string {
    if (path === '') throw new Error('пустой путь внутри vault\u2019а');
    if (path.startsWith('/') || path.startsWith('\\')) {
      throw new Error(`путь должен быть относительным: ${path}`);
    }
    const segments = path.split('/');
    for (const segment of segments) {
      if (segment === '' || segment === '.' || segment === '..') {
        throw new Error(`недопустимый сегмент пути: ${path}`);
      }
      if (segment.includes('\\') || segment.includes(':')) {
        throw new Error(`недопустимый сегмент пути: ${segment}`);
      }
    }
    return [this.root, ...segments].join(this.separator);
  }
}

/** `Проекты/Идея.md` → `Проекты`; для файла в корне — `null`. */
function parentOf(path: VaultPath): VaultPath | null {
  const index = path.lastIndexOf('/');
  return index <= 0 ? null : path.slice(0, index);
}
