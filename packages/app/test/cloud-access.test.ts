/**
 * SEC-001 — fail-closed доступ к Облаку Записок.
 *
 * Самый важный тест здесь — сценарий E из задания: аккаунт УЖЕ перешёл на
 * шифрование, а локального ключа на этом устройстве нет. Ожидается
 * `needs_recovery` и ОТСУТСТВИЕ бэкенда — не открытый `ZapiskiCloudBackend`,
 * который тихо синхронизировал бы заметки в открытом виде.
 *
 * Проверяется через настоящую прикладную фабрику, а не через прямой
 * `new ZapiskiCloudBackend()`: дефект, который мы закрываем, жил именно в
 * прикладном пути.
 */
import { describe, expect, it, vi } from 'vitest';

import type { BiometricProvider, PlatformCapabilities } from '@zapiski/core';
import { SyncKeyOnboarding } from '@zapiski/core';

import {
  createEncryptedCloudBackend,
  platformSupportsSecureKeyStorage,
  resolveCloudAccess,
  type CloudAccess,
} from '../src/state/cloud-access.js';
import type { SessionStore } from '../src/state/session.js';

vi.mock('@zapiski/core', async () => {
  const actual = await vi.importActual<typeof import('@zapiski/core')>('@zapiski/core');
  return { ...actual, CLOUD_SYNC_ENABLED: true };
});

function keychain(seed?: Uint8Array): BiometricProvider {
  const store = new Map<string, Uint8Array>();
  if (seed) store.set('sync', seed);
  return {
    isAvailable: async () => true,
    enroll: async (id, secret) => {
      store.set(id, secret);
    },
    unlock: async (id) => store.get(id) ?? null,
    remove: async (id) => {
      store.delete(id);
    },
  };
}

function platform(
  kind: PlatformCapabilities['kind'],
  biometrics: BiometricProvider | null,
): PlatformCapabilities {
  return { kind, version: '1.0.0', biometrics, haptics: null, globalHotkey: null } as PlatformCapabilities;
}

/** Сервер, у которого ключ аккаунта уже есть — то есть аккаунт зашифрован. */
function enrolledServer(): typeof fetch {
  return (async (input: string) => {
    if (String(input).includes('/vault/sync-key')) {
      return new Response(
        JSON.stringify({
          enrolled: true,
          wrappedSmk: Buffer.from(new Uint8Array(60)).toString('base64'),
          accountSalt: Buffer.from(new Uint8Array(16)).toString('base64'),
          checkBlob: Buffer.from(new Uint8Array(40)).toString('base64'),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

/* Минимальная сессия: фабрике нужен только текущий токен и device-id. */
const session = {
  current: () => ({ accessToken: 'токен', deviceId: 'device-1' }),
  accessToken: async () => 'токен',
  refresh: async () => null,
} as unknown as SessionStore;
const backendOptions = { cloudBaseUrl: 'https://zapiski.test/api/v1', session };

describe('SEC-001 E: зашифрованный аккаунт без локального ключа', () => {
  it('даёт needs_recovery, а НЕ открытый бэкенд — критический инвариант', async () => {
    const access = await resolveCloudAccess({
      platform: platform('windows', keychain()), // хранилище пустое
      cloudBaseUrl: 'https://zapiski.test/api/v1',
      fetch: enrolledServer() as never,
    });

    expect(access.status).toBe('needs_recovery');
    // И, главное, бэкенда из этого состояния не собрать.
    expect(createEncryptedCloudBackend(access, backendOptions)).toBeNull();
  });

  it('недоступная сеть тоже закрывает доступ, а не открывает его', async () => {
    const offline = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const access = await resolveCloudAccess({
      platform: platform('windows', keychain()),
      cloudBaseUrl: 'https://zapiski.test/api/v1',
      fetch: offline as never,
    });

    expect(access.status).toBe('needs_recovery');
    expect(createEncryptedCloudBackend(access, backendOptions)).toBeNull();
  });

  it('ни одно состояние без ключа не отдаёт бэкенд', () => {
    const closed: CloudAccess[] = [
      { status: 'cloud_disabled', reason: 'flag' },
      { status: 'cloud_disabled', reason: 'platform' },
      { status: 'needs_onboarding' },
      { status: 'needs_recovery' },
    ];
    for (const access of closed) {
      expect(createEncryptedCloudBackend(access, backendOptions), access.status).toBeNull();
    }
  });
});

describe('SEC-001: платформа решает, доступно ли облако', () => {
  it('Windows/macOS/Android с защищённым хранилищем — доступно', () => {
    for (const kind of ['windows', 'macos', 'android'] as const) {
      expect(platformSupportsSecureKeyStorage(platform(kind, keychain())), kind).toBe(true);
    }
  });

  /**
   * Веб выключен ЧЕСТНО и по причине, а не «не успели»: у браузера нет
   * аппаратного эквивалента Keychain/Keystore/DPAPI, а держать извлекаемый
   * ключ в origin-читаемом хранилище — другой уровень защиты (design §3.1).
   */
  it('веб — недоступно, даже если биометрия формально есть', () => {
    expect(platformSupportsSecureKeyStorage(platform('web', keychain()))).toBe(false);
    expect(platformSupportsSecureKeyStorage(platform('web', null))).toBe(false);
  });

  it('нативная платформа без хранилища — тоже недоступно', () => {
    expect(platformSupportsSecureKeyStorage(platform('android', null))).toBe(false);
  });

  it('в вебе состояние — cloud_disabled по причине platform', async () => {
    const access = await resolveCloudAccess({
      platform: platform('web', keychain()),
      cloudBaseUrl: 'https://zapiski.test/api/v1',
      fetch: enrolledServer() as never,
    });
    expect(access).toEqual({ status: 'cloud_disabled', reason: 'platform' });
  });
});

describe('SEC-001: состояние с ключом действительно открывает облако', () => {
  it('encrypted_ready отдаёт бэкенд, и он шифрует', async () => {
    /* Устройство, у которого ключ в хранилище есть: это и есть «перезапуск
       приложения» — код восстановления второй раз не нужен. */
    const smk = new Uint8Array(32).fill(3);
    const onboarding = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: enrolledServer() as never,
      biometrics: keychain(smk),
    });
    const access = await resolveCloudAccess(
      {
        platform: platform('windows', keychain(smk)),
        cloudBaseUrl: 'https://zapiski.test/api/v1',
        fetch: enrolledServer() as never,
      },
      onboarding,
    );

    expect(access.status).toBe('encrypted_ready');
    const backend = createEncryptedCloudBackend(access, backendOptions);
    expect(backend).not.toBeNull();
    expect(backend!.encrypts).toBe(true);
  });
});
