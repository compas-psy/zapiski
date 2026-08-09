import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REGISTRY } from '../src/lib/messages.ts';
import { createHarness, noDatabase, type Harness } from './helpers/app.ts';

/**
 * ТЗ §5.5: magic-токен одноразовый, живёт 15 минут и привязан к устройству
 * инициации. Все три свойства проверяются здесь — это единственный путь входа
 * без Яндекса, и дыра в любом из них открывает чужой аккаунт.
 *
 * Дополнительно: SCREENS §2 — повторное письмо не раньше чем через 60 секунд.
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
      payload: { email, deviceId, platform: 'web' },
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
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=device-magic-one`,
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
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=device-magic-two`,
    });
    expect(first.statusCode).toBe(200);

    const second = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=device-magic-two`,
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
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=device-magic-three`,
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
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=device-magic-four`,
    });
    expect(response.statusCode).toBe(200);
  });

  it('привязка к устройству: ссылка не открывается на другом устройстве', async () => {
    const email = `magic5.${process.pid}@example.test`;
    const { token } = await requestLink(email, 'device-magic-five');

    const wrongDevice = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=device-magic-other`,
    });
    expect(wrongDevice.statusCode).toBe(410);
    const error = wrongDevice.json() as { error: { code: string; message: string } };
    expect(error.error.code).toBe('magic_link_device_mismatch');
    expect(error.error.message).toBe(REGISTRY.magicLinkExpired);

    // И при этом токен не сгорел — своё устройство им ещё воспользуется.
    const rightDevice = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}&device_id=device-magic-five`,
    });
    expect(rightDevice.statusCode).toBe(200);
  });

  it('без device_id обмен не проходит', async () => {
    const email = `magic6.${process.pid}@example.test`;
    const { token } = await requestLink(email, 'device-magic-six');

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(token as string)}`,
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
      payload: { email, deviceId: 'device-magic-seven' },
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
      payload: { email, deviceId: 'device-magic-seven' },
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
      url: '/api/v1/auth/magic-link/callback?token=nosuchtokenatallnosuchtoken&device_id=device-magic-nine',
    });
    expect(response.statusCode).toBe(410);
    expect((response.json() as { error: { message: string } }).error.message).toBe(
      REGISTRY.magicLinkExpired,
    );
  });
});
