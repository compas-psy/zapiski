import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REGISTRY } from '../src/lib/messages.ts';
import { createHarness, noDatabase, type Harness } from './helpers/app.ts';

/**
 * ТЗ §5.5: magic-токен одноразовый, живёт 15 минут и привязан к устройству
 * инициации. Все три свойства проверяются здесь — это единственный путь входа
 * без Яндекса, и дыра в любом из них открывает чужой аккаунт.
 *
 * Дополнительно: SCREENS §2 — повторное письмо не раньше чем через 60 секунд.
 *
 * ── Про `format=json` ───────────────────────────────────────────────────────
 *
 * Ручку обмена зовут двое: ПРИЛОЖЕНИЕ (с `format=json`, ему нужен разбираемый
 * ответ) и БРАУЗЕР по ссылке из письма (без параметра — ссылку собирает
 * сервер). Ответы у них разные, и это не украшение: браузеру раньше
 * показывался голый JSON, а на успехе — собственные токены доступа человека
 * во весь экран. Поэтому ниже проверяются ОБА пути.
 */

describe.skipIf(noDatabase())('magic-link', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  async function requestLink(
    email: string,
    deviceId: string,
  ): Promise<{ status: number; token: string | null }> {
    harness.mailer.reset();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email, deviceId, platform: 'web', acceptedTerms: '2026-08-13' },
    });
    const sent = harness.mailer.last();
    const token =
      sent === undefined ? null : new URL(sent.url).searchParams.get('token');
    return { status: response.statusCode, token };
  }

  it('письмо уходит и ссылка обменивается на сессию', async () => {
    const email = `magic1.${process.pid}@example.test`;
    const { status, token } = await requestLink(email, 'device-magic-one');
    expect(status).toBe(202);
    expect(token).not.toBeNull();

    const callback = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=device-magic-one&format=json`,
    });
    expect(callback.statusCode).toBe(200);

    const body = callback.json() as { accessToken: string; user: { email: string } };
    expect(body.accessToken).toBeTruthy();
    expect(body.user.email).toBe(email);
  });

  it('токен одноразовый: второй переход по той же ссылке отклоняется', async () => {
    const email = `magic2.${process.pid}@example.test`;
    const { token } = await requestLink(email, 'device-magic-two');

    const first = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=device-magic-two&format=json`,
    });
    expect(first.statusCode).toBe(200);

    const second = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=device-magic-two&format=json`,
    });
    expect(second.statusCode).toBe(410);

    const error = second.json() as { error: { code: string; message: string } };
    expect(error.error.code).toBe('magic_link_used');
    // Текст — дословно из реестра BEHAVIOR §11.
    expect(error.error.message).toBe(REGISTRY.magicLinkExpired);
    expect(error.error.message).toBe('Ссылка больше не действует. Прислать новую?');
  });

  it('TTL 15 минут: через 15 минут и секунду ссылка не работает', async () => {
    const email = `magic3.${process.pid}@example.test`;
    const { token } = await requestLink(email, 'device-magic-three');

    // Ровно на границе ссылка ещё жива — двигаем часы за неё.
    harness.advance(15 * 60 * 1000 + 1000);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=device-magic-three&format=json`,
    });
    expect(response.statusCode).toBe(410);

    const error = response.json() as { error: { code: string; message: string } };
    expect(error.error.code).toBe('magic_link_expired');
    expect(error.error.message).toBe(REGISTRY.magicLinkExpired);
  });

  it('внутри TTL ссылка ещё жива', async () => {
    const email = `magic4.${process.pid}@example.test`;
    const { token } = await requestLink(email, 'device-magic-four');

    harness.advance(14 * 60 * 1000);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=device-magic-four&format=json`,
    });
    expect(response.statusCode).toBe(200);
  });

  it('привязка к устройству: ссылка не открывается на другом устройстве', async () => {
    const email = `magic5.${process.pid}@example.test`;
    const { token } = await requestLink(email, 'device-magic-five');

    const wrongDevice = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=device-magic-other&format=json`,
    });
    expect(wrongDevice.statusCode).toBe(410);
    const error = wrongDevice.json() as { error: { code: string; message: string } };
    expect(error.error.code).toBe('magic_link_device_mismatch');
    expect(error.error.message).toBe(REGISTRY.magicLinkExpired);

    // И при этом токен не сгорел — своё устройство им ещё воспользуется.
    const rightDevice = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=device-magic-five&format=json`,
    });
    expect(rightDevice.statusCode).toBe(200);
  });

  it('без device_id обмен не проходит', async () => {
    const email = `magic6.${process.pid}@example.test`;
    const { token } = await requestLink(email, 'device-magic-six');

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&format=json`,
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('device_id_required');
  });

  it('повторное письмо не чаще раза в 60 секунд (SCREENS §2)', async () => {
    const email = `magic7.${process.pid}@example.test`;
    const first = await requestLink(email, 'device-magic-seven');
    expect(first.status).toBe(202);

    harness.advance(30_000);
    const tooSoon = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email, deviceId: 'device-magic-seven', acceptedTerms: '2026-08-13' },
    });
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.headers['retry-after']).toBeDefined();
    expect((tooSoon.json() as { error: { message: string } }).error.message).toBe(
      REGISTRY.tooManyAttempts,
    );

    harness.advance(31_000);
    const allowed = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email, deviceId: 'device-magic-seven', acceptedTerms: '2026-08-13' },
    });
    expect(allowed.statusCode).toBe(202);
  });

  it('в письме нет пароля и нет ни слова про SMS (ТЗ §5.5)', async () => {
    const email = `magic8.${process.pid}@example.test`;
    await requestLink(email, 'device-magic-eight');
    const sent = harness.mailer.last();
    expect(sent).toBeDefined();

    const { renderMagicLink } = await import('../src/services/mailer.ts');
    const rendered = renderMagicLink({ to: email, url: sent!.url, ttlMinutes: 15 });
    const text = `${rendered.subject} ${rendered.text} ${rendered.html}`.toLowerCase();
    expect(text).not.toContain('пароль');
    expect(text).not.toContain('смс');
    expect(text).not.toContain('sms');
    expect(text).not.toContain('код из');
  });

  it('несуществующий токен даёт тот же текст реестра', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/auth/magic-link/callback?token=nosuchtokenatallnosuchtoken&device_id=device-magic-nine&format=json',
    });
    expect(response.statusCode).toBe(410);
    expect((response.json() as { error: { message: string } }).error.message).toBe(
      REGISTRY.magicLinkExpired,
    );
  });
});

/**
 * Возврат в приложение зависит от платформы, и это единственное место, где
 * разница между платформами узаконена. Она вынужденная: настольное окно не
 * может перехватить https-ссылку из письма — Windows отдаёт приложению только
 * его собственную схему. Поэтому Windows получает device_id прямо в ссылке и
 * возврат по `zapiski://`, а веб и Android — прежнюю строгую привязку.
 *
 * Тесты ниже стерегут ровно это: послабление не должно расползтись на другие
 * платформы, а строгость — не должна вернуться на настольную и снова оборвать
 * вход.
 */
describe.skipIf(noDatabase())('magic-link: возврат по платформам', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({
      env: {
        AUTH_SUCCESS_REDIRECT: 'https://zapiski.test/auth/callback',
        AUTH_SUCCESS_REDIRECT_DESKTOP: 'zapiski://auth/callback',
      },
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function linkFor(email: string, deviceId: string, platform: string): Promise<URL> {
    harness.mailer.reset();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email, deviceId, platform, acceptedTerms: '2026-08-13' },
    });
    expect(response.statusCode).toBe(202);
    const sent = harness.mailer.last();
    expect(sent).toBeDefined();
    return new URL(sent!.url);
  }

  it('ссылка для Windows замыкает вход СТРАНИЦЕЙ с переходом в приложение', async () => {
    const email = `magicwin.${process.pid}@example.test`;
    const url = await linkFor(email, 'device-magic-win', 'windows');
    expect(url.searchParams.get('device_id')).toBe('device-magic-win');

    // Браузер идёт по ссылке как есть — ни заголовка X-Device-Id, ни query
    // сверх того, что было в письме. Именно так это выглядит на Windows.
    const callback = await harness.app.inject({
      method: 'GET',
      url: `${url.pathname}${url.search}`,
    });

    /*
     * Не 302, а страница — и это ответ на жалобу «после перехода из письма
     * попадаешь на сайт, а не в приложение». Переход на `zapiski://` браузер
     * выполняет не всегда и молчит, когда не выполнил: после 302 не
     * происходит ровно ничего. Страница показывает, что вход состоялся, уходит
     * в приложение сама и оставляет кнопку на случай, если не ушла.
     */
    expect(callback.statusCode).toBe(200);
    expect(callback.headers['content-type']).toContain('text/html');
    /* Сессия в адресе — в кэш такой ответ класть нельзя. */
    expect(callback.headers['cache-control']).toContain('no-store');

    const body = callback.body;
    expect(body).toContain('http-equiv="refresh"');
    expect(body).toContain('zapiski://auth/callback#');
    expect(body).toContain('access_token=');
    /* Токены едут во фрагменте: он не уходит на сервер и не оседает в логах. */
    expect(body).not.toContain('callback?access_token');
  });

  it('ссылка для веба разменивается из браузера и ведёт на https', async () => {
    const email = `magicweb.${process.pid}@example.test`;
    const url = await linkFor(email, 'device-magic-web', 'web');

    /*
     * device_id теперь в ссылке на всех платформах — иначе вход по почте не
     * замыкается вовсе. Письмо открывает БРАУЗЕР, а `x-device-id` ставит
     * своим запросом приложение; при переходе из почты запрос делает браузер,
     * и заголовка в нём нет ни на одной платформе. Прежняя редакция клала
     * device_id только для Windows — и веб с Android упирались в
     * «Ссылка не сработала».
     */
    expect(url.searchParams.get('device_id')).toBe('device-magic-web');

    const opened = await harness.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(opened.statusCode).toBe(302);
    expect((opened.headers['location'] as string).startsWith('https://zapiski.test/auth/callback#')).toBe(
      true,
    );
  });

  it('ссылка для Android разменивается из браузера и уводит в приложение', async () => {
    const email = `magicdroid.${process.pid}@example.test`;
    const url = await linkFor(email, 'device-magic-droid', 'android');
    expect(url.searchParams.get('device_id')).toBe('device-magic-droid');

    /*
     * Ровно тот путь, который был у заказчика: App Links не подтверждены,
     * ссылку открывает Chrome, заголовка у него нет. Раньше здесь был отказ.
     */
    const opened = await harness.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(opened.statusCode).toBe(200);
    expect(opened.body).toContain('zapiski://auth/callback#');
  });

  it('ссылка одноразовая: второй переход уже не входит', async () => {
    /* Привязка к устройству инициации ушла вместе с device_id в ссылке, и это
       названо вслух. Значит одноразовость — то, что осталось охранять, и она
       обязана быть проверена, а не подразумеваться. */
    const email = `magiconce.${process.pid}@example.test`;
    const url = await linkFor(email, 'device-magic-once', 'web');

    const first = await harness.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(first.statusCode).toBe(302);

    const second = await harness.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(second.statusCode).toBe(410);
  });

  it('подменённый device_id не входит: токен привязан к своему', async () => {
    /* Ссылку с ПОДМЕНЁННЫМ идентификатором сервер по-прежнему отвергает.
       Ослабление ровно одно и названо: device_id уехал в саму ссылку. Всё
       остальное осталось на месте — и вот это «остальное» здесь и стережётся. */
    const email = `magicwin2.${process.pid}@example.test`;
    const url = await linkFor(email, 'device-magic-win-2', 'windows');
    url.searchParams.set('device_id', 'device-someone-else');

    const stolen = await harness.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(stolen.statusCode).toBe(410);
  });

  it('format=json перебивает редирект: так ходит само приложение', async () => {
    const email = `magicjson.${process.pid}@example.test`;
    const url = await linkFor(email, 'device-magic-json', 'windows');

    const response = await harness.app.inject({
      method: 'GET',
      url: `${url.pathname}${url.search}&format=json`,
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { accessToken: string }).accessToken).toBeTruthy();
  });
});

/**
 * Что видит ЧЕЛОВЕК, а не приложение.
 *
 * Ссылку из письма открывает браузер, и всё, что ответит сервер, показывается
 * на весь экран. Отвечал он JSON: на мёртвой ссылке —
 * `{"error":{"code":"magic_link_expired"…}}`, а на успехе без настроенного
 * адреса возврата — собственные токены доступа человека. Заказчик описал это
 * как «авторизация через email в принципе ничего не делает»: она делала и
 * говорила об этом на машинном языке.
 *
 * Свой стенд, потому что у входа отдельный, более жёсткий лимит запросов
 * (20 за 5 минут), и эти проверки не должны его доедать за соседями.
 */
describe.skipIf(noDatabase())('magic-link: страница вместо JSON', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  async function requestLink(email: string, deviceId: string): Promise<string> {
    harness.mailer.reset();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email, deviceId, platform: 'web', acceptedTerms: '2026-08-13' },
    });
    expect(response.statusCode).toBe(202);
    const sent = harness.mailer.last();
    expect(sent).toBeDefined();
    return new URL(sent!.url).searchParams.get('token') as string;
  }

  /**
   * Тот же отказ, но открытый БРАУЗЕРОМ.
   *
   * Заказчик: «авторизация через email в принципе ничего не делает». Она
   * делала — и говорила об этом на машинном языке: по мёртвой ссылке из письма
   * человек получал на весь экран `{"error":{"code":"magic_link_expired"…}}`.
   * Прочитать это нельзя, сделать по этому нечего.
   */
  it('по мёртвой ссылке из письма браузер получает страницу, а не JSON', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/auth/magic-link/callback?token=nosuchtokenatallnosuchtoken&device_id=device-magic-ten',
    });
    /* Код ответа прежний: тот, кто зовёт ручку программой, разбирает его
       так же, как раньше. Меняется только то, что видит человек. */
    expect(response.statusCode).toBe(410);
    expect(response.headers['content-type']).toContain('text/html');
    /* Текст — из того же реестра BEHAVIOR §11, что и в приложении. */
    expect(response.body).toContain(REGISTRY.magicLinkExpired);
    expect(response.body, 'человеку показали машинный код').not.toContain('magic_link_expired');
    /* И дорога назад: иначе страница — тупик. */
    expect(response.body).toContain('Открыть ЗАПИСКИ');
    /* Корень домена отдан промо (решение учредителя) — кнопка обязана вести
       на само приложение, /notes/, а не на промо-страницу. */
    expect(response.body).toMatch(/href="[^"]*\/notes\/"/);
  });

  /**
   * Успех без настроенного адреса возврата.
   *
   * Здесь `reply.send(session)` печатал человеку на весь экран его
   * собственные токены доступа. Экран фотографируют, вкладку показывают
   * коллеге, адрес попадает в историю — показывать их нельзя никогда.
   */
  it('успех в браузере не печатает токены', async () => {
    const email = `magic10.${process.pid}@example.test`;
    const token = await requestLink(email, 'device-magic-eleven');

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token)}&device_id=device-magic-eleven`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body, 'токен доступа показан человеку').not.toContain('accessToken');
    expect(response.body).not.toContain('eyJ');
  });
});
