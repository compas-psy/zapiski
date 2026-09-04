/**
 * SEC-001 §4 — полный цикл подключения устройства на подставных `fetch` и
 * `biometrics`. Без UI, без сервера, без сети.
 *
 * Главное, что здесь доказывается: два устройства одного аккаунта приходят
 * к ОДНОМУ ключу и читают заметки друг друга, а чужой код не открывает
 * ничего и не оставляет частично развёрнутого ключа.
 */
import { describe, expect, it } from 'vitest';

import type { BiometricProvider } from '../src/contract.js';
import { formatRecoveryCode, generateRecoveryCode } from '../src/crypto/sync-keys.js';
import { SyncKeyOnboarding, SYNC_KEY_STORAGE_ID } from '../src/sync/sync-key-onboarding.js';
import { fromUtf8, utf8 } from '../src/util/bytes.js';

/** Сервер: одна строка на аккаунт, ровно как настоящая таблица `sync_keys`. */
function fakeServer(): { fetch: typeof fetch; stored: () => Record<string, string> | null } {
  let row: Record<string, string> | null = null;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (!String(url).includes('/vault/sync-key')) return new Response(null, { status: 404 });
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      if (row !== null) return new Response(JSON.stringify({ error: { code: 'sync_key_exists' } }), { status: 409 });
      row = body;
      return new Response(JSON.stringify({ enrolled: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (row === null) {
      return new Response(JSON.stringify({ enrolled: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ enrolled: true, ...row }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, stored: () => row };
}

/** Платформенное хранилище — как Keystore/Keychain/DPAPI, только в памяти. */
function fakeBiometrics(): BiometricProvider & { peek: (id: string) => Uint8Array | null } {
  const store = new Map<string, Uint8Array>();
  return {
    isAvailable: async () => true,
    enroll: async (keyId, secret) => {
      store.set(keyId, secret);
    },
    unlock: async (keyId) => store.get(keyId) ?? null,
    remove: async (keyId) => {
      store.delete(keyId);
    },
    peek: (keyId) => store.get(keyId) ?? null,
  };
}

const SECRET = '# Дневник\n\nЛичное: тревога перед защитой проекта.\n';

describe('SEC-001 §4: подключение устройства', () => {
  it('первое устройство: ключа нет → создаём и получаем код один раз', async () => {
    const server = fakeServer();
    const bio = fakeBiometrics();
    const onboarding = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: server.fetch as never,
      biometrics: bio,
    });

    expect((await onboarding.state()).status).toBe('none');

    const created = await onboarding.create();
    expect(created).not.toBeNull();
    expect(created!.recovery.secret.length).toBe(32);
    // Ключ ушёл на сервер ТОЛЬКО обёрнутым.
    const row = server.stored()!;
    expect(row['wrappedSmk']).toBeDefined();
    expect(Buffer.from(row['wrappedSmk']!, 'base64').toString('hex')).not.toContain(
      Buffer.from(bio.peek(SYNC_KEY_STORAGE_ID)!).toString('hex'),
    );
    // …а на устройстве закэширован развёрнутым.
    expect(bio.peek(SYNC_KEY_STORAGE_ID)).not.toBeNull();
  });

  it('после создания состояние — ready, код второй раз не спрашивается', async () => {
    const server = fakeServer();
    const onboarding = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: server.fetch as never,
      biometrics: fakeBiometrics(),
    });
    await onboarding.create();
    expect((await onboarding.state()).status).toBe('ready');
  });

  it('второе устройство: ключ есть, кода нет → needs-code, а не none', async () => {
    const server = fakeServer();
    const first = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: server.fetch as never,
      biometrics: fakeBiometrics(),
    });
    await first.create();

    // Другое устройство — своё, пустое хранилище.
    const second = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: server.fetch as never,
      biometrics: fakeBiometrics(),
    });
    expect((await second.state()).status).toBe('needs-code');
  });

  it('два устройства приходят к одному ключу и читают заметки друг друга', async () => {
    const server = fakeServer();
    const first = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: server.fetch as never,
      biometrics: fakeBiometrics(),
    });
    const created = await first.create();
    const code = formatRecoveryCode(created!.recovery);

    const second = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: server.fetch as never,
      biometrics: fakeBiometrics(),
    });
    const unlocked = await second.unlock(code);
    expect(unlocked.ok).toBe(true);

    // Ключевое свойство многоустройственности: что зашифровало одно —
    // расшифровывает другое, без какого-либо обмена ключами между ними.
    if (unlocked.ok) {
      const sealed = await created!.crypto.sealContent('Дневник.md', utf8(SECRET));
      const opened = await unlocked.crypto.openContent('Дневник.md', sealed);
      expect(opened).not.toBeNull();
      expect(fromUtf8(opened!)).toBe(SECRET);
    }
  });

  it('опечатка ловится локально и НЕ доходит до сервера', async () => {
    const server = fakeServer();
    let requests = 0;
    const counting = (async (url: string, init?: RequestInit) => {
      requests += 1;
      return (server.fetch as unknown as typeof fetch)(url as never, init as never);
    }) as unknown as typeof fetch;

    const first = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: server.fetch as never,
      biometrics: fakeBiometrics(),
    });
    const created = await first.create();
    const code = formatRecoveryCode(created!.recovery);

    const second = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: counting as never,
      biometrics: fakeBiometrics(),
    });
    const before = requests;
    const typo = await second.unlock(`${code.slice(0, -1)}${code.endsWith('A') ? 'B' : 'A'}`);

    expect(typo.ok).toBe(false);
    if (!typo.ok) expect(typo.reason).toBe('typo');
    expect(requests, 'опечатка не должна ходить по сети').toBe(before);
  });

  it('неверный (но корректно набранный) код не открывает ключ и не оставляет огрызка', async () => {
    const server = fakeServer();
    const first = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: server.fetch as never,
      biometrics: fakeBiometrics(),
    });
    await first.create();

    const bio = fakeBiometrics();
    const second = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: server.fetch as never,
      biometrics: bio,
    });
    const other = formatRecoveryCode(await generateRecoveryCode());
    const result = await second.unlock(other);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-code');
    // Ни байта ключа в хранилище устройства — частично развёрнутого состояния нет.
    expect(bio.peek(SYNC_KEY_STORAGE_ID)).toBeNull();
  });

  it('forget() стирает материал ключа с устройства', async () => {
    const server = fakeServer();
    const bio = fakeBiometrics();
    const onboarding = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: server.fetch as never,
      biometrics: bio,
    });
    await onboarding.create();
    expect(bio.peek(SYNC_KEY_STORAGE_ID)).not.toBeNull();

    await onboarding.forget();

    expect(bio.peek(SYNC_KEY_STORAGE_ID)).toBeNull();
    expect((await onboarding.state()).status).toBe('needs-code');
  });

  it('без защищённого хранилища (Web) цикл всё равно проходит — просто без кэша', async () => {
    const server = fakeServer();
    const onboarding = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: server.fetch as never,
      biometrics: null,
    });
    const created = await onboarding.create();
    expect(created).not.toBeNull();
    // Кэша нет — на следующем запуске код спросят снова. Это честное
    // поведение Web-платформы (design §3.1), а не сбой.
    expect((await onboarding.state()).status).toBe('needs-code');
  });
});
