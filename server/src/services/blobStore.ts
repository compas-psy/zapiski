import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
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
 * 2. **Адресация по содержимому.** Ключ файла — SHA-256 содержимого, каким оно
 *    пришло от клиента, а НЕ шифротекста на диске. Отсюда два следствия:
 *    запись идемпотентна (повтор ничего не портит), и старое содержимое не
 *    затирается новым — оно просто перестаёт быть нужным. Поэтому снимок в
 *    историю версий не требует копирования байтов: строка версии ссылается на
 *    тот же ключ.
 *
 *    Адрес и etag обязаны считаться именно от содержимого: etag видит клиент и
 *    сравнивает в If-Match. Считай мы их от шифротекста — смена серверного
 *    ключа сдвинула бы etag у всех сразу и сломала бы оптимистичную блокировку
 *    там, где ничего не менялось.
 *
 * 3. **Имена в томе не повторяют имена в vault'е.** Из листинга каталога
 *    нельзя узнать ни одного заголовка заметки (ТЗ §6). Дедупликация — только
 *    внутри одного аккаунта: общий на всех том выдал бы, что у двух людей
 *    совпал файл.
 *
 * 4. **В томе нет открытого текста.** Каждый файл лежит запечатанным в
 *    AES-256-GCM на ключе сервера. Раньше эту роль выполнял клиент: он слал
 *    шифротекст, и том получал уже закрытые байты. После решения убрать
 *    сквозное шифрование из MVP клиент шлёт содержимое как есть, и без встречной
 *    меры заметки легли бы в том открытым текстом — читаемые из снимка диска,
 *    из резервной копии, из увезённого тома, без единого ключа.
 *
 *    Это НЕ равноценная замена сквозному шифрованию и не выдаётся за неё:
 *    ключ здесь у сервера, значит сервер содержимое прочитать может. Защита
 *    ровно от одного класса угроз — доступ к файлам в обход работающего
 *    приложения. Сквозное шифрование вернётся отдельно, когда ключ будет
 *    приходить из внешней ключницы.
 */

export type BlobNamespace = 'blobs' | 'published' | 'feedback';

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

/**
 * Метка запечатанного файла: `Z`, `B`, версия формата.
 *
 * Нужна, чтобы отличать запечатанный файл от того, что лёг в том ДО перехода,
 * не заводя ради этого колонку в базе (в томе живут не только блобы vault'а, но
 * и опубликованные страницы со снимками экрана из обращений — у них своей
 * строки нет).
 *
 * Совпадение с началом старого файла исключено по факту, а не по вероятности:
 * до перехода в том попадали ровно три вида байтов — конверт клиентского шифра
 * (начинается с 0x01), PNG (0x89 'P' 'N' 'G') и JSON/HTML опубликованной
 * страницы ('{' или '<'). Ни один не начинается с 0x5A 0x42.
 */
const SEAL_MAGIC = Uint8Array.from([0x5a, 0x42, 0x01]);
const SEAL_NONCE = 12;
const SEAL_TAG = 16;
/** Насколько запечатанный файл длиннее содержимого. */
const SEAL_OVERHEAD = SEAL_MAGIC.length + SEAL_NONCE + SEAL_TAG;

export class BlobStore {
  readonly #root: string;
  readonly #key: Buffer;

  /**
   * @param key 32 байта для AES-256-GCM. Обязателен: необязательный ключ
   *   означал бы «том иногда открытый», а «иногда» здесь ничем не отличается от
   *   «всегда» — узнать об этом можно было бы только по факту утечки.
   */
  constructor(root: string, key: Buffer) {
    if (key.byteLength !== 32) {
      throw new Error(`ключ тома должен быть 32 байта, получено ${key.byteLength}`);
    }
    this.#root = path.resolve(root);
    this.#key = key;
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

  /**
   * Ключ снимка экрана, приложенного к обращению.
   *
   * В томе, а не в базе. Причина не в объёме: инвариант zero-knowledge (ТЗ
   * §2.1.5) запрещает держать в БД что-либо, кроме шифротекста CRDT, и
   * `bytea` со снимком его нарушал — сторож схемы это и поймал. Заодно снимок
   * удаляется вместе с файлом, а не переписыванием строки.
   *
   * Аккаунта у обращения нет (форма работает без него), поэтому ключ считается
   * от идентификатора обращения, а не от пользователя.
   */
  keyForFeedback(reportId: string): string {
    const digest = createHash('sha256').update(`feedback:${reportId}`).digest('hex');
    return path.posix.join('feedback', digest.slice(0, 2), digest.slice(2, 4), digest);
  }

  /** Ключ опубликованной страницы: у неё ровно одна текущая версия. */
  keyForPublished(slug: string): string {
    const digest = createHash('sha256').update(`published:${slug}`).digest('hex');
    return path.posix.join('published', digest.slice(0, 2), digest.slice(2, 4), digest);
  }

  /**
   * Считает адрес содержимого, ничего не записывая. Нужно, чтобы проверить
   * etag и квоту до того, как байты займут место в томе.
   */
  describeContent(userId: string, data: Uint8Array): StoredBlob {
    const digest = createHash('sha256').update(data).digest();
    const sha256 = digest.toString('hex');
    return {
      storageKey: this.keyForContent(userId, sha256),
      size: data.byteLength,
      sha256,
      etag: `"${digest.toString('base64url')}"`,
      written: false,
    };
  }

  /** Кладёт содержимое и возвращает его адрес. Повторный вызов — no-op. */
  async putContent(userId: string, data: Uint8Array): Promise<StoredBlob> {
    const described = this.describeContent(userId, data);

    // Сравниваем с длиной ЗАПЕЧАТАННОГО файла, а не содержимого: иначе файл,
    // записанный до перехода, считался бы уже лежащим и остался бы в томе
    // открытым текстом навсегда. При таком сравнении он не совпадёт по длине и
    // будет перезаписан запечатанным — том дочищается сам, по мере работы.
    const existing = await this.size(described.storageKey);
    if (existing === data.byteLength + SEAL_OVERHEAD) return described;

    await this.writeAt(described.storageKey, data);
    return { ...described, written: true };
  }

  /** Атомарная запись по конкретному ключу: печать → tmp → fsync → rename. */
  async writeAt(storageKey: string, data: Uint8Array): Promise<void> {
    const sealed = this.#seal(data);
    const target = this.#absolute(storageKey);
    const dir = path.dirname(target);
    await mkdir(dir, { recursive: true });

    const tmp = path.join(dir, `.tmp-${randomBytes(12).toString('hex')}`);
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(sealed);
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
      let raw: Buffer;
      try {
        raw = await handle.readFile();
      } finally {
        await handle.close();
      }
      return this.#unseal(storageKey, raw);
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

  /** Запечатывает содержимое: метка, случайный nonce, AES-256-GCM, тег. */
  #seal(data: Uint8Array): Buffer {
    const nonce = randomBytes(SEAL_NONCE);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([SEAL_MAGIC, nonce, body, cipher.getAuthTag()]);
  }

  /**
   * Распечатывает файл из тома.
   *
   * Файл без метки — записанный до перехода — возвращается как есть: отказаться
   * его читать значило бы потерять данные людей, которые уже лежат на проде.
   * Файл С меткой обязан открыться: если тег GCM не сошёлся, это либо порча
   * тома, либо чужой ключ, и в обоих случаях единственный честный ответ —
   * ошибка. Молча вернуть байты как открытый текст здесь нельзя: получатель не
   * отличит их от содержимого и запишет мусор в заметку.
   */
  #unseal(storageKey: string, raw: Buffer): Buffer {
    if (!hasSealMagic(raw)) return raw;
    if (raw.byteLength < SEAL_OVERHEAD) {
      throw new Error(`файл тома обрезан: ${storageKey}`);
    }
    const nonce = raw.subarray(SEAL_MAGIC.length, SEAL_MAGIC.length + SEAL_NONCE);
    const body = raw.subarray(SEAL_MAGIC.length + SEAL_NONCE, raw.byteLength - SEAL_TAG);
    const tag = raw.subarray(raw.byteLength - SEAL_TAG);
    const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      // Причину не пересказываем: «тег не сошёлся» и «ключ не тот» снаружи
      // неразличимы и различаться не должны.
      throw new Error(`файл тома не открывается: ${storageKey}`);
    }
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

function hasSealMagic(raw: Buffer): boolean {
  if (raw.byteLength < SEAL_MAGIC.length) return false;
  return SEAL_MAGIC.every((byte, index) => raw[index] === byte);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}
