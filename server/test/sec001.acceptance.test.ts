/**
 * SEC-001 — приёмка zero-knowledge. Definition of Done.
 *
 * Это не модульный тест крипто-функций (те лежат в
 * `packages/core/test/sync-keys.test.ts`), а сквозная проверка ГЛАВНОГО
 * инварианта задачи на НАСТОЯЩЕМ сервере, с настоящим Postgres и настоящим
 * томом блобов на диске:
 *
 *   сервер CMPAS никогда не получает содержимое обычной приватной заметки,
 *   CRDT-апдейт или версию в открытом виде и не обладает ключом, которым
 *   способен их расшифровать.
 *
 * Метод — sentinel: в заметку кладётся уникальная строка
 * `SEC001_PLAINTEXT_SENTINEL_<random>`, после синка она ищется ВЕЗДЕ, куда
 * сервер мог её положить: тело HTTP-запроса, все текстовые и бинарные
 * колонки Postgres, каждый файл тома. Уникальность строки важна: она не
 * может совпасть случайно, и если нашлась — значит реально утекла.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, createUser, noDatabase, type Harness, type TestUser } from './helpers/app.ts';

/**
 * Конверт собирается ЗДЕСЬ, а не импортом из `@zapiski/core`.
 *
 * Сервер намеренно не зависит от ядра в рантайме (см. шапку
 * `src/lib/analytics-schema.ts` и `test/contract.conformance.test.ts` — там
 * та же развилка решена так же). Для этой приёмки это не потеря, а плюс:
 * проверяется не «наш клиент шифрует», а «сервер не видит открытого текста,
 * что бы ни прислал клиент». Раскладка повторяет
 * `packages/core/src/sync/sync-crypto.ts`: [версия(1)][нонс(12)][GCM].
 */
const ENVELOPE_VERSION = 1;

async function domainKey(smk: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await globalThis.crypto.subtle.importKey('raw', smk, 'HKDF', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(
  smk: Uint8Array,
  salt: Uint8Array,
  info: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const key = await domainKey(smk, salt, info);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const header = new Uint8Array([ENVELOPE_VERSION]);
  const aad = new Uint8Array([...header, ...new TextEncoder().encode(info)]);
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad },
      key,
      plaintext,
    ),
  );
  return new Uint8Array([...header, ...nonce, ...ciphertext]);
}

async function open(
  smk: Uint8Array,
  salt: Uint8Array,
  info: string,
  envelope: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    const key = await domainKey(smk, salt, info);
    const header = envelope.slice(0, 1);
    const nonce = envelope.slice(1, 13);
    const aad = new Uint8Array([...header, ...new TextEncoder().encode(info)]);
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad },
      key,
      envelope.slice(13),
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

/**
 * Адрес объекта на сервере — `HMAC(секрет адресов, путь)`, как это делает
 * `SyncCrypto.pathToken`. Именно поэтому в базе не остаётся ни «Личное», ни
 * «Дневник»: сервер видит только шестнадцатеричный токен.
 */
async function pathToken(smk: Uint8Array, salt: Uint8Array, path: string): Promise<string> {
  const base = await globalThis.crypto.subtle.importKey('raw', smk, 'HKDF', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode('zapiski/sync/v1/path-token'),
    },
    base,
    256,
  );
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    bits,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(path)),
  );
  return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const contentInfo = (path: string): string => `zapiski/sync/v1/content/${path}`;
const crdtInfo = (noteId: string): string => `zapiski/sync/v1/crdt/${noteId}`;
const versionsInfo = (noteId: string): string => `zapiski/sync/v1/versions/${noteId}`;

/** Уникальная строка: случайное совпадение исключено. */
const SENTINEL = `SEC001_PLAINTEXT_SENTINEL_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const NOTE = `# Личное\n\n${SENTINEL}\n\nи ещё немного текста, чтобы заметка была похожа на настоящую.\n`;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Каждый файл тома, рекурсивно. */
async function volumeFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(root);
  return out;
}

/**
 * Все значения всех колонок всех таблиц — как текст.
 *
 * Именно так, а не «проверим те колонки, где мы ожидаем утечку»: смысл
 * приёмки в том, чтобы поймать утечку ТАМ, ГДЕ ЕЁ НЕ ЖДАЛИ.
 */
async function everythingInDatabase(harness: Harness): Promise<string> {
  const { rows: tables } = await harness.db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const chunks: string[] = [];
  for (const { table_name: table } of tables) {
    const { rows } = await harness.db.query<Record<string, unknown>>(
      `SELECT * FROM "${table}"`,
    );
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (value === null || value === undefined) continue;
        chunks.push(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
      }
    }
  }
  return chunks.join('\n');
}

describe.skipIf(noDatabase())('SEC-001 приёмка: known-plaintext sentinel', () => {
  let harness: Harness;
  let user: TestUser;
  const smk = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const accountSalt = new Uint8Array(16).fill(9);
  const sentBodies: string[] = [];
  let address = '';

  beforeAll(async () => {
    harness = await createHarness();
    user = await createUser(harness);

    // Аккаунт проходит онбординг ключа — ровно то, что делает клиент.
    const checkBlob = await seal(smk, accountSalt, 'zapiski/sync/v1/manifest', bytes('zapiski/sync/v1/check'));

    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/sync-key',
      headers: user.authHeader,
      payload: {
        wrappedSmk: Buffer.from('обёрнутый-ключ-для-приёмки').toString('base64'),
        accountSalt: Buffer.from(accountSalt).toString('base64'),
        checkBlob: Buffer.from(checkBlob).toString('base64'),
      },
    });

    // Синк заметки — через ту же границу шифрования, что и в приложении.
    const sealed = await seal(smk, accountSalt, contentInfo('Личное/Дневник.md'), bytes(NOTE));
    sentBodies.push(Buffer.from(sealed).toString('utf8'));
    address = await pathToken(smk, accountSalt, 'Личное/Дневник.md');
    const put = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/vault/blob/${address}`,
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream', 'x-note-id': 'note-sec001' },
      payload: Buffer.from(sealed),
    });
    expect(put.statusCode).toBe(200);

    // CRDT-апдейт — тем же путём, своим доменным ключом.
    const sealedUpdate = await seal(smk, accountSalt, crdtInfo('note-sec001'), bytes(NOTE));
    sentBodies.push(Buffer.from(sealedUpdate).toString('utf8'));
    const crdt = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/crdt/note-sec001',
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from(sealedUpdate),
    });
    expect(crdt.statusCode).toBe(201);

    // Версия — тоже.
    const sealedVersion = await seal(smk, accountSalt, versionsInfo('note-sec001'), bytes(NOTE));
    sentBodies.push(Buffer.from(sealedVersion).toString('utf8'));
    const version = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/versions/note-sec001',
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from(sealedVersion),
    });
    expect(version.statusCode).toBe(201);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('sentinel не уходит в теле HTTP-запроса', () => {
    for (const body of sentBodies) {
      expect(body).not.toContain(SENTINEL);
    }
  });

  it('sentinel не лежит ни в одной колонке ни одной таблицы Postgres', async () => {
    const dump = await everythingInDatabase(harness);
    expect(dump).not.toContain(SENTINEL);
  });

  it('sentinel не лежит ни в одном файле тома блобов', async () => {
    const files = await volumeFiles(harness.blobRoot);
    expect(files.length, 'том пуст — значит проверять было нечего, тест бессмысленен').toBeGreaterThan(0);
    for (const file of files) {
      const content = await readFile(file);
      expect(content.toString('utf8'), file).not.toContain(SENTINEL);
    }
  });

  it('sentinel не лежит в CRDT-хранилище', async () => {
    const { rows } = await harness.db.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM crdt_updates`,
    );
    expect(rows.length, 'CRDT-апдейтов нет — проверять нечего').toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.ciphertext.toString('utf8')).not.toContain(SENTINEL);
    }
  });

  it('sentinel не лежит в истории версий', async () => {
    const { rows } = await harness.db.query<{ storage_key: string }>(
      `SELECT storage_key FROM versions`,
    );
    expect(rows.length, 'версий нет — проверять нечего').toBeGreaterThan(0);
    for (const row of rows) {
      const content = await readFile(path.join(harness.blobRoot, row.storage_key)).catch(() => null);
      if (content !== null) expect(content.toString('utf8')).not.toContain(SENTINEL);
    }
  });

  /**
   * Тест «компрометация сервера». Атакующий получил ВСЁ, что есть у сервера:
   * базу целиком, том целиком, переменные окружения и секреты, живые
   * токены доступа. Восстановить содержимое приватной заметки он не может.
   */
  it('имея всю базу, весь том, секреты и токены — содержимое не восстанавливается', async () => {
    const dump = await everythingInDatabase(harness);
    const volume = (
      await Promise.all(
        (await volumeFiles(harness.blobRoot)).map(async (f) => (await readFile(f)).toString('utf8')),
      )
    ).join('\n');
    const secrets = [
      JSON.stringify(harness.ctx.env),
      user.accessToken,
      user.refreshToken,
      user.userId,
      user.deviceId,
    ].join('\n');

    const everythingTheServerHas = `${dump}\n${volume}\n${secrets}`;
    expect(everythingTheServerHas).not.toContain(SENTINEL);

    /*
     * Про слова из ПУТИ («Личное», «Дневник») проверка отдельная и узкая —
     * по строкам ИМЕННО ЭТОГО аккаунта.
     *
     * Первая версия искала эти слова по всему дампу базы и падала на полном
     * прогоне: соседние тесты пишут в ту же базу свои данные, и слово
     * «Личное» там встречается законно. Это была ошибка теста, а не утечка,
     * — но ошибка ровно того сорта, из-за которого сторожа начинают
     * отключать. Ищем там, где утечка была бы наша.
     */
    const { rows: mine } = await harness.db.query<{ path: string; path_hash: string }>(
      `SELECT path, path_hash FROM blobs WHERE user_id = $1`,
      [user.userId],
    );
    expect(mine.length).toBeGreaterThan(0);
    for (const row of mine) {
      for (const word of ['Личное', 'Дневник', '.md']) {
        expect(row.path, `blobs.path выдаёт «${word}»`).not.toContain(word);
      }
      // Адрес — шестнадцатеричный токен, а не путь.
      expect(row.path).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  /**
   * Обратная сторона: правильный ключ ДОЛЖЕН открывать. Иначе «ничего не
   * читается» было бы тривиально достижимо порчей данных, и все проверки
   * выше ничего не стоили бы.
   */
  it('правильный ключ открывает заметку обратно — данные не потеряны', async () => {
    const get = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/vault/blob/${address}`,
      headers: user.authHeader,
    });
    expect(get.statusCode).toBe(200);
    const opened = await open(smk, accountSalt, contentInfo('Личное/Дневник.md'), new Uint8Array(get.rawPayload));
    expect(opened).not.toBeNull();
    expect(new TextDecoder().decode(opened!)).toBe(NOTE);
  });

  it('чужой ключ не открывает — и не отдаёт частичного открытого текста', async () => {
    const get = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/vault/blob/${address}`,
      headers: user.authHeader,
    });
    const strangerSmk = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const opened = await open(strangerSmk, accountSalt, contentInfo('Личное/Дневник.md'), new Uint8Array(get.rawPayload));
    expect(opened).toBeNull();
  });
});
