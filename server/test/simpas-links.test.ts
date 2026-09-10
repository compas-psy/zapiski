/**
 * Связывание аккаунта с личностью единого входа СИМПАС.
 *
 * Проверяется главное требование рецепта интеграции: связывание НИЧЕГО не
 * ломает у человека, который уже пользуется продуктом. У него есть заметки,
 * сессии и подписка — и они привязаны к `users.id`. Любая правка этого
 * идентификатора или удаление строки унесли бы всё это с собой, поэтому
 * связывание обязано быть только добавлением.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, noDatabase, type Harness } from './helpers/app.ts';
import { upsertUserByEmail } from '../src/services/accounts.ts';
import { findUserBySimpasSub, linkSimpasIdentity } from '../src/services/simpasLinks.ts';

describe.skipIf(noDatabase())('единый вход СИМПАС: связывание', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('незнакомый sub — заводится аккаунт и связь', async () => {
    const user = await linkSimpasIdentity(harness.db, {
      sub: 'simpas-новый-1',
      email: 'novichok@ya.ru',
    });

    expect(user.email).toBe('novichok@ya.ru');
    const found = await findUserBySimpasSub(harness.db, 'simpas-новый-1');
    expect(found?.id).toBe(user.id);
  });

  it('существующий человек НЕ пересоздаётся — связь добавляется к его аккаунту', async () => {
    const before = await upsertUserByEmail(harness.db, 'marina@ya.ru');

    const after = await linkSimpasIdentity(harness.db, {
      sub: 'simpas-marina',
      email: 'marina@ya.ru',
    });

    /* Тот же `users.id` — значит заметки, сессии и подписка остались его. */
    expect(after.id, 'аккаунт подменён другим — это унесло бы все его данные').toBe(before.id);
  });

  it('почта с другим регистром находит того же человека, а не заводит второго', async () => {
    const before = await upsertUserByEmail(harness.db, 'ivan@ya.ru');

    const after = await linkSimpasIdentity(harness.db, {
      sub: 'simpas-ivan',
      email: 'Ivan@YA.ru',
    });

    expect(after.id, 'завёлся второй аккаунт на ту же почту').toBe(before.id);
  });

  it('повторный вход тем же sub ничего не меняет', async () => {
    const first = await linkSimpasIdentity(harness.db, {
      sub: 'simpas-повтор',
      email: 'povtor@ya.ru',
    });
    const second = await linkSimpasIdentity(harness.db, {
      sub: 'simpas-повтор',
      email: 'povtor@ya.ru',
    });

    expect(second.id).toBe(first.id);
    const { rows } = await harness.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM simpas_links WHERE simpas_sub = $1`,
      ['simpas-повтор'],
    );
    expect(rows[0]?.count, 'связь задвоилась').toBe('1');
  });

  it('yandex_id и почта существующего аккаунта не переписываются', async () => {
    const before = await upsertUserByEmail(harness.db, 'oleg@ya.ru');
    await harness.db.query(`UPDATE users SET yandex_id = $1 WHERE id = $2`, ['ya-777', before.id]);

    await linkSimpasIdentity(harness.db, { sub: 'simpas-oleg', email: 'oleg@ya.ru' });

    const { rows } = await harness.db.query<{ email: string; yandex_id: string | null }>(
      `SELECT email, yandex_id FROM users WHERE id = $1`,
      [before.id],
    );
    expect(rows[0]?.yandex_id, 'прежний способ входа затёрт — человек его потеряет').toBe('ya-777');
    expect(rows[0]?.email).toBe('oleg@ya.ru');
  });

  it('чужой sub не отдаёт чужой аккаунт', async () => {
    await linkSimpasIdentity(harness.db, { sub: 'simpas-свой', email: 'svoi@ya.ru' });

    expect(await findUserBySimpasSub(harness.db, 'simpas-чужой')).toBeNull();
  });
});
