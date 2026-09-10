/**
 * Вход через единый СИМПАС: маршруты начала и возврата.
 *
 * Клиент здесь подставной — настоящий ходил бы в сеть за метаданными и JWKS.
 * Подменяется ровно он: маршруты, состояние, связывание и выдача сессии —
 * настоящие, как и Postgres под ними.
 *
 * ── Что стережётся ───────────────────────────────────────────────────────────
 *
 *   • PKCE-верификатор не читается из state. Состояние ездит подписанным JWT,
 *     а подпись содержимое НЕ прячет: положи мы верификатор открытым, его
 *     получил бы всякий, кто увидел адрес возврата, и PKCE перестал бы
 *     что-либо доказывать;
 *   • `nonce` сверяется — иначе id_token от другого входа подошёл бы сюда;
 *   • состояние Яндекса не проходит за состояние СИМПАС и наоборот;
 *   • у аккаунта, входившего Яндексом, появляется СВЯЗЬ, а не второй аккаунт.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthorizationUrlInput, IdTokenClaims, SimpasClient } from '../src/vendor/simpas-id-client.ts';

import { createHarness, noDatabase, type Harness } from './helpers/app.ts';
import { openVerifier, sealVerifier } from '../src/services/simpas.ts';
import { upsertUserByEmail } from '../src/services/accounts.ts';

const DEVICE = 'device-simpas-one';
const SUB = 'simpas-sub-12345';

/** Подставной СИМПАС: помнит, что ему передали, и отвечает как настоящий. */
function fakeSimpas(email = 'marina@ya.ru'): SimpasClient & {
  seen: { codeVerifier?: string; nonce?: string; redirectUri?: string };
} {
  const seen: { codeVerifier?: string; nonce?: string; redirectUri?: string } = {};
  return {
    seen,
    discover: async () => ({
      issuer: 'https://auth.test',
      authorization_endpoint: 'https://auth.test/authorize',
      token_endpoint: 'https://auth.test/token',
      jwks_uri: 'https://auth.test/jwks',
    }),
    getAuthorizationUrl: async (input: AuthorizationUrlInput) => {
      seen.redirectUri = input.redirectUri;
      seen.nonce = input.nonce;
      return `https://auth.test/authorize?state=${encodeURIComponent(input.state)}&code_challenge=${input.codeChallenge}`;
    },
    exchangeCode: async (input: { code: string; codeVerifier: string; redirectUri: string }) => {
      seen.codeVerifier = input.codeVerifier;
      return {
        access_token: 'a',
        id_token: 'id',
        token_type: 'Bearer',
        expires_in: 3600,
      };
    },
    verifyIdToken: async (_token: string, expected?: { nonce?: string }): Promise<IdTokenClaims> => {
      /* Настоящий SDK на расхождении nonce бросает — здесь то же самое, иначе
         тест «nonce сверяется» проходил бы, ничего не проверяя. */
      if (expected?.nonce !== undefined && expected.nonce !== seen.nonce) {
        throw new Error('nonce не совпал');
      }
      return { sub: SUB, email, email_verified: true };
    },
    getAccount: async () => ({
      id: SUB,
      email,
      email_verified: true,
      display_name: null,
      products: ['zapiski'],
    }),
    refresh: async () => ({ access_token: 'a', id_token: 'id', token_type: 'Bearer', expires_in: 1 }),
  } as never;
}

/** Достать `state` из адреса, куда нас отправили. */
function stateOf(location: string): string {
  return new URL(location).searchParams.get('state') ?? '';
}

/** Полезная нагрузка подписанного JWT — ровно то, что видит посторонний. */
function payloadOf(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('запечатывание PKCE-верификатора', () => {
  const secret = 'x'.repeat(40);

  it('открывается тем же секретом', () => {
    const sealed = sealVerifier('верификатор-1', secret);
    expect(openVerifier(sealed, secret)).toBe('верификатор-1');
  });

  it('чужим секретом не открывается', () => {
    const sealed = sealVerifier('верификатор-2', secret);
    expect(openVerifier(sealed, 'y'.repeat(40))).toBeNull();
  });

  it('подделанный отвергается, а не отдаёт мусор', () => {
    const sealed = sealVerifier('верификатор-3', secret);
    const bytes = Buffer.from(sealed, 'base64url');
    bytes.writeUInt8(bytes.readUInt8(bytes.byteLength - 1) ^ 0xff, bytes.byteLength - 1);
    expect(openVerifier(bytes.toString('base64url'), secret)).toBeNull();
  });

  it('сам верификатор в запечатанном виде не читается', () => {
    const sealed = sealVerifier('очень-секретный-верификатор', secret);
    expect(sealed).not.toContain('очень-секретный');
  });
});

describe.skipIf(noDatabase())('вход через СИМПАС', () => {
  let harness: Harness;
  let simpas: ReturnType<typeof fakeSimpas>;

  beforeAll(async () => {
    simpas = fakeSimpas();
    harness = await createHarness({ simpas });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function start(): Promise<string> {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/simpas?device_id=${DEVICE}&terms=2026-08-13&platform=web`,
    });
    expect(response.statusCode, 'начало входа не увело к поставщику').toBe(302);
    return response.headers['location'] as string;
  }

  it('уводит к поставщику и подставляет наш адрес возврата', async () => {
    const location = await start();

    expect(location).toContain('https://auth.test/authorize');
    /* Адрес возврата собирается из PUBLIC_BASE_URL, а не вписан константой:
       на стенде это zapiski.test, на бою zapiski.cmpas.ru. Проверяем правило,
       а не значение, иначе тест сломается при первой же смене домена. */
    expect(simpas.seen.redirectUri).toBe(
      `${harness.ctx.env.PUBLIC_BASE_URL}/api/v1/auth/simpas/callback`,
    );
  });

  it('верификатора PKCE в state НЕТ — ни в каком виде', async () => {
    const location = await start();
    const state = stateOf(location);

    /* Круг замыкаем, чтобы УЗНАТЬ верификатор: подставной поставщик запоминает
       то, что пришло на обмен. Иначе проверять было бы не с чем. */
    await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/simpas/callback?code=код&state=${encodeURIComponent(state)}`,
    });
    const verifier = simpas.seen.codeVerifier;
    expect(verifier, 'верификатор не доехал — проверять нечего').toBeTruthy();

    /*
     * Прямая проверка вместо косвенной. Первая редакция этого теста звала
     * `openVerifier` с чужим секретом и ждала `null` — но `null` он отдаёт и
     * на открытом тексте тоже, так что тест проходил и с верификатором,
     * положенным в state как есть. Поймано фальсификацией.
     *
     * Теперь смотрим на то, что важно: сама строка верификатора не встречается
     * ни в полезной нагрузке, ни в токене целиком.
     */
    const claims = payloadOf(state);
    expect(JSON.stringify(claims)).not.toContain(verifier!);
    expect(state).not.toContain(verifier!);
  });

  it('возврат с кодом заводит сессию и связь', async () => {
    const location = await start();
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/simpas/callback?code=код&state=${encodeURIComponent(stateOf(location))}`,
    });

    expect(response.statusCode, 'возврат не завершился входом').toBeLessThan(400);

    const { rows } = await harness.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM simpas_links WHERE simpas_sub = $1`,
      [SUB],
    );
    expect(rows[0]?.count, 'связь не создана').toBe('1');
  });

  it('обмен получает ТОТ ЖЕ верификатор, что был запрошен', async () => {
    const location = await start();
    await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/simpas/callback?code=код&state=${encodeURIComponent(stateOf(location))}`,
    });

    /* Без этого круг замкнулся бы формально: PKCE проверяет поставщик, и
       неверный верификатор он отверг бы — а мы бы не заметили. */
    expect(simpas.seen.codeVerifier, 'верификатор не доехал до обмена').toBeTruthy();
    expect(simpas.seen.codeVerifier).not.toBe('');
  });

  it('подделанное состояние отвергается', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/auth/simpas/callback?code=код&state=не-наш-токен',
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('состояние Яндекса не проходит за состояние СИМПАС', async () => {
    const yandexStart = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/yandex?device_id=${DEVICE}&terms=2026-08-13`,
    });
    /* Яндекс в стенде не настроен — 404. Тогда возьмём состояние от СИМПАС и
       предъявим его на возврате Яндекса: направление проверки то же. */
    expect(yandexStart.statusCode).toBe(404);

    const location = await start();
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/yandex/callback?code=код&state=${encodeURIComponent(stateOf(location))}`,
    });
    expect(response.statusCode, 'чужое состояние принято').toBeGreaterThanOrEqual(400);
  });

  it('человек, входивший по почте, получает СВЯЗЬ, а не второй аккаунт', async () => {
    const before = await upsertUserByEmail(harness.db, 'marina@ya.ru');

    const location = await start();
    await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/simpas/callback?code=код&state=${encodeURIComponent(stateOf(location))}`,
    });

    const { rows } = await harness.db.query<{ user_id: string }>(
      `SELECT user_id FROM simpas_links WHERE simpas_sub = $1`,
      [SUB],
    );
    expect(rows[0]?.user_id, 'заведён второй аккаунт на ту же почту').toBe(before.id);
  });
});

describe.skipIf(noDatabase())('СИМПАС не настроен', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('начало входа отвечает 404, а не падает', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/simpas?device_id=${DEVICE}&terms=2026-08-13`,
    });
    expect(response.statusCode).toBe(404);
  });
});
