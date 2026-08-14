import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, noDatabase, type Harness } from './helpers/app.ts';

/**
 * Два согласия при регистрации.
 *
 * Заказчик: «Мне нужно собирать согласия на рекламу (отдельное согласие,
 * непреднажатое и необязательное) и обработку ПДн (пользовательское
 * соглашение)».
 *
 * Здесь стережётся ровно то, что делает эти согласия настоящими, а не
 * галочками для вида:
 *
 *   · без согласия на обработку ПДн аккаунта НЕТ — запрос отклоняется;
 *   · рекламное согласие ОТДЕЛЬНОЕ: не дали — значит `false`, а не «в
 *     нагрузку» к обязательному;
 *   · молчание согласием не является: поле не прислали — считается отказ;
 *   · согласие ОТЗЫВАЕТСЯ в любой момент, иначе это не согласие;
 *   · хранится РЕДАКЦИЯ документа: согласие даётся на конкретный текст.
 */
describe.skipIf(noDatabase())('согласия при входе', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  const TERMS = '2026-08-13';

  /** Пройти вход до конца и вернуть access-токен. */
  async function signIn(
    email: string,
    device: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    harness.mailer.reset();
    const asked = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email, deviceId: device, platform: 'web', acceptedTerms: TERMS, ...extra },
    });
    expect(asked.statusCode).toBe(202);
    const token = new URL(harness.mailer.last()!.url).searchParams.get('token');
    const done = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=${device}&format=json`,
    });
    expect(done.statusCode).toBe(200);
    return (done.json() as { accessToken: string }).accessToken;
  }

  const me = async (accessToken: string): Promise<Record<string, unknown>> => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Record<string, unknown>;
  };

  it('без согласия на обработку ПДн аккаунт не заводится', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: {
        email: `noconsent.${process.pid}@example.test`,
        deviceId: 'device-consent-none',
        platform: 'web',
      },
    });
    expect(response.statusCode, 'аккаунт завели без согласия на обработку ПДн').toBe(400);
    expect(harness.mailer.last(), 'письмо ушло без согласия').toBeUndefined();
  });

  it('редакция соглашения сохраняется, а не просто факт «да»', async () => {
    const token = await signIn(`terms.${process.pid}@example.test`, 'device-consent-terms');
    const profile = await me(token);
    expect(profile['termsVersion']).toBe(TERMS);
    expect(profile['termsAcceptedAt'], 'момент согласия не записан').toBeTruthy();
  });

  it('рекламное согласие не даётся молчанием', async () => {
    /* Поле не прислали вовсе — это отказ, а не «ну наверное да». */
    const token = await signIn(`silent.${process.pid}@example.test`, 'device-consent-silent');
    expect((await me(token))['marketingOptIn']).toBe(false);
  });

  it('рекламное согласие даётся отдельно и записывается', async () => {
    const token = await signIn(`ads.${process.pid}@example.test`, 'device-consent-ads', {
      marketingOptIn: true,
    });
    expect((await me(token))['marketingOptIn']).toBe(true);
  });

  it('рекламное согласие отзывается — иначе это не согласие', async () => {
    const token = await signIn(`revoke.${process.pid}@example.test`, 'device-consent-revoke', {
      marketingOptIn: true,
    });
    expect((await me(token))['marketingOptIn']).toBe(true);

    const off = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/marketing-consent',
      headers: { authorization: `Bearer ${token}` },
      payload: { optIn: false },
    });
    expect(off.statusCode).toBe(200);
    expect((await me(token))['marketingOptIn'], 'отзыв не сработал').toBe(false);

    /* И обратно: передумать человек тоже вправе. */
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/marketing-consent',
      headers: { authorization: `Bearer ${token}` },
      payload: { optIn: true },
    });
    expect((await me(token))['marketingOptIn']).toBe(true);
  });

});

/**
 * Продолжение того же разбора, но своим стендом: у входа лимит 20 запросов за
 * 5 минут, и проверки согласий не должны доедать его друг у друга.
 */
describe.skipIf(noDatabase())('согласия: отзыв и доступ', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  const TERMS = '2026-08-13';

  async function signIn(
    email: string,
    device: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    harness.mailer.reset();
    const asked = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email, deviceId: device, platform: 'web', acceptedTerms: TERMS, ...extra },
    });
    expect(asked.statusCode).toBe(202);
    const token = new URL(harness.mailer.last()!.url).searchParams.get('token');
    const done = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=${device}&format=json`,
    });
    expect(done.statusCode).toBe(200);
    return (done.json() as { accessToken: string }).accessToken;
  }

  const me = async (accessToken: string): Promise<Record<string, unknown>> => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Record<string, unknown>;
  };

  it('отзыв рекламного не трогает обязательное', async () => {
    /* Разные согласия — разные судьбы. Отказ от рассылки не должен выбрасывать
       человека из аккаунта: обработка ПДн остаётся принятой. */
    const token = await signIn(`both.${process.pid}@example.test`, 'device-consent-both', {
      marketingOptIn: true,
    });
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/marketing-consent',
      headers: { authorization: `Bearer ${token}` },
      payload: { optIn: false },
    });
    const profile = await me(token);
    expect(profile['termsVersion']).toBe(TERMS);
    expect(profile['marketingOptIn']).toBe(false);
  });

  it('согласие на рекламу без входа не меняется', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/marketing-consent',
      payload: { optIn: true },
    });
    expect(response.statusCode).toBe(401);
  });
});

/**
 * Документы, на которые даётся согласие, обязаны открываться.
 *
 * Ссылка с экрана входа ведёт на `/terms` и `/privacy`. Если по ней ничего не
 * открывается, согласие даётся вслепую — а такое согласие не имеет силы. Плюс
 * страницу отдаёт API, а не статика: текст правится без выпуска новой версии
 * приложения, и человек со старой сборкой обязан читать действующую редакцию.
 */
describe.skipIf(noDatabase())('документы для согласий', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  for (const [path, needle] of [
    ['/terms', 'Пользовательское соглашение'],
    ['/privacy', 'Политика обработки персональных данных'],
  ] as const) {
    it(`${path} открывается страницей, а не JSON`, async () => {
      const response = await harness.app.inject({ method: 'GET', url: path });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain(needle);
      /* Пакет помечен как рабочая редакция, и страница обязана говорить это
         вслух: документ, который выглядит утверждённым, не будучи им, —
         обман. Реквизиты Оператора в тексте — плейсхолдеры, заполнить их
         может только владелец. */
      expect(response.body).toContain('Рабочая редакция');
    });
  }

  it('без входа и без согласия — документы всё равно доступны', async () => {
    /* Прочитать условия человек обязан ДО того, как согласится: требовать
       вход ради текста соглашения — замкнутый круг. */
    const response = await harness.app.inject({ method: 'GET', url: '/privacy' });
    expect(response.statusCode).toBe(200);
  });

  it('политика перечисляет ровно то, что собирается', async () => {
    /* Сторож против расхождения документа с кодом: если появится сбор чего-то
       ещё, эта проверка не поймает его сама — но поймает попытку выкинуть из
       текста то, что собирается сейчас. */
    const response = await harness.app.inject({ method: 'GET', url: '/privacy' });
    /*
     * Список сверен с ПАКЕТОМ v0.9, а не с прежним черновиком. «Яндекс ID»
     * центральная Политика по имени не называет — она говорит о параметрах
     * входа и сессии в целом. Это расхождение вынесено владельцу как факт
     * (§18: фактические провайдеры входа сверяются перед публикацией v1.0), а
     * не залатано правкой документа: править текст пакета запрещено (§21).
     */
    for (const item of ['email', 'устройство/браузер', 'параметры входа и сессии']) {
      expect(response.body, `в политике не упомянуто: ${item}`).toContain(item);
    }
    /*
     * Прежний черновик обещал отдельной строкой: «Телефон не запрашивается».
     * В центральной Политике пакета телефон стоит в категориях данных наравне
     * с почтой — она написана на всю Экосистему, а телефон может собирать
     * другой её сервис. ЗАПИСКИ не спрашивают его нигде и не могут: путей с
     * СМС нет по ТЗ §5.5, и это стережёт инвариант 6 в приложении.
     *
     * Расхождение зафиксировано как факт для владельца (§18), а не залатано
     * правкой документа: править текст пакета запрещено (§21).
     */
  });

  it('стиль страницы не режется политикой безопасности', async () => {
    /* `default-src 'none'` блокирует инлайновый `<style>`, и документ
       приезжает голым текстом — работает, но выглядит поломкой продукта. */
    const response = await harness.app.inject({ method: 'GET', url: '/terms' });
    expect(response.headers['content-security-policy']).toContain("style-src 'unsafe-inline'");
    /* Скрипты при этом по-прежнему запрещены: послабление ровно одно. */
    expect(response.headers['content-security-policy']).not.toContain('script-src');
  });
});
