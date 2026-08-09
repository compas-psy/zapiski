/**
 * `VaultStorage` для веба (ARCHITECTURE §2).
 *
 * Одна реализация поверх `FileSystemDirectoryHandle` покрывает оба случая:
 *  • File System Access API — папка, которую пользователь выбрал сам; заметки
 *    лежат обычными `.md` в его файловой системе (инвариант «file over app»);
 *  • OPFS (`navigator.storage.getDirectory()`) — фолбэк там, где показать
 *    системный диалог нельзя (Firefox, Safari, iOS): те же файлы, но в
 *    приватном хранилище источника.
 *
 * Ручка выбранной папки переживает перезапуск: она лежит в IndexedDB, и при
 * старте `restoreVault()` спрашивает разрешение заново — без диалога выбора.
 */
import type { VaultEntry, VaultStat, VaultStorage } from '@zapiski/core';

/** Имя базы и хранилища для ручки папки. */
const DB_NAME = 'zapiski';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'vault';

/* ── Типы FSA, которых ещё нет в стандартных lib.dom ──────────────────────── */

interface PermissionCapableHandle {
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface MovableFileHandle {
  move?(parent: FileSystemDirectoryHandle, name: string): Promise<void>;
}

type PickerWindow = Window & {
  showDirectoryPicker?(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
};

/* ── Хранилище ────────────────────────────────────────────────────────────── */

export class DirectoryVaultStorage implements VaultStorage {
  constructor(
    private readonly root: FileSystemDirectoryHandle,
    /** Что показать в настройках как «папка с заметками». */
    readonly label: string,
  ) {}

  async read(path: string): Promise<Uint8Array | null> {
    const handle = await this.fileHandle(path, false);
    if (!handle) return null;
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  /**
   * Запись атомарная: сначала во временный файл, затем переименование.
   * `move()` есть не везде — там, где его нет, честно копируем и удаляем tmp:
   * читатель в этот момент видит либо старую версию, либо новую целиком.
   */
  async write(path: string, data: Uint8Array): Promise<void> {
    const directory = await this.directoryOf(path, true);
    const name = baseName(path);
    const temporary = `${name}.${Date.now().toString(36)}.tmp`;

    const tmpHandle = await directory.getFileHandle(temporary, { create: true });
    const writable = await tmpHandle.createWritable();
    /* Копия буфера: у Uint8Array из ядра может быть чужой ArrayBuffer. */
    await writable.write(data.slice().buffer as ArrayBuffer);
    await writable.close();

    const movable = tmpHandle as FileSystemFileHandle & MovableFileHandle;
    if (typeof movable.move === 'function') {
      await movable.move(directory, name);
      return;
    }
    const target = await directory.getFileHandle(name, { create: true });
    const copy = await target.createWritable();
    await copy.write(data.slice().buffer as ArrayBuffer);
    await copy.close();
    await directory.removeEntry(temporary).catch(() => undefined);
  }

  async remove(path: string): Promise<void> {
    const directory = await this.directoryOf(path, false);
    if (!directory) return;
    await directory.removeEntry(baseName(path), { recursive: true }).catch(() => undefined);
  }

  async rename(from: string, to: string): Promise<void> {
    const source = await this.fileHandle(from, false);
    if (!source) return;
    const targetDirectory = await this.directoryOf(to, true);
    const movable = source as FileSystemFileHandle & MovableFileHandle;
    if (typeof movable.move === 'function') {
      await movable.move(targetDirectory, baseName(to));
      return;
    }
    const file = await source.getFile();
    await this.write(to, new Uint8Array(await file.arrayBuffer()));
    await this.remove(from);
  }

  async list(dir: string): Promise<VaultEntry[]> {
    const directory = await this.directoryOf(`${dir}/x`, false);
    if (!directory) return [];
    const entries: VaultEntry[] = [];
    for await (const [name, handle] of iterate(directory)) {
      entries.push({
        path: dir === '' ? name : `${dir}/${name}`,
        name,
        isDirectory: handle.kind === 'directory',
      });
    }
    return entries;
  }

  async stat(path: string): Promise<VaultStat | null> {
    const handle = await this.fileHandle(path, false);
    if (!handle) {
      const directory = await this.directoryOf(`${path}/x`, false);
      return directory ? { size: 0, mtime: 0 } : null;
    }
    const file = await handle.getFile();
    return { size: file.size, mtime: file.lastModified };
  }

  async mkdir(dir: string): Promise<void> {
    if (dir === '') return;
    await this.directoryOf(`${dir}/x`, true);
  }

  /** Каталог, в котором лежит `path`. `create` — создавать недостающие звенья. */
  private async directoryOf(path: string, create: true): Promise<FileSystemDirectoryHandle>;
  private async directoryOf(path: string, create: false): Promise<FileSystemDirectoryHandle | null>;
  private async directoryOf(
    path: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> {
    const parts = path.split('/').filter((part) => part !== '');
    parts.pop();
    let current = this.root;
    for (const part of parts) {
      try {
        current = await current.getDirectoryHandle(part, { create });
      } catch {
        if (create) throw new Error(`Не удалось создать папку: ${part}`);
        return null;
      }
    }
    return current;
  }

  private async fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const directory = create
      ? await this.directoryOf(path, true)
      : await this.directoryOf(path, false);
    if (!directory) return null;
    try {
      return await directory.getFileHandle(baseName(path), { create });
    } catch {
      return null;
    }
  }
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/** `entries()` есть не во всех реализациях — обходим через async-итератор. */
function iterate(
  directory: FileSystemDirectoryHandle,
): AsyncIterableIterator<[string, FileSystemHandle]> {
  const source = directory as FileSystemDirectoryHandle & {
    entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    [Symbol.asyncIterator]?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
  };
  if (typeof source.entries === 'function') return source.entries();
  return (source[Symbol.asyncIterator] as () => AsyncIterableIterator<[string, FileSystemHandle]>)();
}

/* ── Выбор папки и восстановление ─────────────────────────────────────────── */

export function canPickDirectory(): boolean {
  return typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

/**
 * Системный диалог выбора папки.
 *
 * Два исхода различаются, и это важно. **Отмена человеком** — не ошибка:
 * возвращаем `null`, приложение остаётся в OPFS и пишет сразу (local-first).
 * **Отказ платформы** — ошибка, и о ней нужно сказать словами: раньше оба
 * случая сливались в один `null`, поэтому на Samsung Internet выбор папки
 * молча возвращал человека на тот же экран, и сказать было нечего.
 *
 * Перед тем как отдать папку приложению, она проверяется на запись. Разрешение
 * на выбор и разрешение на запись — разные вещи: диалог может закончиться
 * успешно, а первая же попытка создать файл упасть. Узнать об этом на месте
 * дешевле, чем посреди первой заметки.
 */
export async function pickVaultDirectory(): Promise<VaultStorage | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (typeof picker !== 'function') return openOpfsVault();

  let handle: FileSystemDirectoryHandle;
  try {
    handle = await picker({ mode: 'readwrite' });
  } catch (error) {
    // `AbortError` — человек закрыл диалог. Это его право, а не сбой.
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }

  await assertWritable(handle);
  // Запоминаем только то, что доказало работоспособность: битую ручку незачем
  // тащить в следующий запуск, она снова упадёт при восстановлении.
  await rememberHandle(handle).catch(() => undefined);
  return new DirectoryVaultStorage(handle, handle.name);
}

/** Имя пробного файла. Точка в начале — чтобы не мозолил глаза, если останется. */
const PROBE = '.zapiski-write-test';

/**
 * Проверка «в эту папку правда можно писать».
 *
 * Пробуем ровно то, что делает vault на первой же секунде: создать файл,
 * записать байт, прочитать обратно и убрать за собой. Провайдеры Android
 * (а на телефоне выбор папки идёт через них) умеют отдать каталог, в который
 * записать нельзя, и это выясняется только попыткой.
 */
async function assertWritable(handle: FileSystemDirectoryHandle): Promise<void> {
  const file = await handle.getFileHandle(PROBE, { create: true });
  try {
    const writable = await (file as FileSystemFileHandle).createWritable();
    await writable.write(new Uint8Array([1]));
    await writable.close();
    const read = await file.getFile();
    if (read.size !== 1) throw new DOMException('папка приняла запись не полностью', 'DataError');
  } finally {
    await handle.removeEntry(PROBE).catch(() => undefined);
  }
}

/** OPFS — приватное хранилище источника. Есть везде, где есть service worker. */
export async function openOpfsVault(): Promise<VaultStorage | null> {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return null;
  const root = await navigator.storage.getDirectory();
  const handle = await root.getDirectoryHandle('vault', { create: true });
  return new DirectoryVaultStorage(handle, 'OPFS');
}

/**
 * Хранилище прошлого запуска. Сначала — папка, которую выбрал пользователь
 * (если разрешение ещё действует), иначе OPFS, иначе `null` — тогда экраны
 * покажут онбординг с выбором места (SCREENS §1, шаг 2).
 */
export async function restoreVault(): Promise<VaultStorage | null> {
  const handle = await recallHandle();
  if (handle) {
    const permission = handle as FileSystemDirectoryHandle & PermissionCapableHandle;
    const state =
      (await permission.queryPermission?.({ mode: 'readwrite' })) ?? ('granted' as PermissionState);
    if (state === 'granted') return new DirectoryVaultStorage(handle, handle.name);
    /* `prompt` требует жеста пользователя — не дёргаем его на старте. */
  }
  return openOpfsVault();
}

/* ── IndexedDB: одна ручка, один ключ ─────────────────────────────────────── */

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(HANDLE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

export async function rememberHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

async function recallHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb();
  if (!db) return null;
  const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve) => {
    const tx = db.transaction(HANDLE_STORE, 'readonly');
    const request = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
    request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle) ?? null);
    request.onerror = () => resolve(null);
  });
  db.close();
  return handle;
}
