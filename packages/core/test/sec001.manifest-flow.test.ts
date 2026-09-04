/**
 * SEC-001 §7 — оглавление хранилища в НАСТОЯЩЕМ пути приложения.
 *
 * Манифест был написан и покрыт тестами, но его никто не публиковал: ни
 * движок синка, ни прикладной код не звали `pushManifest`. Для человека это
 * значит ровно одно — второе устройство, введя код восстановления, видит
 * пустой список: адреса на сервере токенизированы, а расшифровать их нечем.
 * То есть отдельные классы работали, а сценарий из задания — нет.
 *
 * Здесь проверяется сценарий, а не классы.
 */
import { describe, expect, it } from 'vitest';

import type { RemoteEntry, SyncBackend, VaultPath } from '../src/contract.js';
import { MemoryVaultStorage } from '../src/memory-storage.js';
import { Vault } from '../src/vault/vault.js';
import { SyncEngine } from '../src/sync/engine.js';
import { LocalFolderBackend } from '../src/sync/local-folder.js';
import { SyncKeyOnboarding } from '../src/sync/sync-key-onboarding.js';
import { ZapiskiCloudBackend } from '../src/sync/zapiski-cloud.js';
import { MANIFEST_ADDRESS } from '../src/sync/manifest.js';
import { formatRecoveryCode } from '../src/crypto/sync-keys.js';
import { fromUtf8, utf8 } from '../src/util/bytes.js';
import type { BiometricProvider } from '../src/contract.js';

const NOTE_PATH = 'Личное/Дневник.md';
const NOTE = '# Личное\n\nтекст заметки.\n';

/** Хранилище ключа устройства. */
function keychain(): BiometricProvider {
  const store = new Map<string, Uint8Array>();
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

/** Сервер: ключ аккаунта + блобы по адресам, как настоящий. */
function fakeCloud(seed: Record<string, Uint8Array> = {}): {
  fetch: typeof fetch;
  blobs: Map<string, Uint8Array>;
} {
  const blobs = new Map<string, Uint8Array>(Object.entries(seed));
  let syncKeyRow: Record<string, string> | null = null;

  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'https://zapiski.test');
    if (url.pathname.endsWith('/vault/sync-key')) {
      if (init?.method === 'PUT') {
        if (syncKeyRow !== null) return new Response(null, { status: 409 });
        syncKeyRow = JSON.parse(String(init.body)) as Record<string, string>;
        return json({ enrolled: true }, 201);
      }
      return syncKeyRow === null
        ? json({ enrolled: false }, 200)
        : json({ enrolled: true, ...syncKeyRow }, 200);
    }
    if (url.pathname.endsWith('/vault/blob')) {
      const address = url.searchParams.get('path') ?? '';
      if (init?.method === 'PUT') {
        blobs.set(address, new Uint8Array(init.body as unknown as Uint8Array));
        return new Response(null, { status: 200, headers: { etag: '"1"' } });
      }
      if (init?.method === 'DELETE') {
        blobs.delete(address);
        return new Response(null, { status: 200 });
      }
      const found = blobs.get(address);
      if (!found) return new Response(null, { status: 404 });
      return new Response(found as unknown as BodyInit, { status: 200, headers: { etag: '"1"' } });
    }
    if (url.pathname.endsWith('/vault/list')) {
      return json(
        {
          entries: [...blobs.entries()].map(([path, data]) => ({
            path,
            etag: '1',
            mtime: 1,
            size: data.length,
          })),
        },
        200,
      );
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, blobs };
}

describe('SEC-001 §7: оглавление публикуется само', () => {
  it('проход синка публикует манифест — иначе второе устройство слепо', async () => {
    const published: VaultPath[][] = [];
    const remote = new MemoryVaultStorage({ files: {} });
    const inner = new LocalFolderBackend(remote);
    /* Бэкенд, который УМЕЕТ оглавление, — как Облако Записок после SEC-001.
       Обычная папка и WebDAV его не умеют, и порт для них отсутствует. */
    const backend: SyncBackend = Object.assign(
      Object.create(Object.getPrototypeOf(inner) as object) as SyncBackend,
      inner,
      {
        async pushManifest(paths: readonly VaultPath[]): Promise<boolean> {
          published.push([...paths]);
          return true;
        },
      },
    );

    const local = new MemoryVaultStorage({ files: { [NOTE_PATH]: NOTE } });
    const vault = new Vault(local);
    await vault.rebuild();
    await new SyncEngine(vault, backend).sync();

    expect(published.length, 'манифест не опубликован ни разу').toBeGreaterThan(0);
    expect(published.at(-1)).toContain(NOTE_PATH);
  });

  it('бэкенд без оглавления проход не роняет', async () => {
    const remote = new MemoryVaultStorage({ files: {} });
    const local = new MemoryVaultStorage({ files: { [NOTE_PATH]: NOTE } });
    const vault = new Vault(local);
    await vault.rebuild();
    const outcome = await new SyncEngine(vault, new LocalFolderBackend(remote)).sync();
    expect(outcome.state).toBe('synced');
  });
});

describe('SEC-001 §7: список сам достаёт неизвестные адреса', () => {
  it('второе устройство видит чужую заметку без ручного pullManifest', async () => {
    const cloud = fakeCloud();
    const first = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: cloud.fetch as never,
      biometrics: keychain(),
    });
    const created = await first.create();
    const deviceA = new ZapiskiCloudBackend({
      baseUrl: 'https://zapiski.test',
      token: 'токен',
      deviceId: 'a',
      fetch: cloud.fetch as never,
      sync: created!.crypto,
    });
    await deviceA.put(NOTE_PATH, utf8(NOTE));
    await deviceA.pushManifest([NOTE_PATH]);

    const second = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: cloud.fetch as never,
      biometrics: keychain(),
    });
    const unlocked = await second.unlock(formatRecoveryCode(created!.recovery));
    expect(unlocked.ok).toBe(true);
    if (!unlocked.ok) return;

    const deviceB = new ZapiskiCloudBackend({
      baseUrl: 'https://zapiski.test',
      token: 'токен',
      deviceId: 'b',
      fetch: cloud.fetch as never,
      sync: unlocked.crypto,
    });
    /* Ни одного явного `pullManifest`: движок синка зовёт `list()`, и заметка
       обязана появиться сама. Иначе на втором устройстве список пуст. */
    const listed: RemoteEntry[] = await deviceB.list();
    expect(listed.map((entry) => entry.path)).toEqual([NOTE_PATH]);
  });
});

describe('SEC-001 §10: объекты прошлых версий', () => {
  it('открытая заметка переезжает в шифротекст, а открытая копия исчезает', async () => {
    /* Ровно то, что лежит в проде до перехода: адрес — настоящий путь,
       содержимое — открытый текст. */
    const cloud = fakeCloud({ [NOTE_PATH]: utf8(NOTE) });
    const onboarding = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: cloud.fetch as never,
      biometrics: keychain(),
    });
    const created = await onboarding.create();
    const backend = new ZapiskiCloudBackend({
      baseUrl: 'https://zapiski.test',
      token: 'токен',
      deviceId: 'a',
      fetch: cloud.fetch as never,
      sync: created!.crypto,
    });

    const moved = await backend.migrateLegacy();
    expect(moved, 'один открытый объект обязан переехать').toBe(1);

    // Открытого текста на сервере не осталось ВООБЩЕ.
    for (const [address, data] of cloud.blobs) {
      expect(fromUtf8(data), address).not.toContain('текст заметки');
      if (address !== MANIFEST_ADDRESS) expect(address).toMatch(/^[0-9a-f]{32}$/);
    }
    // И заметка по-прежнему читается по своему настоящему пути.
    const fetched = await backend.get(NOTE_PATH);
    expect(fromUtf8(fetched!.data)).toBe(NOTE);
  });

  it('повторный вызов ничего не делает — переезжать больше нечему', async () => {
    const cloud = fakeCloud({ [NOTE_PATH]: utf8(NOTE) });
    const onboarding = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: cloud.fetch as never,
      biometrics: keychain(),
    });
    const created = await onboarding.create();
    const backend = new ZapiskiCloudBackend({
      baseUrl: 'https://zapiski.test',
      token: 'токен',
      deviceId: 'a',
      fetch: cloud.fetch as never,
      sync: created!.crypto,
    });
    await backend.migrateLegacy();
    expect(await backend.migrateLegacy()).toBe(0);
  });
});
