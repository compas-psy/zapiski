/**
 * Доступ к Облаку Записок: что решает состояние.
 *
 * Прежде здесь стерёгся инвариант «без ключа шифрования бэкенда не
 * существует». Решение владельца — убрать сквозное шифрование из MVP —
 * этот инвариант снял, и вместе с ним ушёл сценарий E. Осталось то, что
 * по-прежнему обязано держаться:
 *
 *   • аккаунт с ключом ПРОШЛОЙ схемы не получает обычный бэкенд молча —
 *     иначе человек увидел бы пустое облако вместо своих заметок;
 *   • устройство без этого ключа получает `locked_elsewhere` и ЧЕСТНОЕ
 *     сообщение, а не разрушительное «сбросить и начать заново»;
 *   • недоступная сеть даёт `unavailable`, а не «поехали как есть»;
 *   • облако доступно на ВСЕХ платформах, включая веб.
 *
 * Проверяется через настоящую прикладную фабрику, а не через прямой
 * `new ZapiskiCloudBackend()`: дефекты этого класса живут в прикладном пути.
 */
import { describe, expect, it, vi } from 'vitest';

import type { BiometricProvider, PlatformCapabilities } from '@zapiski/core';
import { SyncKeyOnboarding } from '@zapiski/core';

import {
  cloudAvailable,
  createCloudBackendFor,
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

describe('аккаунт с ключом прошлой схемы', () => {
  it('без локального ключа — locked_elsewhere, и бэкенда нет', async () => {
    const access = await resolveCloudAccess({
      platform: platform('windows', keychain()), // хранилище есть, ключа в нём нет
      cloudBaseUrl: 'https://zapiski.test/api/v1',
      fetch: enrolledServer(),
    });

    expect(access.status).toBe('locked_elsewhere');
    /* Молча подключить обычный бэкенд нельзя: на сервере лежит шифротекст по
       токенизированным адресам, и обычный бэкенд его не видит вовсе —
       человек получил бы ПУСТОЕ облако вместо своих заметок. */
    expect(createCloudBackendFor(access, backendOptions)).toBeNull();
  });

  it('с локальным ключом — unlock_required, и бэкенд умеет читать шифротекст', async () => {
    const smk = new Uint8Array(32).fill(7);
    const onboarding = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: enrolledServer() as never,
      biometrics: keychain(smk),
    });
    const access = await resolveCloudAccess(
      {
        platform: platform('windows', keychain(smk)),
        cloudBaseUrl: 'https://zapiski.test/api/v1',
        fetch: enrolledServer(),
      },
      onboarding,
    );

    expect(access.status).toBe('unlock_required');
    /* Ключ обязан доехать до бэкенда: без него перевод не прочитает ни
       одного объекта, и переводить будет нечего. */
    expect(createCloudBackendFor(access, backendOptions)).not.toBeNull();
  });

  it('недоступная сеть даёт unavailable, а не «поехали как есть»', async () => {
    const access = await resolveCloudAccess({
      platform: platform('windows', keychain()),
      cloudBaseUrl: 'https://zapiski.test/api/v1',
      fetch: (async () => {
        throw new Error('сети нет');
      }) as unknown as typeof fetch,
    });

    expect(access.status).toBe('unavailable');
    expect(createCloudBackendFor(access, backendOptions)).toBeNull();
  });

  it('ни одно нерабочее состояние бэкенда не отдаёт', () => {
    const closed: CloudAccess[] = [
      { status: 'cloud_disabled', reason: 'flag' },
      { status: 'unavailable' },
      { status: 'locked_elsewhere' },
    ];
    for (const access of closed) {
      expect(createCloudBackendFor(access, backendOptions), access.status).toBeNull();
    }
  });
});

describe('облако доступно везде', () => {
  /*
   * Платформенный замок снят. Из-за него облака не было ни в вебе, ни на
   * телефоне без биометрии — то есть у части людей его не было вовсе, и
   * узнавали они об этом, только добравшись до настроек.
   */
  it('веб — доступно', () => {
    expect(cloudAvailable(platform('web', null))).toBe(true);
  });

  it('нативная платформа без биометрии — тоже доступно', () => {
    expect(cloudAvailable(platform('windows', null))).toBe(true);
  });

  it('чистый аккаунт получает рабочий бэкенд', async () => {
    const empty = (async (input: string) =>
      String(input).includes('/vault/sync-key')
        ? new Response(JSON.stringify({ enrolled: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(null, { status: 404 })) as unknown as typeof fetch;

    const access = await resolveCloudAccess({
      platform: platform('web', null),
      cloudBaseUrl: 'https://zapiski.test/api/v1',
      fetch: empty,
    });

    expect(access.status).toBe('ready');
    expect(createCloudBackendFor(access, backendOptions)).not.toBeNull();
  });

  it('признак защищённого хранилища сохранён — он понадобится ключнице', () => {
    /* Функция больше ничего не решает, но её условие верно и вернётся в дело,
       когда ключ начнёт приходить извне. Стережём, чтобы не «упростили». */
    expect(platformSupportsSecureKeyStorage(platform('web', null))).toBe(false);
    expect(platformSupportsSecureKeyStorage(platform('windows', keychain()))).toBe(true);
  });
});
