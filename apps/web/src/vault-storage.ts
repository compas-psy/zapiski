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
  /**
   * Кто сейчас пишет в этот путь. Ключ — путь назначения.
   *
   * ── Зачем очередь ───────────────────────────────────────────────────────
   *
   * Атомарная запись здесь — «временный файл + `move` на место». Пока `move`
   * идёт, файл назначения ЗАБЛОКИРОВАН: второй `move` в тот же путь падает с
   * «A FileSystemHandle cannot be moved to a destination which is locked».
   * В файловой системе такого нет — там `rename` поверх существующего просто
   * побеждает, — и потому ядро спокойно пишет один и тот же файл дважды
   * подряд: заметку создаёт `vault.create`, а через мгновение её же
   * сохраняет автосохранение редактора.
   *
   * Живой прогон в браузере поймал именно это: первая заметка не создавалась
   * вовсе — исключение улетало из `createNote`, и человек оставался на пустом
   * списке после онбординга.
   *
   * Очередь по пути упорядочивает такие записи: вторая ждёт первую, обе
   * доходят, последняя побеждает — как и на диске.
   */
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(
    private readonly root: FileSystemDirectoryHandle,
    /** Что показать в настройках как «папка с заметками». */
    readonly label: string,
  ) {}

  /** Выполнить работу над путём, дождавшись предыдущей работы над ним же. */
  private queued<T>(path: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(path) ?? Promise.resolve();
    /* Чужая неудача не должна ронять следующего в очереди: ждём завершения,
       а не успеха. Свою ошибку вызывающий получит как обычно. */
    const next = previous.then(work, work);
    this.writes.set(
      path,
      next.catch(() => undefined),
    );
    return next;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const handle = await this.fileHandle(path, false);
    if (!handle) return null;
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  /**
   * Запись прямо в файл — и это атомарно по спецификации.
   *
   * ── Почему не «временный файл + переименование» ─────────────────────────
   *
   * Здесь стоял тот же приём, что и на диске: записать рядом и переименовать
   * поверх. В вебе он лишний и вредный.
   *
   * Лишний — потому что `createWritable()` по спецификации File System Access
   * пишет в теневую копию и подменяет файл целиком на `close()`: прерывание на
   * любом байте оставляет прежнюю версию, а не половину новой. Это ровно то,
   * чего требует ТЗ §4.3, и оно уже есть.
   *
   * Вредный — потому что переименование поверх делается через `move()`, а он в
   * Chromium **отказывает, если в имени назначения есть не-ASCII**: живой опыт
   * в браузере — `move(dir, 'note.md')` проходит, `move(dir, 'Заметка.md')`
   * падает с «A FileSystemHandle cannot be moved to a destination which is
   * locked», хотя ничего не заблокировано. Имя по умолчанию у нас «Без
   * названия.md», поэтому в вебе не создавалась ПЕРВАЯ ЖЕ заметка: человек
   * проходил онбординг и оставался на пустом списке.
   */
  async write(path: string, data: Uint8Array): Promise<void> {
    return this.queued(path, () => this.writeNow(path, data));
  }

  private async writeNow(path: string, data: Uint8Array): Promise<void> {
    const directory = await this.directoryOf(path, true);
    const handle = await directory.getFileHandle(baseName(path), { create: true });
    const writable = await handle.createWritable();
    /* Копия буфера: у Uint8Array из ядра может быть чужой ArrayBuffer. */
    await writable.write(data.slice().buffer as ArrayBuffer);
    await writable.close();
  }

  async remove(path: string): Promise<void> {
    const directory = await this.directoryOf(path, false);
    if (!directory) return;
    await directory.removeEntry(baseName(path), { recursive: true }).catch(() => undefined);
  }

  async rename(from: string, to: string): Promise<void> {
    /* Ключ — путь НАЗНАЧЕНИЯ: блокируется именно он. Внутри зовётся
       `writeNow`, а не `write`, иначе очередь ждала бы сама себя. */
    return this.queued(to, () => this.renameNow(from, to));
  }

  private async renameNow(from: string, to: string): Promise<void> {
    const source = await this.fileHandle(from, false);
    if (!source) return;
    const targetDirectory = await this.directoryOf(to, true);
    const movable = source as FileSystemFileHandle & MovableFileHandle;
    if (typeof movable.move === 'function') {
      try {
        await movable.move(targetDirectory, baseName(to));
        return;
      } catch {
        /* `move()` есть, но сработать не обязан: у браузеров с ним хватает
           краевых случаев. Отказ — не повод потерять переименование: ниже
           копируем содержимое и убираем исходник. Медленнее, зато заметка
           оказывается там, где человек её ждёт. */
      }
    }
    const file = await source.getFile();
    await this.writeNow(to, new Uint8Array(await file.arrayBuffer()));
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
/**
 * Сколько ждём ответа от папки, прежде чем признать её неотвечающей.
 *
 * Проверка идёт через провайдер файловой системы, а на Android им может быть
 * что угодно — облачный клиент, сетевой диск, карта памяти. Такой провайдер
 * имеет право не ответить НИКОГДА, и тогда обещание «сейчас проверю» висит
 * вечно: человек с Android выбрал папку в браузере и остался с крутящимся
 * кружком в кнопке, без единого слова. Десять секунд — заведомо больше любого
 * честного ответа и заведомо меньше терпения.
 */
const PROBE_TIMEOUT_MS = 10_000;

function withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException(message, 'TimeoutError')), PROBE_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function assertWritable(handle: FileSystemDirectoryHandle): Promise<void> {
  await withTimeout(probeWrite(handle), 'папка не ответила на проверку записи');
}

async function probeWrite(handle: FileSystemDirectoryHandle): Promise<void> {
  const file = await handle.getFileHandle(PROBE, { create: true });
  try {
    /* Самая дешёвая проверка — имя самой ручки. Провайдер, срезавший точку,
       выдаёт себя сразу, не дожидаясь обхода каталога. */
    if (file.name !== PROBE) {
      throw new DOMException('папка переименовывает файлы при создании', 'InvalidModificationError');
    }
    const writable = await (file as FileSystemFileHandle).createWritable();
    await writable.write(new Uint8Array([1]));
    await writable.close();
    const read = await file.getFile();
    if (read.size !== 1) throw new DOMException('папка приняла запись не полностью', 'DataError');

    /* Имя должно вернуться из каталога ТЕМ ЖЕ, каким его создавали.
       Провайдеры Android имеют право переименовать документ при создании —
       чаще всего срезают ведущую точку или дописывают расширение по типу.
       Для заметок это было бы обидно, а для служебного каталога `.zapiski`
       смертельно: vault потом не находит собственный индекс и журнал CRDT.
       Проверяем на пробном файле — он тоже начинается с точки. */
    let found = false;
    for await (const [name] of iterate(handle)) {
      if (name === PROBE) {
        found = true;
        break;
      }
    }
    if (!found) {
      throw new DOMException('папка переименовывает файлы при создании', 'InvalidModificationError');
    }
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
