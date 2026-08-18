/**
 * MVP бесплатный: вошёл — синхронизируешься.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Человек впервые входил через Яндекс ID, приложение подключало Облако
 * Записок, и первая же отправка заметки упиралась в 402: подписки у нового
 * пользователя нет по определению, а право на запись выдавалось только по
 * подписке. На экране это выглядело так: «Подписка закончилась. Заметки на
 * месте, синхронизация приостановлена» — сообщение о конце того, что не
 * начиналось, у человека, который ничего не покупал и не собирался.
 *
 * ── Что должно быть ─────────────────────────────────────────────────────────
 *
 * Решение заказчика: на MVP всё бесплатно, оплату добавим потом. Значит право
 * на запись есть у каждого, кто вошёл, а разговор о тарифах не начинается
 * вовсе. Экраны тарифов при этом сохранены и просто спрятаны — их время
 * придёт.
 *
 * Здесь проверяется серверная половина: она главная, потому что 402 приходит
 * с сервера, и спрятать paywall в интерфейсе было бы недостаточно.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addDevice,
  createHarness,
  createUser,
  noDatabase,
  type Harness,
  type TestUser,
} from './helpers/app.ts';

describe.skipIf(noDatabase())('оплата выключена — облако работает у всех', () => {
  let harness: Harness;
  /** Человек, только что заведённый входом: подписки нет ни в каком виде. */
  let fresh: TestUser;

  beforeAll(async () => {
    /* Без `env`: харнесс поднимается ровно с теми умолчаниями, что и прод. */
    harness = await createHarness();
    fresh = await createUser(harness, { subscribed: false });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('первая же отправка заметки проходит, а не упирается в 402', async () => {
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/Первая заметка.md.enc',
      headers: { ...fresh.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('ZPSK зашифрованные байты'),
    });
    expect(response.statusCode, 'новый пользователь не смог синхронизироваться').toBe(200);
  });

  it('состояние счёта говорит, что денег мы не берём', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: fresh.authHeader,
    });
    const body = response.json() as { billingEnabled: boolean; canWrite: boolean; status: string };

    expect(body.billingEnabled, 'приложение решит, что тарифы надо показывать').toBe(false);
    expect(body.canWrite).toBe(true);
    /* Именно `none`, а не `expired`: подписки нет — но она и не кончалась. */
    expect(body.status).toBe('none');
  });

  it('история версий даётся по полному сроку, а не по урезанному', async () => {
    /* Срок хранения версий — часть тарифа: 30 дней пробный, 365 платный.
       Пока тарифов нет, урезать не за что: 365 всем. */
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: fresh.authHeader,
    });
    expect((response.json() as { versionRetentionDays: number }).versionRetentionDays).toBe(365);
  });

  it('пробный период не начать: у бесплатного продукта нечему истекать', async () => {
    /* Начатый «пробный период» на бесплатном продукте — это таймер, который
       однажды кончится и отберёт то, что ничего не стоило. */
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/billing/trial',
      headers: fresh.authHeader,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'billing_disabled' } });
  });

  it('платёж не создать: платить не за что', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/billing/tbank/payment',
      headers: { ...fresh.authHeader, 'content-type': 'application/json' },
      payload: { plan: 'monthly', returnUrl: 'https://zapiski.cmpas.ru/' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'billing_disabled' } });
  });

  it('публикация по ссылке тоже открыта', async () => {
    /* По ТЗ публикация — часть ЗАПИСКИ+. Пока платного нет, «часть платного»
       не означает «недоступно»: иначе бесплатный продукт молча урезан. */
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/publish',
      headers: { ...fresh.authHeader, 'content-type': 'application/json' },
      payload: { title: 'Открытая заметка', html: '<p>текст</p>' },
    });
    expect(response.statusCode).toBe(201);
  });
});

/**
 * Синхронизация между устройствами — по данным, а не по факту «сервер ответил
 * 200». Заказчик просил проверить именно это.
 */
describe.skipIf(noDatabase())('две машины одного человека видят одни заметки', () => {
  let harness: Harness;
  let user: TestUser;
  let second: { deviceId: string; authHeader: { authorization: string } };

  const NOTE = 'Дневник/Понедельник.md.enc';

  beforeAll(async () => {
    harness = await createHarness();
    /* Подписки нет намеренно: на MVP синхронизация обязана работать без неё. */
    user = await createUser(harness, { subscribed: false });
    second = await addDevice(harness, user, 'ноутбук-abcdef');
  });

  afterAll(async () => {
    await harness.close();
  });

  it('заметка с первого устройства доезжает на второе байт в байт', async () => {
    const payload = Buffer.from('ZPSK↦ зашифровано на телефоне', 'utf8');
    const sent = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/vault/blob/${NOTE}`,
      headers: {
        ...user.authHeader,
        'content-type': 'application/octet-stream',
        'x-device-id': user.deviceId,
      },
      payload,
    });
    expect(sent.statusCode).toBe(200);

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/manifest',
      headers: { ...second.authHeader, 'x-device-id': second.deviceId },
    });
    const entries = (listed.json() as { entries: Array<{ path: string; etag: string }> }).entries;
    expect(
      entries.map((entry) => entry.path),
      'второе устройство не видит заметку в списке',
    ).toContain(NOTE);

    const got = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/vault/blob/${NOTE}`,
      headers: { ...second.authHeader, 'x-device-id': second.deviceId },
    });
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(payload), 'на втором устройстве другие байты').toBe(true);
  });

  it('правка со второго устройства возвращается на первое', async () => {
    const first = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/vault/blob/${NOTE}`,
      headers: { ...second.authHeader, 'x-device-id': second.deviceId },
    });
    const etag = first.headers['etag'];
    expect(typeof etag).toBe('string');

    const edited = Buffer.from('ZPSK↦ дописано на ноутбуке', 'utf8');
    const written = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/vault/blob/${NOTE}`,
      headers: {
        ...second.authHeader,
        'content-type': 'application/octet-stream',
        'x-device-id': second.deviceId,
        'if-match': String(etag),
      },
      payload: edited,
    });
    expect(written.statusCode).toBe(200);

    const back = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/vault/blob/${NOTE}`,
      headers: { ...user.authHeader, 'x-device-id': user.deviceId },
    });
    expect(back.rawPayload.equals(edited), 'первое устройство осталось со старым текстом').toBe(
      true,
    );
  });

  it('одновременная правка не затирается молча', async () => {
    /* Оба устройства держат один и тот же etag и пишут по очереди. Второй
       обязан получить 412 и разбираться, а не выиграть гонку. ТЗ §2.1.4:
       конфликты не теряют данные — никогда. */
    const snapshot = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/vault/blob/${NOTE}`,
      headers: user.authHeader,
    });
    const stale = String(snapshot.headers['etag']);

    const winner = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/vault/blob/${NOTE}`,
      headers: {
        ...user.authHeader,
        'content-type': 'application/octet-stream',
        'if-match': stale,
      },
      payload: Buffer.from('ZPSK↦ правка телефона'),
    });
    expect(winner.statusCode).toBe(200);

    const loser = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/vault/blob/${NOTE}`,
      headers: {
        ...second.authHeader,
        'content-type': 'application/octet-stream',
        'if-match': stale,
      },
      payload: Buffer.from('ZPSK↦ правка ноутбука'),
    });
    expect(loser.statusCode, 'вторая правка молча затёрла первую').toBe(412);
  });
});
