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
