/**
 * Бэкфилл `consent_updated` для аккаунтов, давших согласие ДО того, как
 * `POST /api/v1/auth/analytics-consent` начал его отправлять (E-Z3,
 * `migrations/0012_analytics_consent_backfill.sql`).
 *
 * Миграция уже применена ко всей тестовой базе (`globalSetup.ts` накатывает
 * `migrations/*.sql` один раз в начале прогона) — повторно вызвать раннер на
 * НОВЫХ данных, заведённых в ходе теста, нельзя (раннер помнит применённые
 * версии в `schema_migrations` и не повторяет их). Поэтому здесь выполняется
 * ТОТ ЖЕ SQL, прочитанный прямо из файла миграции (не переписанный вручную
 * литералом — иначе тест проверял бы не миграцию, а собственное
 * представление о ней), против данных, заведённых этим тестом.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';

const MIGRATION_PATH = path.resolve(
  fileURLToPath(new URL('../migrations/0012_analytics_consent_backfill.sql', import.meta.url)),
);

describe.skipIf(noDatabase())('бэкфилл consent_updated для ранее опт-ин аккаунтов (E-Z3)', () => {
  let harness: Harness;
  let sql: string;

  beforeAll(async () => {
    harness = await createHarness();
    sql = await readFile(MIGRATION_PATH, 'utf8');
  });
  afterAll(async () => harness.close());

  async function consentUpdatedRows(userId: string): Promise<{ props: Record<string, unknown> }[]> {
    const result = await harness.db.query<{ props: Record<string, unknown> }>(
      `SELECT props FROM analytics_events WHERE user_id = $1 AND event = 'consent_updated' ORDER BY id`,
      [userId],
    );
    return result.rows;
  }

  it('опт-ин аккаунт без строки consent_updated — получает её задним числом с granted:true', async () => {
    const user = await createUser(harness);
    await harness.db.query('UPDATE users SET analytics_opt_in = true WHERE id = $1', [user.userId]);

    await harness.db.query(sql);

    const rows = await consentUpdatedRows(user.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.props).toEqual({ granted: true });
  });

  it('аккаунт без согласия (analytics_opt_in = false, значение по умолчанию) — ничего не получает', async () => {
    const user = await createUser(harness);

    await harness.db.query(sql);

    expect(await consentUpdatedRows(user.userId)).toHaveLength(0);
  });

  it('опт-ин аккаунт, для которого consent_updated уже есть (например, дал согласие уже ПОСЛЕ E-Z3) — дубль не создаётся', async () => {
    const user = await createUser(harness);
    await harness.db.query('UPDATE users SET analytics_opt_in = true WHERE id = $1', [user.userId]);
    await harness.db.query(
      `INSERT INTO analytics_events (user_id, event, props, client_ts, event_id, schema_version)
       VALUES ($1, 'consent_updated', '{"granted": true}'::jsonb, now(), gen_random_uuid(), 1)`,
      [user.userId],
    );

    await harness.db.query(sql);

    expect(await consentUpdatedRows(user.userId)).toHaveLength(1); // не 2
  });

  it('идемпотентность: повторный прогон того же SQL не плодит дубли для уже забэкфиленных строк', async () => {
    const user = await createUser(harness);
    await harness.db.query('UPDATE users SET analytics_opt_in = true WHERE id = $1', [user.userId]);

    await harness.db.query(sql);
    await harness.db.query(sql); // второй раз — как если бы миграцию применили заново

    expect(await consentUpdatedRows(user.userId)).toHaveLength(1);
  });
});
