import type { Db, DbClient } from '../db/pool.ts';
import { upsertUserByEmail, type UserRow } from './accounts.ts';

/**
 * Связь аккаунта ЗАПИСОК с личностью единого входа СИМПАС (`auth.cmpas.ru`).
 *
 * ── Правило, которому здесь всё подчинено ────────────────────────────────
 *
 * Связывание — ТОЛЬКО добавление строки. Ни `UPDATE` по `users.id`, ни
 * удалений: это прямое требование рецепта интеграции (`compas-psy/auth`,
 * `docs/integration/zapiski.md`, шаг 2 и §5.3), и требование правильное.
 * Аккаунт человека уже существует, у него есть заметки, сессии и подписка;
 * переписать его идентичность под новый способ входа значит рискнуть всем
 * этим ради удобства реализации.
 *
 * ── Порядок поиска и почему он такой ─────────────────────────────────────
 *
 *   1. по `simpas_sub` — человек уже связан, это самый частый путь;
 *   2. по почте — человек существует, но входил Яндексом или по ссылке из
 *      письма; связь добавляется к его СУЩЕСТВУЮЩЕМУ аккаунту;
 *   3. никого нет — заводится новый.
 *
 * Второй шаг держится на том, что у нас уникальность почты объявлена
 * `CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email))` — то
 * есть без учёта регистра. Человек, у которого в СИМПАС записано `Ivan@ya.ru`,
 * а у нас `ivan@ya.ru`, найдётся как тот же самый, а не заведётся вторым.
 * Агент единого входа проверил это по нашему коду и отдельно отметил, что с
 * ПРАКТИКОЙ тот же вопрос до сих пор открыт.
 */

export interface SimpasIdentity {
  /** `sub` из id_token: устойчивый идентификатор человека в СИМПАС. */
  sub: string;
  /** Почта из id_token. Может отличаться регистром от нашей — это нормально. */
  email: string;
}

/** Кто это по `sub`. `null` — связи ещё нет. */
export async function findUserBySimpasSub(db: Db | DbClient, sub: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT u.id, u.email, u.yandex_id, u.analytics_opt_in, u.terms_version,
            u.terms_accepted_at, u.marketing_opt_in, u.created_at
       FROM simpas_links l
       JOIN users u ON u.id = l.user_id
      WHERE l.simpas_sub = $1
        AND u.deleted_at IS NULL`,
    [sub],
  );
  return rows[0] ?? null;
}

/**
 * Вход через единый СИМПАС: найти человека и связать, если ещё не связан.
 *
 * Возвращает аккаунт продукта. Существующий аккаунт при этом не меняется:
 * ни почта, ни `yandex_id`, ни согласия — добавляется только строка связи.
 */
export async function linkSimpasIdentity(
  db: Db | DbClient,
  identity: SimpasIdentity,
): Promise<UserRow> {
  const linked = await findUserBySimpasSub(db, identity.sub);
  if (linked !== null) return linked;

  /* Тот же `upsertUserByEmail`, что у Яндекса и у ссылки из письма: одна
     точка входа для «найти или завести по почте» — иначе три способа входа
     разошлись бы в мелочах вроде снятия `deleted_at`. */
  const user = await upsertUserByEmail(db, identity.email);

  /* `DO NOTHING` — из-за гонки: два устройства могут войти одновременно, и
     второй запрос обязан не упасть, а увидеть уже созданную связь. */
  await db.query(
    `INSERT INTO simpas_links (user_id, simpas_sub)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [user.id, identity.sub],
  );

  return user;
}
