import type { Db, DbClient } from '../db/pool.ts';
import { withTransaction } from '../db/pool.ts';
import { randomToken, sha256Hex } from '../lib/crypto.ts';

/**
 * Аккаунты, устройства, magic-токены, сессии.
 *
 * ТЗ §5.5: паролей нет вообще, SMS не используется нигде. В этом модуле нет и
 * не должно появиться ни одной функции про пароль, телефон или одноразовый код
 * в SMS.
 */

export interface UserRow {
  id: string;
  email: string;
  yandex_id: string | null;
  analytics_opt_in: boolean;
  /** Редакция принятого пользовательского соглашения. `null` — не принимал. */
  terms_version: string | null;
  terms_accepted_at: Date | null;
  /** Добровольное согласие на рекламные письма. Отзывается в любой момент. */
  marketing_opt_in: boolean;
  created_at: Date;
}

const USER_COLUMNS =
  'id, email, yandex_id, analytics_opt_in, terms_version, terms_accepted_at, marketing_opt_in, created_at';

/**
 * Согласия, данные при входе.
 *
 * Два РАЗНЫХ согласия, и складывать их в одно нельзя: обработка персональных
 * данных обязательна (без неё аккаунта нет), рассылка добровольна и даётся
 * отдельным действием. Рекламное согласие «в нагрузку» к обязательному — это
 * ровно то, что закон запрещает.
 */
export interface Consents {
  /** Редакция принятого соглашения. `null` — человек его сейчас не принимал. */
  termsVersion: string | null;
  /** Согласие на рекламные письма. `undefined` — не трогали, оставить как было. */
  marketingOptIn?: boolean | undefined;
}

/**
 * Записать согласия. Обязательное только проставляется, рекламное — и
 * проставляется, и снимается: отозвать согласие человек вправе всегда.
 */
export async function recordConsents(
  db: Db | DbClient,
  userId: string,
  consents: Consents,
  now: Date = new Date(),
): Promise<void> {
  await db.query(
    `UPDATE users SET
       terms_version     = COALESCE($2, terms_version),
       terms_accepted_at = CASE WHEN $2::text IS NULL THEN terms_accepted_at ELSE $4 END,
       marketing_opt_in  = COALESCE($3, marketing_opt_in),
       marketing_version = CASE WHEN $3::boolean IS NULL THEN marketing_version ELSE $2 END,
       marketing_at      = CASE WHEN $3::boolean IS NULL THEN marketing_at ELSE $4 END,
       updated_at        = now()
     WHERE id = $1`,
    [userId, consents.termsVersion, consents.marketingOptIn ?? null, now],
  );
}

/** Почта нормализуется к нижнему регистру: `Marina@Ya.ru` и `marina@ya.ru` — один аккаунт. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(db: Db | DbClient, email: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
    [normalizeEmail(email)],
  );
  return rows[0] ?? null;
}

export async function findUserById(db: Db | DbClient, id: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
}

/** Заводит аккаунт при первом входе. Отдельной регистрации в продукте нет. */
export async function upsertUserByEmail(db: Db | DbClient, email: string): Promise<UserRow> {
  const normalized = normalizeEmail(email);
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (email, email_verified_at)
     VALUES ($1, now())
     ON CONFLICT (lower(email)) DO UPDATE
       SET email_verified_at = COALESCE(users.email_verified_at, now()),
           deleted_at = NULL,
           updated_at = now()
     RETURNING ${USER_COLUMNS}`,
    [normalized],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('не удалось создать аккаунт');
  return row;
}

/**
 * Вход через Яндекс ID. Если аккаунт с такой почтой уже есть (входил по
 * magic-link), Яндекс просто привязывается к нему — это один и тот же человек.
 */
export async function upsertUserByYandex(
  db: Db | DbClient,
  yandexId: string,
  email: string,
): Promise<UserRow> {
  const byYandex = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE yandex_id = $1 AND deleted_at IS NULL`,
    [yandexId],
  );
  const existing = byYandex.rows[0];
  if (existing !== undefined) return existing;

  const user = await upsertUserByEmail(db, email);
  const { rows } = await db.query<UserRow>(
    `UPDATE users SET yandex_id = $2, updated_at = now()
      WHERE id = $1 AND yandex_id IS NULL
      RETURNING ${USER_COLUMNS}`,
    [user.id, yandexId],
  );
  return rows[0] ?? user;
}

export async function ensureDevice(
  db: Db | DbClient,
  userId: string,
  deviceKey: string,
  platform: string | null,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO devices (user_id, device_key, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, device_key) DO UPDATE
       SET last_seen_at = now(),
           platform = COALESCE(EXCLUDED.platform, devices.platform)
     RETURNING id`,
    [userId, deviceKey, platform],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('не удалось зарегистрировать устройство');
  return row.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Magic-link
// ─────────────────────────────────────────────────────────────────────────────

export interface IssuedMagicToken {
  /** Сырой токен. Существует только в этом ответе и в письме. */
  token: string;
  expiresAt: Date;
}

/**
 * Когда на этот адрес в последний раз уходило письмо.
 * SCREENS §2: «Отправить снова» неактивна 60 с — то же ограничение на сервере,
 * иначе его обходит кто угодно, кроме нашего же UI.
 */
export async function lastMagicTokenAt(db: Db | DbClient, email: string): Promise<Date | null> {
  const { rows } = await db.query<{ created_at: Date }>(
    `SELECT created_at FROM magic_tokens
      WHERE lower(email) = lower($1)
      ORDER BY created_at DESC
      LIMIT 1`,
    [normalizeEmail(email)],
  );
  return rows[0]?.created_at ?? null;
}

export async function createMagicToken(
  db: Db | DbClient,
  input: {
    email: string;
    deviceKey: string;
    platform: string | null;
    ttlSeconds: number;
    /* Согласия даются здесь, а аккаунт заводится при переходе по ссылке.
       Между этими моментами им негде жить, кроме как рядом с токеном. */
    termsVersion?: string | null;
    marketingOptIn?: boolean | null;
    /* Nonce клиента (см. 0013_auth_nonce.sql) — эхом возвращается в deep-link
       при обмене, привязывая финальный колбэк к устройству, реально
       запросившему вход. Отсутствует у клиентов до этой правки — обмен для
       них проходит без сверки nonce (см. respondWithSession). */
    nonce?: string | null;
  },
  now: Date = new Date(),
): Promise<IssuedMagicToken> {
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
  await db.query(
    `INSERT INTO magic_tokens
       (email, token_hash, device_key, platform, created_at, expires_at,
        terms_version, marketing_opt_in, nonce)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      normalizeEmail(input.email),
      sha256Hex(token),
      input.deviceKey,
      input.platform,
      now,
      expiresAt,
      input.termsVersion ?? null,
      input.marketingOptIn ?? null,
      input.nonce ?? null,
    ],
  );
  return { token, expiresAt };
}

export type MagicConsumeResult =
  | {
      ok: true;
      email: string;
      deviceKey: string;
      platform: string | null;
      /** Согласия, данные в момент запроса ссылки. */
      termsVersion: string | null;
      marketingOptIn: boolean | null;
      /** Nonce, с которым запрашивалась ссылка — эхом в deep-link (SEC: auth nonce). */
      nonce: string | null;
    }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' | 'device_mismatch' };

/**
 * Обмен токена. Три свойства проверяются здесь и покрыты тестами:
 * одноразовость, TTL 15 мин, привязка к устройству инициации (ТЗ §5.5).
 *
 * Строка берётся `FOR UPDATE`: без блокировки два одновременных перехода по
 * ссылке успевают оба увидеть `used_at IS NULL` и создать по сессии.
 */
export async function consumeMagicToken(
  db: Db,
  token: string,
  deviceKey: string,
  now: Date = new Date(),
): Promise<MagicConsumeResult> {
  const tokenHash = sha256Hex(token);
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<{
      terms_version: string | null;
      marketing_opt_in: boolean | null;
      nonce: string | null;
      id: string;
      email: string;
      device_key: string;
      platform: string | null;
      expires_at: Date;
      used_at: Date | null;
    }>(
      `SELECT id, email, device_key, platform, expires_at, used_at,
              terms_version, marketing_opt_in, nonce
         FROM magic_tokens WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash],
    );
    const row = rows[0];
    if (row === undefined) return { ok: false, reason: 'unknown' };
    if (row.used_at !== null) return { ok: false, reason: 'used' };
    if (row.expires_at.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
    // Привязка к устройству инициации: ссылку нельзя открыть на чужом устройстве.
    if (row.device_key !== deviceKey) return { ok: false, reason: 'device_mismatch' };

    await client.query(`UPDATE magic_tokens SET used_at = $2 WHERE id = $1`, [row.id, now]);
    return {
      ok: true,
      email: row.email,
      deviceKey: row.device_key,
      platform: row.platform,
      termsVersion: row.terms_version,
      marketingOptIn: row.marketing_opt_in,
      nonce: row.nonce,
    };
  });
}

/** Уборка просроченных токенов — они больше ни на что не годны. */
export async function pruneMagicTokens(db: Db | DbClient, olderThan: Date): Promise<number> {
  const result = await db.query(`DELETE FROM magic_tokens WHERE expires_at < $1`, [olderThan]);
  return result.rowCount ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Сессии
// ─────────────────────────────────────────────────────────────────────────────

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
}

export async function createSession(
  db: Db | DbClient,
  input: { userId: string; deviceId: string; ttlSeconds: number },
  now: Date = new Date(),
): Promise<IssuedSession> {
  const refreshToken = randomToken(48);
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sessions (user_id, device_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.userId, input.deviceId, sha256Hex(refreshToken), expiresAt],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('не удалось создать сессию');
  return { sessionId: row.id, refreshToken, expiresAt };
}

export interface SessionRow {
  id: string;
  user_id: string;
  device_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export async function findSessionById(
  db: Db | DbClient,
  sessionId: string,
): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>(
    `SELECT id, user_id, device_id, expires_at, revoked_at FROM sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

export type RefreshResult =
  | { ok: true; session: SessionRow; refreshToken: string; expiresAt: Date }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired' };

/**
 * Ротация refresh-токена: старый гасится, выдаётся новый. Украденный токен
 * живёт до первого честного обновления, а не до конца TTL.
 */
export async function rotateRefreshToken(
  db: Db,
  refreshToken: string,
  ttlSeconds: number,
  now: Date = new Date(),
): Promise<RefreshResult> {
  const hash = sha256Hex(refreshToken);
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<SessionRow>(
      `SELECT id, user_id, device_id, expires_at, revoked_at
         FROM sessions WHERE refresh_token_hash = $1 FOR UPDATE`,
      [hash],
    );
    const session = rows[0];
    if (session === undefined) return { ok: false, reason: 'unknown' };
    if (session.revoked_at !== null) return { ok: false, reason: 'revoked' };
    if (session.expires_at.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };

    const next = randomToken(48);
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    await client.query(
      `UPDATE sessions
          SET refresh_token_hash = $2, last_used_at = $3, expires_at = $4
        WHERE id = $1`,
      [session.id, sha256Hex(next), now, expiresAt],
    );
    return { ok: true, session, refreshToken: next, expiresAt };
  });
}

export async function revokeByRefreshToken(
  db: Db | DbClient,
  refreshToken: string,
  reason = 'logout',
): Promise<boolean> {
  const result = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
    [sha256Hex(refreshToken), reason],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeSessionById(
  db: Db | DbClient,
  sessionId: string,
  reason = 'logout',
): Promise<boolean> {
  const result = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Отзыв всех сессий пользователя — «выйти на всех устройствах». */
export async function revokeAllSessions(db: Db | DbClient, userId: string): Promise<number> {
  const result = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout_all'
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return result.rowCount ?? 0;
}
