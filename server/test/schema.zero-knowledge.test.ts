import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';

/**
 * ZERO-KNOWLEDGE (ТЗ §2.1.5, ARCHITECTURE §3.3).
 *
 * «Сервер хранит только зашифрованные байты и НЕ МОЖЕТ их расшифровать.
 *  Никакого поля с открытым текстом заметки в схеме БД быть не должно.»
 *
 * Проверяется в три захода:
 *  1. Текстом по миграциям — до всякой базы, поэтому работает и в CI без
 *     Postgres, и на приёмке, где смотрят в `migrations/*.sql`.
 *  2. Интроспекцией живой схемы — миграция может создать колонку динамически.
 *  3. Сквозным сценарием — записанный шифротекст не находится в базе ни целиком,
 *     ни по фрагменту.
 */

const MIGRATIONS_DIR = path.resolve(fileURLToPath(new URL('../migrations', import.meta.url)));

/**
 * Имена колонок, которых в схеме быть не может: они означали бы, что где-то
 * лежит открытый текст заметки.
 */
const FORBIDDEN_COLUMN_NAMES = [
  'body',
  'content',
  'text',
  'plaintext',
  'plain_text',
  'markdown',
  'md',
  'note_body',
  'note_text',
  'snippet',
  'title',
  'html',
  'preview',
  'excerpt',
  'summary',
  'decrypted',
];

/**
 * Слова, которых не должно быть в именах колонок, потому что ТЗ §5.5 прямо
 * запрещает пароли и SMS-зависимые пути (ARCHITECTURE §3.6).
 */
const FORBIDDEN_AUTH_NAMES = [
  'password',
  'password_hash',
  'passwd',
  'phone',
  'phone_number',
  'msisdn',
  'sms_code',
  'otp',
  'otp_code',
];

interface Column {
  table: string;
  column: string;
  type: string;
}

async function columnsFromMigrations(): Promise<Column[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const columns: Column[] = [];

  for (const file of files) {
    const sql = stripComments(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));

    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\n\)\s*;/gi;
    for (let match = createRe.exec(sql); match !== null; match = createRe.exec(sql)) {
      const table = (match[1] ?? '').toLowerCase();
      for (const line of splitTopLevel(match[2] ?? '')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        // Табличные ограничения — не колонки.
        if (/^(UNIQUE|PRIMARY|FOREIGN|CHECK|CONSTRAINT|EXCLUDE)\b/i.test(trimmed)) continue;
        const nameMatch = /^"?([A-Za-z_][A-Za-z0-9_]*)"?\s+(.+)$/.exec(trimmed);
        if (nameMatch === null) continue;
        columns.push({
          table,
          column: (nameMatch[1] ?? '').toLowerCase(),
          type: (nameMatch[2] ?? '').toLowerCase(),
        });
      }
    }

    const alterRe = /ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+([^;]+);/gi;
    for (let match = alterRe.exec(sql); match !== null; match = alterRe.exec(sql)) {
      columns.push({
        table: (match[1] ?? '').toLowerCase(),
        column: (match[2] ?? '').toLowerCase(),
        type: (match[3] ?? '').toLowerCase(),
      });
    }
  }

  return columns;
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** Делит определение таблицы по запятым верхнего уровня. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

describe('zero-knowledge: схема БД', () => {
  it('в миграциях объявлены все обязательные таблицы', async () => {
    const columns = await columnsFromMigrations();
    const tables = new Set(columns.map((c) => c.table));
    for (const required of [
      'users',
      'sessions',
      'magic_tokens',
      'devices',
      'blobs',
      'crdt_updates',
      'versions',
      'subscriptions',
      'published_pages',
      'quota_usage',
    ]) {
      expect(tables, `нет таблицы ${required}`).toContain(required);
    }
    expect(columns.length).toBeGreaterThan(40);
  });

  it('ни одной колонки с открытым текстом заметки', async () => {
    const columns = await columnsFromMigrations();
    const offenders = columns.filter((c) => FORBIDDEN_COLUMN_NAMES.includes(c.column));
    expect(
      offenders.map((c) => `${c.table}.${c.column}`),
      'колонка с открытым текстом заметки в схеме — блокирующий дефект (ТЗ §2.1.5)',
    ).toEqual([]);
  });

  it('ни одной колонки про пароль, телефон или SMS-код (ТЗ §5.5)', async () => {
    const columns = await columnsFromMigrations();
    const offenders = columns.filter((c) =>
      FORBIDDEN_AUTH_NAMES.some((name) => c.column === name || c.column.endsWith(`_${name}`)),
    );
    expect(offenders.map((c) => `${c.table}.${c.column}`)).toEqual([]);
  });

  /**
   * Список нарочно закрытый, а не «любые bytea разрешены»: каждая новая
   * бинарная колонка обязана быть здесь названа и объяснена, иначе однажды
   * в схему въедет колонка с содержимым заметки под нейтральным именем.
   *
   * `sync_keys.*` (SEC-001, миграция 0014) — материал ключа, а не заметки:
   * SMK, обёрнутый ключом из кода восстановления, публичная соль HKDF и
   * проверочный конверт. Развернуть их сервер не может ни при какой
   * компрометации: код восстановления — 256 бит CSPRNG, известных только
   * человеку, и на сервер он не попадает никогда.
   */
  const ALLOWED_BINARY_COLUMNS = [
    'crdt_updates.ciphertext',
    'sync_keys.wrapped_smk',
    'sync_keys.account_salt',
    'sync_keys.check_blob',
  ];

  it('бинарные колонки — только шифротекст CRDT и обёрнутый ключ синка', async () => {
    const columns = await columnsFromMigrations();
    const binary = columns.filter((c) => c.type.startsWith('bytea'));
    expect(binary.map((c) => `${c.table}.${c.column}`).sort()).toEqual(
      [...ALLOWED_BINARY_COLUMNS].sort(),
    );
  });

  /**
   * SEC-001: ключ синка обязан лежать ТОЛЬКО обёрнутым. Колонка с сырым
   * ключом (или с кодом восстановления) сделала бы всю работу бессмысленной
   * — сервер снова смог бы прочитать заметки.
   */
  it('в sync_keys нет колонки с развёрнутым ключом или кодом восстановления', async () => {
    const columns = await columnsFromMigrations();
    const own = columns.filter((c) => c.table === 'sync_keys').map((c) => c.column);
    expect(own).toContain('wrapped_smk');
    for (const forbidden of ['smk', 'sync_key', 'recovery_code', 'recovery_secret', 'plaintext']) {
      expect(own, `sync_keys.${forbidden} не имеет права существовать`).not.toContain(forbidden);
    }
  });

  it('содержимое блобов и версий хранится в томе, а не в БД', async () => {
    const columns = await columnsFromMigrations();
    for (const table of ['blobs', 'versions', 'published_pages']) {
      const own = columns.filter((c) => c.table === table);
      expect(own.map((c) => c.column)).toContain('storage_key');
      // Ни одной колонки, способной вместить содержимое.
      expect(own.filter((c) => c.type.startsWith('bytea') || c.type.startsWith('jsonb'))).toEqual([]);
    }
  });

  it('в исходниках нет ни одного пути отправки SMS (ARCHITECTURE §3.6)', async () => {
    const srcDir = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));
    const files = await collectFiles(srcDir);
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      // Ищем не упоминание слова, а вызовы: отправку, шлюз, код подтверждения.
      if (/\b(sendSms|smsGateway|smsc|twilio|sms_code|sendVerificationCode)\b/i.test(text)) {
        offenders.push(path.relative(srcDir, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe.skipIf(noDatabase())('zero-knowledge: живая схема и сквозной сценарий', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('интроспекция схемы не находит колонок с открытым текстом', async () => {
    const { rows } = await harness.db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'`,
    );
    const offenders = rows.filter((row) =>
      FORBIDDEN_COLUMN_NAMES.includes(row.column_name.toLowerCase()),
    );
    expect(offenders.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([]);

    const authOffenders = rows.filter((row) =>
      FORBIDDEN_AUTH_NAMES.some(
        (name) =>
          row.column_name.toLowerCase() === name || row.column_name.toLowerCase().endsWith(`_${name}`),
      ),
    );
    expect(authOffenders.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([]);
  });

  it('записанный шифротекст не находится ни в одной текстовой колонке', async () => {
    const user = await createUser(harness);
    // Опознаваемая последовательность: если она где-то осела в базе — найдём.
    const marker = 'ZPSK-marker-7f3c9a1e-do-not-store-in-db';
    const payload = Buffer.from(marker, 'utf8');

    const written = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/секретная.md.enc',
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
      payload,
    });
    expect(written.statusCode).toBe(200);

    const { rows: textColumns } = await harness.db.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'bytea')`,
    );

    for (const column of textColumns) {
      const { rows } = await harness.db.query<{ hits: number }>(
        `SELECT COUNT(*)::int AS hits
           FROM "${column.table_name}"
          WHERE "${column.column_name}"::text LIKE $1`,
        [`%${marker}%`],
      );
      expect(
        rows[0]?.hits ?? 0,
        `${column.table_name}.${column.column_name} содержит присланные байты`,
      ).toBe(0);
    }

    // Зато байты отдаются обратно в точности — сервер их хранит, просто не в БД.
    const read = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/blob/секретная.md.enc',
      headers: user.authHeader,
    });
    expect(read.rawPayload.toString('utf8')).toBe(marker);
  });

  it('имена файлов в томе не повторяют путей vault’а', async () => {
    const user = await createUser(harness);
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/Проекты/Секретная идея.md.enc',
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('данные'),
    });

    const files = await collectFiles(harness.blobRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file).not.toContain('Секретная');
      expect(file).not.toContain('Проекты');
      expect(file).not.toContain('.md.enc');
    }
  });
});

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectFiles(full)));
    else out.push(full);
  }
  return out;
}
