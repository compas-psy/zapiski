import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Хранилище зашифрованных байтов в томе (ТЗ §4.1, §4.3).
 *
 * Три свойства, которые обязаны держаться:
 *
 * 1. **Атомарность.** Запись идёт во временный файл в том же каталоге, затем
 *    `fsync` и `rename`. Прерывание на любом байте не оставляет полуфайла:
 *    читатель видит либо старое содержимое, либо новое целиком.
 *
 * 2. **Адресация по содержимому.** Ключ файла — SHA-256 шифротекста. Отсюда
 *    два следствия: запись идемпотентна (повтор ничего не портит), и старый
 *    шифротекст не затирается новым — он просто перестаёт быть нужен. Поэтому
 *    снимок в историю версий не требует копирования байтов: строка версии
 *    ссылается на тот же ключ.
 *
 * 3. **Имена в томе не повторяют имена в vault'е.** Из листинга каталога
 *    нельзя узнать ни одного заголовка заметки (ТЗ §6). Дедупликация — только
 *    внутри одного аккаунта: общий на всех том выдал бы, что у двух людей
 *    совпал файл.
 */

export type BlobNamespace = 'blobs' | 'published';

export interface StoredBlob {
  storageKey: string;
  size: number;
  /** SHA-256 шифротекста в hex. */
  sha256: string;
  /** Сильный валидатор для заголовка ETag. */
  etag: string;
  /** false, если файл с таким содержимым уже лежал в томе. */
  written: boolean;
}

export class BlobStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  get root(): string {
    return this.#root;
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  /** Ключ содержимого внутри аккаунта. */
  keyForContent(userId: string, sha256Hex: string): string {
    return path.posix.join('blobs', userId, sha256Hex.slice(0, 2), sha256Hex.slice(2, 4), sha256Hex);
  }

  /** Ключ опубликованной страницы: у неё ровно одна текущая версия. */
  keyForPublished(slug: string): string {
    const digest = createHash('sha256').update(`published:${slug}`).digest('hex');
    return path.posix.join('published', digest.slice(0, 2), digest.slice(2, 4), digest);
  }

  /** Кладёт шифротекст и возвращает его адрес. Повторный вызов — no-op. */
  async putContent(userId: string, data: Uint8Array): Promise<StoredBlob> {
    const digest = createHash('sha256').update(data).digest();
    const sha256 = digest.toString('hex');
    const storageKey = this.keyForContent(userId, sha256);
    const etag = `"${digest.toString('base64url')}"`;

    const existing = await this.size(storageKey);
    if (existing === data.byteLength) {
      return { storageKey, size: data.byteLength, sha256, etag, written: false };
    }

    await this.writeAt(storageKey, data);
    return { storageKey, size: data.byteLength, sha256, etag, written: true };
  }

  /** Атомарная запись по конкретному ключу: tmp → fsync → rename. */
  async writeAt(storageKey: string, data: Uint8Array): Promise<void> {
    const target = this.#absolute(storageKey);
    const dir = path.dirname(target);
    await mkdir(dir, { recursive: true });

    const tmp = path.join(dir, `.tmp-${randomBytes(12).toString('hex')}`);
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      // Без fsync rename атомарен только относительно порядка в кеше страниц:
      // после внезапной перезагрузки имя может указывать на пустой файл.
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async read(storageKey: string): Promise<Buffer | null> {
    try {
      const handle = await open(this.#absolute(storageKey), 'r');
      try {
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async size(storageKey: string): Promise<number | null> {
    try {
      const info = await stat(this.#absolute(storageKey));
      return info.size;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.#absolute(storageKey), { force: true });
  }

  #absolute(storageKey: string): string {
    const resolved = path.resolve(this.#root, storageKey);
    // Ключи собираем сами, но проверка обязательна: она стоит копейки и
    // закрывает целый класс ошибок, если сюда однажды попадёт чужое значение.
    if (resolved !== this.#root && !resolved.startsWith(this.#root + path.sep)) {
      throw new Error('storage key выходит за пределы тома');
    }
    return resolved;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}
