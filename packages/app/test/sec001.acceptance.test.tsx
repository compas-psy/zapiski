/**
 * Приёмка облака через НАСТОЯЩИЙ экран настроек.
 *
 * ── Что изменилось ──────────────────────────────────────────────────────────
 *
 * Прежний набор проверял сценарий с кодом восстановления: включил → получил
 * код → подтвердил → на втором устройстве ввёл. Решение владельца этот
 * сценарий отменяет: сквозное шифрование уходит из MVP, кода больше нет.
 * Поэтому проверяется другое — что человеку теперь вообще ничего не нужно
 * вводить, и что тот, кто успел включить шифрование, не потерял заметки.
 *
 * ── Про адреса в стенде ─────────────────────────────────────────────────────
 *
 * Стенд отвечает на СЕРВЕРНЫЕ адреса (`/vault/manifest`,
 * `/vault/blob/<путь>`, `/vault/crdt/...`), а не на адреса ядра
 * (`/vault/list`, `/vault/blob?path=`): между ними стоит переводчик в
 * `state/cloud.ts`, и подставлять надо то, что уходит из приложения наружу.
 * Проверять стоит именно этот слой — он и есть прикладной путь.
 *
 * Каждая проверка смотрит в облако, а не только на состояние: «состояние
 * стало ready» проходит и тогда, когда ни один байт до сервера не долетел.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PlatformCapabilities, VaultStorage } from '@zapiski/core';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PreferencesStore } from '../src/contract.js';
import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost, memoryPreferences } from './host.js';

const ru = strings('ru');
const SESSION = { accessToken: 'токен', refreshToken: 'обновление', deviceId: 'dev-0123456789ab' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Общее облако на весь тест: ключ аккаунта и блобы переживают «устройства».
 * Ровно так же, как один настоящий аккаунт на двух телефонах.
 */
function sharedCloud(): {
  fetch: typeof fetch;
  blobs: Map<string, Uint8Array>;
  syncKey: () => Record<string, string> | null;
} {
  const blobs = new Map<string, Uint8Array>();
  let syncKeyRow: Record<string, string> | null = null;
  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const impl = (async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'https://zapiski.cmpas.ru');
    const method = init?.method ?? 'GET';

    if (url.pathname === '/api/v1/vault/sync-key') {
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        if (syncKeyRow !== null) return json({ error: { code: 'sync_key_exists' } }, 409);
        syncKeyRow = body;
        return json({ enrolled: true }, 201);
      }
      if (method === 'DELETE') {
        const had = syncKeyRow !== null;
        syncKeyRow = null;
        return json({ removed: had }, 200);
      }
      return syncKeyRow === null
        ? json({ enrolled: false }, 200)
        : json({ enrolled: true, ...syncKeyRow }, 200);
    }

    if (url.pathname === '/api/v1/vault/manifest') {
      return json(
        {
          entries: [...blobs.entries()].map(([path, data]) => ({
            path,
            etag: '"1"',
            mtime: 1,
            size: data.length,
          })),
        },
        200,
      );
    }

    if (url.pathname.startsWith('/api/v1/vault/blob/')) {
      const address = decodeURIComponent(url.pathname.slice('/api/v1/vault/blob/'.length));
      if (method === 'PUT') {
        blobs.set(address, new Uint8Array(init?.body as unknown as Uint8Array));
        return new Response(null, { status: 200, headers: { etag: '"1"' } });
      }
      if (method === 'DELETE') {
        blobs.delete(address);
        return new Response(null, { status: 200 });
      }
      const found = blobs.get(address);
      if (!found) return new Response(null, { status: 404 });
      return new Response(found as unknown as BodyInit, { status: 200, headers: { etag: '"1"' } });
    }

    /* CRDT-обмен: прикладной слой переписывает push/pull ядра в
       `/vault/crdt/:noteId`. Без ответа синк честно падает. */
    if (url.pathname.startsWith('/api/v1/vault/crdt')) return json({ updates: [], accepted: 0 }, 200);
    if (url.pathname === '/api/v1/auth/refresh') {
      return json({ accessToken: 'токен', refreshToken: 'обновление' }, 200);
    }

    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  return { fetch: impl, blobs, syncKey: () => syncKeyRow };
}

/** Защищённое хранилище одного устройства. Переживает перезапуск приложения. */
function deviceKeystore(): NonNullable<PlatformCapabilities['biometrics']> {
  const store = new Map<string, Uint8Array>();
  return {
    isAvailable: async () => true,
    enroll: async (id, secret) => {
      store.set(id, Uint8Array.from(secret));
    },
    unlock: async (id) => {
      const found = store.get(id);
      return found ? Uint8Array.from(found) : null;
    },
    remove: async (id) => {
      store.delete(id);
    },
  };
}

/** Устройство: своя оболочка, своё хранилище ключа, общий аккаунт и облако. */
async function device(
  keystore: NonNullable<PlatformCapabilities['biometrics']>,
  files: Record<string, string> = {},
  prefsStore?: PreferencesStore,
): Promise<{ app: AppController; storage: VaultStorage }> {
  const host = createTestHost({
    files,
    platform: { kind: 'windows', biometrics: keystore },
    ...(prefsStore
      ? { prefsStore }
      : { prefs: { onboarded: true, 'auth.session': SESSION } }),
  });
  const app = new AppController(host);
  await app.boot();
  return { app, storage: host.storage };
}

function mountSettings(app: AppController): void {
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={app.host} controller={app}>
          <SettingsScreen section="sync" />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

/** Открыть карточку Облака: человек нажимает на неё целиком. */
async function openCloudCard(): Promise<void> {
  const card = (await screen.findByText(ru.settings.sync.cloud)).closest('button');
  fireEvent.click(card as HTMLButtonElement);
}

describe('A: первое устройство', () => {
  it('вошёл — облако уже работает, вводить и нажимать нечего', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);
    const { app } = await device(deviceKeystore(), { 'Идеи.md': '# Идеи\n' });

    /* Ни одного нажатия: живая сессия — и облако подключилось само. Это и
       есть требование «человек не должен заморачиваться»; прежде здесь была
       цепочка из четырёх действий и код, который надо было сохранить. */
    await waitFor(() => expect(app.getState().backendId).toBe('zapiski'));
    expect(app.getState().cloudEncryption).toBe('ready');

    /* Ключа аккаунта не появилось: ключей больше не создают. Появится —
       значит прежний онбординг вернулся незаметно для всех. */
    expect(cloud.syncKey(), 'создан ключ аккаунта, хотя онбординга больше нет').toBeNull();

    await app.syncNow();
    expect([...cloud.blobs.keys()], 'заметка не долетела до облака').toContain('Идеи.md');

    mountSettings(app);
    await openCloudCard();
    expect(await screen.findByText(ru.settings.sync.cloudReady)).toBeTruthy();
    app.dispose();
  });
});

describe('A′: без входа кнопка не молчит', () => {
  it('ведёт на экран входа, а не делает вид, что нажатия не было', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);
    const host = createTestHost({
      files: {},
      platform: { kind: 'windows', biometrics: deviceKeystore() },
      prefs: { onboarded: true },
    });
    const app = new AppController(host);
    await app.boot();

    mountSettings(app);
    await openCloudCard();
    fireEvent.click(await screen.findByRole('button', { name: ru.settings.sync.cloudEnable }));

    await waitFor(() => expect(app.getState().route.name).toBe('signin'));
    app.dispose();
  });
});

describe('B: перезапуск приложения', () => {
  it('облако возвращается само — ничего не спрашивают', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);
    /* Общие настройки и общее хранилище ключа = ТО ЖЕ устройство. Иначе
       «перезапуск» проверял бы новое устройство и доказывал не то. */
    const prefsStore = memoryPreferences({ onboarded: true, 'auth.session': SESSION });
    const keystore = deviceKeystore();

    const first = await device(keystore, { 'Идеи.md': '# Идеи\n' }, prefsStore);
    expect(await first.app.connectCloud()).toBe(true);
    await first.app.syncNow();
    first.app.dispose();

    // Перезапуск: только boot(), без единого нажатия.
    const second = await device(keystore, {}, prefsStore);
    await waitFor(() => expect(second.app.getState().backendId).toBe('zapiski'));
    second.app.dispose();
  });
});

describe('C: второе устройство', () => {
  it('только вход — и заметки первого уже здесь', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);

    const first = await device(deviceKeystore(), { 'Идеи.md': '# Идеи\n' });
    expect(await first.app.connectCloud()).toBe(true);
    await first.app.syncNow();
    first.app.dispose();

    /* Второе устройство: своё хранилище ключа, пустое. Прежде здесь
       требовался код восстановления; теперь — ничего. */
    const second = await device(deviceKeystore(), {});
    expect(await second.app.connectCloud()).toBe(true);
    await second.app.syncNow();

    await waitFor(() => expect(second.storage.read('Идеи.md')).resolves.not.toBeNull());
    second.app.dispose();
  });
});

describe('D: аккаунт, успевший включить прежнее шифрование', () => {
  /**
   * Заводит на общем облаке ключ и кладёт заметку шифротекстом.
   *
   * Через ПРИКЛАДНУЮ фабрику, а не через ядро напрямую: между ядром и
   * сервером стоит переводчик адресов (`state/cloud.ts`), и посев в обход
   * него разговаривал бы с сервером не на том языке.
   */
  async function encryptedAccount(
    cloud: ReturnType<typeof sharedCloud>,
    keystore: NonNullable<PlatformCapabilities['biometrics']>,
  ): Promise<void> {
    const core = await import('@zapiski/core');
    const { createCloudBackend } = await import('../src/state/cloud.js');
    const onboarding = new core.SyncKeyOnboarding({
      baseUrl: 'https://zapiski.cmpas.ru',
      fetch: cloud.fetch as never,
      biometrics: keystore,
    });
    const created = await onboarding.create();
    const session = {
      current: () => SESSION,
      accessToken: async () => SESSION.accessToken,
      refresh: async () => null,
    } as never;
    const backend = createCloudBackend({
      cloudBaseUrl: 'https://zapiski.cmpas.ru/api/v1',
      session,
      sync: created!.crypto,
      fetch: cloud.fetch as never,
    });
    await backend.put('Идеи.md', new TextEncoder().encode('# Идеи\n'));
    await backend.pushManifest(['Идеи.md']);
  }

  it('на устройстве с ключом переводится сам — заметки на месте', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);
    const keystore = deviceKeystore();
    await encryptedAccount(cloud, keystore);
    expect(cloud.syncKey(), 'предусловие: ключ аккаунта есть').not.toBeNull();

    const { app } = await device(keystore, {});
    expect(await app.connectCloud()).toBe(true);

    expect(app.getState().cloudEncryption).toBe('ready');
    expect(cloud.syncKey(), 'ключ обязан быть снят после перевода').toBeNull();
    expect([...cloud.blobs.keys()], 'заметка не вернулась по своему пути').toContain('Идеи.md');
    expect(
      [...cloud.blobs.keys()].some((a) => /^[0-9a-f]{32}$/.test(a)),
      'токенизированные копии остались',
    ).toBe(false);
    app.dispose();
  });

  it('на устройстве без ключа — честное сообщение и НИЧЕГО разрушительного', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);
    await encryptedAccount(cloud, deviceKeystore()); // ключ остался на ТОМ устройстве
    const before = new Map(cloud.blobs);

    const { app } = await device(deviceKeystore(), {}); // а это — другое
    expect(await app.connectCloud()).toBe(false);
    expect(app.getState().cloudEncryption).toBe('locked_elsewhere');

    mountSettings(app);
    await openCloudCard();
    expect(await screen.findByText(ru.settings.sync.cloudLockedTitle)).toBeTruthy();

    /* Самое важное: заметки и ключ целы. «Сбросить и начать заново» — не тот
       выход, который мы предлагаем человеку, у которого всё на месте. */
    expect(cloud.syncKey()).not.toBeNull();
    expect([...cloud.blobs.keys()].sort()).toEqual([...before.keys()].sort());
    app.dispose();
  });
});
