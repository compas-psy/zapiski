import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApiError, errors } from '../lib/errors.ts';
import { authOf } from '../plugins/auth.ts';

/**
 * SEC-001 §12 — хранение обёрнутого ключа синхронизации аккаунта.
 *
 * Сервер здесь — камера хранения, а не участник: он принимает три поля
 * непрозрачных байт, отдаёт их обратно тому же аккаунту и не может ничего
 * с ними сделать. Развернуть `wrapped_smk` умеет только тот, у кого есть
 * код восстановления, а код на сервер не попадает никогда — ни при
 * создании, ни при подключении устройства.
 *
 * ── Признак «аккаунт шифруется» (design §13) ─────────────────────────────
 *
 * `GET` отвечает `{ enrolled: false }`, если ключа ещё нет. Это и есть тот
 * самый признак, по которому клиент понимает, что делать, ДО того как
 * потянет первый блоб: старый клиент этот эндпоинт не запрашивает вовсе и
 * потому не увидит его — а сервер, увидев онбординг аккаунта, начинает
 * отбивать запись открытым текстом (см. `assertPlaintextAllowed`).
 */

const putBody = z.object({
  /** base64: AES-256-GCM(SMK) под ключом из кода восстановления. */
  wrappedSmk: z.string().min(1).max(4096),
  /** base64: публичная соль HKDF аккаунта. */
  accountSalt: z.string().min(1).max(1024),
  /** base64: проверочный конверт для проверки кода без расшифровки заметок. */
  checkBlob: z.string().min(1).max(4096),
  keyVersion: z.number().int().min(1).max(255).optional(),
});

interface SyncKeyRow {
  wrapped_smk: Buffer;
  account_salt: Buffer;
  check_blob: Buffer;
  key_version: number;
  created_at: Date;
}

/**
 * Прошёл ли аккаунт онбординг ключа синка.
 *
 * Вынесено сюда и используется маршрутами блобов: как только у аккаунта
 * появился ключ, запись ОТКРЫТОГО текста в облако обязана отбиваться
 * сервером, а не только не выполняться клиентом (design §13, «старый
 * клиент не должен перезаписать зашифрованную заметку открытой версией»).
 */
export async function isAccountEncrypted(
  db: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  userId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT true AS exists FROM sync_keys WHERE user_id = $1`,
    [userId],
  );
  return rows.length > 0;
}

export async function registerSyncKeyRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.get('/api/v1/vault/sync-key', { preHandler: app.requireAuth }, async (request, reply) => {
    const auth = authOf(request);
    const { rows } = await ctx.db.query<SyncKeyRow>(
      `SELECT wrapped_smk, account_salt, check_blob, key_version, created_at
         FROM sync_keys WHERE user_id = $1`,
      [auth.userId],
    );
    const row = rows[0];
    if (!row) {
      /* Не 404: «ключа ещё нет» — штатное состояние первого устройства
         аккаунта, а не ошибка. Клиент по этому ответу предлагает создать
         ключ, а не показывает сбой. */
      return reply.send({ enrolled: false });
    }
    return reply.send({
      enrolled: true,
      wrappedSmk: row.wrapped_smk.toString('base64'),
      accountSalt: row.account_salt.toString('base64'),
      checkBlob: row.check_blob.toString('base64'),
      keyVersion: row.key_version,
      createdAt: row.created_at.toISOString(),
    });
  });

  /**
   * Создание ключа аккаунта. ОДИН раз: повторный PUT с другим ключом
   * отбивается.
   *
   * Причина не в аккуратности, а в потере данных: перезапись ключа сделала
   * бы нечитаемым всё, что уже зашифровано старым SMK, — а на сервере
   * лежит именно оно. Смена ключа (ротация) — это перешифровальный проход
   * по всему аккаунту, отдельная операция фазы 2 (design §2.3, §11), а не
   * побочный эффект PUT.
   */
  app.put('/api/v1/vault/sync-key', { preHandler: app.requireAuth }, async (request, reply) => {
    const auth = authOf(request);
    const body = putBody.safeParse(request.body);
    if (!body.success) throw errors.badRequest('bad_sync_key');

    const wrappedSmk = Buffer.from(body.data.wrappedSmk, 'base64');
    const accountSalt = Buffer.from(body.data.accountSalt, 'base64');
    const checkBlob = Buffer.from(body.data.checkBlob, 'base64');
    if (wrappedSmk.length === 0 || accountSalt.length === 0 || checkBlob.length === 0) {
      throw errors.badRequest('bad_sync_key');
    }

    const { rows } = await ctx.db.query<{ wrapped_smk: Buffer }>(
      `INSERT INTO sync_keys (user_id, wrapped_smk, account_salt, check_blob, key_version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING wrapped_smk`,
      [auth.userId, wrappedSmk, accountSalt, checkBlob, body.data.keyVersion ?? 1],
    );

    if (rows.length === 0) {
      /* Ключ уже есть. Идемпотентность важнее строгости: повтор ТОГО ЖЕ
         ключа (переотправка после обрыва сети) — это успех, а не конфликт;
         попытка подменить ключ ДРУГИМ — конфликт, потому что она сделала бы
         нечитаемым уже зашифрованное. */
      const { rows: existing } = await ctx.db.query<SyncKeyRow>(
        `SELECT wrapped_smk, account_salt, check_blob, key_version, created_at
           FROM sync_keys WHERE user_id = $1`,
        [auth.userId],
      );
      const current = existing[0];
      if (current && current.wrapped_smk.equals(wrappedSmk) && current.account_salt.equals(accountSalt)) {
        return reply.code(200).send({ enrolled: true, keyVersion: current.key_version });
      }
      /* 409: ключ уже есть и он ДРУГОЙ. Перезапись сделала бы нечитаемым
         всё, что уже зашифровано старым SMK. */
      throw new ApiError(409, 'sync_key_exists', 'Ключ синхронизации уже создан');
    }

    return reply.code(201).send({ enrolled: true, keyVersion: body.data.keyVersion ?? 1 });
  });
}
