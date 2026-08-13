import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, noDatabase, type Harness } from './helpers/app.ts';

/**
 * `GET /api/v1/auth/methods` — какие способы входа сервер реально умеет.
 *
 * Заведён после жалобы «вход через Яндекс не работает». Приложение показывало
 * кнопку всегда и по нажатию уводило человека в СИСТЕМНЫЙ БРАУЗЕР — а там,
 * если у сервера нет client_id, лежит голый JSON `404 yandex_not_configured`.
 * Человек возвращался ни с чем и без единого слова о причине.
 *
 * Ответ обязан быть доступен без входа: его спрашивают ровно затем, чтобы
 * решить, показывать ли кнопку входа.
 */
describe.skipIf(noDatabase())('способы входа', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('отвечает без аутентификации', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/auth/methods' });
    expect(response.statusCode).toBe(200);
  });

  it('без ключей Яндекса честно говорит «нет»', async () => {
    /* Стенд поднимается без YANDEX_CLIENT_ID — тот же случай, что на сервере
       до регистрации приложения в Яндекс OAuth. */
    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/auth/methods' });
    expect(response.json()).toEqual({ yandex: false });
  });

  it('в ответе нет ни ключей, ни адресов', async () => {
    /* Только факт наличия: эндпоинт открытый, и всё лишнее в нём — утечка. */
    const { body } = await harness.app.inject({ method: 'GET', url: '/api/v1/auth/methods' });
    expect(body).not.toContain('client');
    expect(body).not.toContain('secret');
    expect(body).not.toContain('redirect');
  });

  it('старт входа без настроенного Яндекса отвечает 404, а не падает', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/auth/yandex?device_id=test-device',
    });
    expect(response.statusCode).toBe(404);
  });
});

/**
 * Перебор попыток входа обязан отвечать «подождите», а не «сейчас не
 * получилось».
 *
 * У входа свой, более жёсткий лимит: 20 запросов за 5 минут. Ограничитель
 * получал `errorResponseBuilder: () => errors.tooManyAttempts(30).toBody()` —
 * то есть ПРОСТОЙ ОБЪЕКТ, а плагин делает `throw` того, что вернули. Наш
 * обработчик ошибок узнаёт ответ по `instanceof ApiError`, простой объект не
 * узнавал и отвечал 500 «Сейчас не получилось. Попробуйте ещё раз» — без
 * `retry-after` и без единого намёка, что надо просто подождать.
 *
 * Било это ровно по тому месту, на которое жаловался заказчик: человек,
 * который несколько раз подряд попросил письмо (а он просит, когда письмо не
 * пришло), получал не «подождите», а «сейчас не получилось». Вход переставал
 * работать именно тогда, когда человек старался.
 */
describe.skipIf(noDatabase())('перебор попыток входа', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('на 21-й попытке — 429 с текстом реестра и retry-after', async () => {
    let limited: Awaited<ReturnType<typeof harness.app.inject>> | null = null;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link',
        payload: {
          email: `flood${attempt}.${process.pid}@example.test`,
          deviceId: 'device-flood-one',
          platform: 'web',
          acceptedTerms: '2026-08-13',
        },
      });
      if (response.statusCode !== 202) {
        limited = response;
        break;
      }
    }

    expect(limited, 'ограничитель не сработал за 25 попыток').not.toBeNull();
    expect(limited!.statusCode, 'перебор ответил не «подождите», а поломкой').toBe(429);
    expect(limited!.headers['retry-after']).toBeDefined();
    const body = limited!.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('too_many_attempts');
    expect(body.error.message).toBe('Попробуйте через 30 секунд');
  });
});
