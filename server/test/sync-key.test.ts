/**
 * SEC-001 §12, §13 — хранение обёрнутого ключа синка и запрет открытого
 * текста после онбординга.
 *
 * Главное, что проверяется здесь: сервер держит непрозрачные байты и не
 * получает от них ничего полезного, а как только аккаунт перешёл на
 * шифрование — перестаёт принимать открытый текст даже от клиента, который
 * про шифрование не знает.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';
import { looksLikeSyncEnvelope } from '../src/routes/vault.ts';

/** Конверт в форме, которую делает `SyncCrypto`: [версия][нонс][шифротекст]. */
function fakeEnvelope(payload = 'зашифрованные байты'): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const tag = Buffer.alloc(16, 7);
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(12, 3), body, tag]);
}

describe('форма конверта — грубая проверка сервера', () => {
  it('markdown и локальный контейнер .md.enc конвертом не считаются', () => {
    expect(looksLikeSyncEnvelope(Buffer.from('# Дневник\n\nтекст заметки'))).toBe(false);
    expect(looksLikeSyncEnvelope(Buffer.from('ZPSK...........................'))).toBe(false);
  });

  it('слишком короткий блоб конвертом не считается — там негде лежать тегу', () => {
    expect(looksLikeSyncEnvelope(Buffer.from([1, 2, 3]))).toBe(false);
  });

  it('настоящая форма конверта распознаётся', () => {
    expect(looksLikeSyncEnvelope(fakeEnvelope())).toBe(true);
  });
});

describe.skipIf(noDatabase())('SEC-001: /api/v1/vault/sync-key', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('до онбординга отвечает enrolled:false, а не ошибкой', async () => {
    const user = await createUser(harness);
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/sync-key',
      headers: user.authHeader,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enrolled: false });
  });

  it('сохраняет и отдаёт обёртку тем же байтам', async () => {
    const user = await createUser(harness);
    const payload = {
      wrappedSmk: Buffer.from('обёрнутый-smk').toString('base64'),
      accountSalt: Buffer.from('соль-аккаунта').toString('base64'),
      checkBlob: Buffer.from('проверочный-конверт').toString('base64'),
    };

    const put = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/sync-key',
      headers: user.authHeader,
      payload,
    });
    expect(put.statusCode).toBe(201);

    const get = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/sync-key',
      headers: user.authHeader,
    });
    const body = get.json() as { enrolled: boolean; wrappedSmk: string; accountSalt: string };
    expect(body.enrolled).toBe(true);
    expect(body.wrappedSmk).toBe(payload.wrappedSmk);
    expect(body.accountSalt).toBe(payload.accountSalt);
  });

  it('повтор ТОГО ЖЕ ключа — успех (обрыв сети не должен ломать онбординг)', async () => {
    const user = await createUser(harness);
    const payload = {
      wrappedSmk: Buffer.from('идемпотентный').toString('base64'),
      accountSalt: Buffer.from('соль').toString('base64'),
      checkBlob: Buffer.from('проверка').toString('base64'),
    };
    const first = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/sync-key',
      headers: user.authHeader,
      payload,
    });
    const second = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/sync-key',
      headers: user.authHeader,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
  });

  it('подмена ключа ДРУГИМ отбивается — иначе уже зашифрованное стало бы нечитаемым', async () => {
    const user = await createUser(harness);
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/sync-key',
      headers: user.authHeader,
      payload: {
        wrappedSmk: Buffer.from('первый').toString('base64'),
        accountSalt: Buffer.from('соль').toString('base64'),
        checkBlob: Buffer.from('проверка').toString('base64'),
      },
    });
    const overwrite = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/sync-key',
      headers: user.authHeader,
      payload: {
        wrappedSmk: Buffer.from('второй, другой').toString('base64'),
        accountSalt: Buffer.from('соль').toString('base64'),
        checkBlob: Buffer.from('проверка').toString('base64'),
      },
    });
    expect(overwrite.statusCode).toBe(409);
  });

  it('чужой аккаунт не видит ключ соседа', async () => {
    const owner = await createUser(harness);
    const stranger = await createUser(harness);
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/sync-key',
      headers: owner.authHeader,
      payload: {
        wrappedSmk: Buffer.from('ключ владельца').toString('base64'),
        accountSalt: Buffer.from('соль').toString('base64'),
        checkBlob: Buffer.from('проверка').toString('base64'),
      },
    });
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/sync-key',
      headers: stranger.authHeader,
    });
    expect(response.json()).toEqual({ enrolled: false });
  });

  it('без токена не отдаётся вовсе', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/vault/sync-key' });
    expect(response.statusCode).toBe(401);
  });
});

describe.skipIf(noDatabase())('SEC-001 §13: после онбординга открытый текст не принимается', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  const enroll = async (authHeader: Record<string, string>): Promise<void> => {
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/sync-key',
      headers: authHeader,
      payload: {
        wrappedSmk: Buffer.from('обёрнутый').toString('base64'),
        accountSalt: Buffer.from('соль').toString('base64'),
        checkBlob: Buffer.from('проверка').toString('base64'),
      },
    });
  };

  it('до онбординга открытый текст пишется как раньше — совместимость не сломана', async () => {
    const user = await createUser(harness);
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/Дневник.md',
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('# Дневник\n\nоткрытый текст'),
    });
    expect(response.statusCode).toBe(200);
  });

  it('после онбординга старый клиент получает 409 upgrade_required, а не молча перезаписывает', async () => {
    const user = await createUser(harness);
    await enroll(user.authHeader as Record<string, string>);

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/Дневник.md',
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('# Дневник\n\nоткрытый текст от старого клиента'),
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe('upgrade_required');
  });

  it('новый клиент с конвертом пишет как обычно', async () => {
    const user = await createUser(harness);
    await enroll(user.authHeader as Record<string, string>);

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/Дневник.md',
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
      payload: fakeEnvelope(),
    });
    expect(response.statusCode).toBe(200);
  });
});
