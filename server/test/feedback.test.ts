/**
 * Обращения из беты на сервере.
 *
 * ── Почему проверки разделены надвое ────────────────────────────────────────
 *
 * Наборы с Postgres помечаются `skipIf(noDatabase())` и в окружении без базы
 * молча пропускаются. Для двух вещей такой пропуск недопустим, потому что
 * ошибка в них видна не в тесте, а в утечке:
 *
 *   · выдача обращений не пускает без сервисного токена, и особенно — когда
 *     токен вообще не задан в окружении;
 *   · схема тела строгая, то есть лишний ключ отвергается целиком, а не
 *     складывается в базу «на всякий случай».
 *
 * Поэтому обе вынесены в чистые функции и проверяются без базы. Остальное —
 * вставка, идемпотентность, статус `new`, выборка `since` — требует настоящего
 * Postgres, и там пропуск честен: он ничего не скрывает, кроме себя.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { feedbackBody, serviceTokenAccepted } from '../src/routes/feedback.ts';
import { createHarness, noDatabase, type Harness } from './helpers/app.ts';

const TOKEN = 'сервисный-токен-ночного-цикла-1234567890';

describe('выдача обращений закрыта по умолчанию', () => {
  it('токен не задан в окружении — не пускаем никого', () => {
    expect(serviceTokenAccepted(undefined, `Bearer ${TOKEN}`)).toBe(false);
    expect(serviceTokenAccepted('', `Bearer ${TOKEN}`)).toBe(false);
    /* Самый опасный случай: пустая настройка и пустой заголовок. Наивная
       проверка «совпадает ли» ответила бы здесь «да». */
    expect(serviceTokenAccepted('', 'Bearer ')).toBe(false);
    expect(serviceTokenAccepted(undefined, undefined)).toBe(false);
  });

  it('токен задан — пускаем только по нему', () => {
    expect(serviceTokenAccepted(TOKEN, `Bearer ${TOKEN}`)).toBe(true);
    expect(serviceTokenAccepted(TOKEN, `Bearer ${TOKEN}x`)).toBe(false);
    expect(serviceTokenAccepted(TOKEN, TOKEN)).toBe(false);
    expect(serviceTokenAccepted(TOKEN, 'Bearer ')).toBe(false);
    expect(serviceTokenAccepted(TOKEN, 42)).toBe(false);
  });
});

describe('схема тела не пускает лишнего', () => {
  const valid = {
    id: '11111111-2222-4333-8444-555555555555',
    createdAt: 1_786_900_000_000,
    kind: 'broken' as const,
    text: 'Кнопка отправки не срабатывает',
    entry: 'menu' as const,
  };

  it('обязательный минимум принимается', () => {
    expect(feedbackBody.safeParse(valid).success).toBe(true);
  });

  it('посторонний ключ отвергает всё обращение', () => {
    /* Именно отвергает, а не срезает: незнакомое поле — самый вероятный путь,
       которым однажды приедет заголовок заметки, и увидеть это надо сразу. */
    const withExtra = { ...valid, lastNote: 'Клиенты/Смирнова А.md' };
    expect(feedbackBody.safeParse(withExtra).success).toBe(false);
  });

  it('код ошибки обязан быть кодом', () => {
    expect(
      feedbackBody.safeParse({ ...valid, diagnostics: { errorCodes: ['SYNC_CONFLICT'] } }).success,
    ).toBe(true);
    expect(
      feedbackBody.safeParse({
        ...valid,
        diagnostics: { errorCodes: ['read /vault/Личное/Дневник.md'] },
      }).success,
    ).toBe(false);
  });

  it('размер хранилища принимается только корзиной', () => {
    expect(feedbackBody.safeParse({ ...valid, diagnostics: { notes: '<100' } }).success).toBe(true);
    expect(feedbackBody.safeParse({ ...valid, diagnostics: { notes: 412 } }).success).toBe(false);
  });
});

describe.skipIf(noDatabase())('приём и выдача обращений', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ env: { FEEDBACK_SERVICE_TOKEN: TOKEN } });
    await harness.db.query('DELETE FROM feedback');
  });

  afterAll(async () => {
    await harness.close();
  });

  /*
   * Ответ достаётся из `await`, а не возвращается напрямую: `inject` объявлен
   * как объединение «промис ответа» и цепочки-строителя, и из него TypeScript
   * `statusCode` не выводит. Тело приводится к объекту, потому что часть
   * проверок нарочно шлёт заведомо неверное — на то они и проверки.
   */
  async function post(body: unknown) {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/feedback',
      payload: body as object,
    });
    return response;
  }

  it('обращение принимается без аккаунта и получает статус new', async () => {
    const id = randomUUID();
    const response = await post({
      id,
      createdAt: Date.now(),
      kind: 'broken',
      text: 'Поиск не находит заметку по слову из заголовка',
      entry: 'menu',
      diagnostics: { version: '0.1.0', platform: 'android', notes: '<100', encryption: true },
    });

    expect(response.statusCode).toBe(202);

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/feedback',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(listed.statusCode).toBe(200);
    const items = (listed.json() as { items: Array<{ id: string; status: string }> }).items;
    const found = items.find((item) => item.id === id);
    expect(found, 'обращение не видно в выдаче ночного цикла').toBeDefined();
    expect(found?.status).toBe('new');
  });

  it('досылка того же обращения не заводит второе', async () => {
    const id = randomUUID();
    const body = {
      id,
      createdAt: Date.now(),
      kind: 'awkward' as const,
      text: 'Панель форматирования закрывает текст',
      entry: 'menu' as const,
    };

    expect((await post(body)).statusCode).toBe(202);
    expect((await post(body)).statusCode).toBe(202);

    const rows = await harness.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM feedback WHERE id = $1',
      [id],
    );
    expect(rows.rows[0]?.count, 'повторная досылка удвоила обращение').toBe('1');
  });

  it('без токена выдача не отвечает содержимым', async () => {
    const listed = await harness.app.inject({ method: 'GET', url: '/api/v1/feedback' });
    expect(listed.statusCode).toBe(401);
    expect(listed.body).not.toContain('Панель форматирования');
  });

  it('чужой токен тоже не пускает', async () => {
    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/feedback',
      headers: { authorization: 'Bearer не-тот-токен-не-тот-токен-1234' },
    });
    expect(listed.statusCode).toBe(401);
  });

  it('since отдаёт только то, что пришло после отметки', async () => {
    const mark = new Date().toISOString();
    const id = randomUUID();
    await post({
      id,
      createdAt: Date.now(),
      kind: 'other',
      text: 'Пришло после отметки',
      entry: 'menu',
    });

    const listed = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/feedback?since=${encodeURIComponent(mark)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const items = (listed.json() as { items: Array<{ id: string }> }).items;

    expect(items.map((item) => item.id)).toContain(id);
    expect(items, 'выборка «с отметки» вернула всё подряд').toHaveLength(1);
  });

  it('обращение с посторонним ключом не сохраняется вовсе', async () => {
    const id = randomUUID();
    const response = await post({
      id,
      createdAt: Date.now(),
      kind: 'broken',
      text: 'Обычная жалоба',
      entry: 'menu',
      lastNote: 'Клиенты/Смирнова А.md',
    });

    expect(response.statusCode).toBe(400);
    const rows = await harness.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM feedback WHERE id = $1',
      [id],
    );
    expect(rows.rows[0]?.count).toBe('0');
  });
});
