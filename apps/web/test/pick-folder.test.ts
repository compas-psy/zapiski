/**
 * Выбор папки в вебе: что считается отказом, а что — правом человека.
 *
 * Тест появился после разбора записи с настоящего устройства. Samsung Internet,
 * тап по «Дальше», системный выбор папки, «Использовать эту папку» — и снова
 * тот же экран, без единого слова. Оболочка сливала два разных исхода в один
 * `null`, и экрану было нечего сказать.
 *
 * Здесь стережётся ровно эта граница. Оболочке по ARCHITECTURE §1 не положено
 * продуктовой логики, и её тут нет: проверяется только договор порта —
 * отмена молчит, отказ платформы кричит.
 */
import { describe, expect, it } from 'vitest';
import { pickVaultDirectory } from '../src/vault-storage.js';

/* ── Поддельная файловая система ──────────────────────────────────────────── */

interface FakeOptions {
  /** Провайдер переименовывает файл при создании (срезает ведущую точку). */
  manglesNames?: boolean;
  /** Создать файл дают, а писать — нет. */
  readOnly?: boolean;
}

function fakeDirectory(options: FakeOptions = {}): FileSystemDirectoryHandle {
  const files = new Map<string, Uint8Array>();

  const handle = {
    kind: 'directory' as const,
    name: 'Zapiski',

    async getFileHandle(requested: string, init?: { create?: boolean }) {
      const stored = options.manglesNames ? requested.replace(/^\.+/, '') : requested;
      if (init?.create) files.set(stored, new Uint8Array());
      else if (!files.has(stored)) throw new DOMException('нет такого файла', 'NotFoundError');

      return {
        kind: 'file' as const,
        // Провайдер отдаёт СВОЁ имя — то, под которым документ реально лёг.
        name: stored,
        async createWritable() {
          if (options.readOnly) throw new DOMException('только чтение', 'NotAllowedError');
          let buffer = new Uint8Array();
          return {
            async write(data: Uint8Array | ArrayBuffer) {
              buffer = data instanceof Uint8Array ? data : new Uint8Array(data);
            },
            async close() {
              files.set(stored, buffer);
            },
          };
        },
        async getFile() {
          const data = files.get(stored) ?? new Uint8Array();
          return { size: data.byteLength, name: stored } as File;
        },
      };
    },

    async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
      for (const name of files.keys()) {
        yield [name, { kind: 'file', name } as FileSystemHandle];
      }
    },

    async removeEntry(name: string) {
      files.delete(name);
    },
  };

  return handle as unknown as FileSystemDirectoryHandle;
}

function withPicker(picker: () => Promise<FileSystemDirectoryHandle>): void {
  (globalThis as { window?: unknown }).window = { showDirectoryPicker: picker };
}

/* ── Проверки ─────────────────────────────────────────────────────────────── */

describe('выбор папки в вебе', () => {
  it('отмена человеком — это не ошибка: null и молчание', async () => {
    withPicker(() => Promise.reject(new DOMException('отменено', 'AbortError')));
    await expect(pickVaultDirectory()).resolves.toBeNull();
  });

  it('папка, в которую нельзя писать, отвергается вслух', async () => {
    withPicker(async () => fakeDirectory({ readOnly: true }));
    // Именно так ведут себя провайдеры Android: диалог прошёл, запись — нет.
    await expect(pickVaultDirectory()).rejects.toThrow();
  });

  it('папка, переименовывающая файлы, отвергается вслух', async () => {
    withPicker(async () => fakeDirectory({ manglesNames: true }));
    // Для заметок это было бы обидно, а для служебного `.zapiski` смертельно:
    // vault потом не найдёт ни свой индекс, ни журнал CRDT.
    await expect(pickVaultDirectory()).rejects.toThrow();
  });

  it('исправная папка отдаётся приложению, а пробный файл убран за собой', async () => {
    const directory = fakeDirectory();
    withPicker(async () => directory);

    const storage = await pickVaultDirectory();
    expect(storage).not.toBeNull();

    const left: string[] = [];
    for await (const [name] of (
      directory as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }
    ).entries()) {
      left.push(name);
    }
    expect(left).toEqual([]);
  });
});
