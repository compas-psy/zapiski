/**
 * SEC-001 — приёмка A–D через НАСТОЯЩИЙ экран настроек.
 *
 * Проверяется не наличие классов, а сценарий человека: нажал «Включить
 * облако» → получил код → подтвердил → облако работает; перезапустил → код
 * не спрашивают; на втором устройстве ввёл код → заметки открылись; ввёл
 * чужой код → понятная ошибка и НИЧЕГО не сломалось.
 *
 * Сервер здесь подставной, но повторяет настоящий: одна строка ключа на
 * аккаунт, блобы по адресам, отказ 409 при попытке перезаписать чужой ключ.
 * Хранилище ключа устройства — тоже подставное, зато переживает
 * «перезапуск», как Keychain/Keystore/DPAPI.
 *
 * Остальные буквы приёмки живут там, где им место:
 *   E — `cloud-access.test.ts` (fail-closed фабрика: ключа нет → бэкенда нет);
 *   F — `server/test/sec001.acceptance.test.ts` (сервер против настоящей
 *       Postgres: ни одного открытого байта в blobs/versions/crdt).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PlatformCapabilities, VaultStorage } from '@zapiski/core';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

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
): Promise<{ app: AppController; storage: VaultStorage }> {
  const host = createTestHost({
    files,
    prefs: { onboarded: true, 'auth.session': SESSION },
    platform: { kind: 'windows', biometrics: keystore },
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

describe('SEC-001 A: первое устройство', () => {
  it('включил облако → увидел код → подтвердил → облако работает', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);
    const { app } = await device(deviceKeystore(), { 'Личное/Дневник.md': '# Личное\n\nтревога\n' });
    mountSettings(app);
    await openCloudCard();

    /* 1. Обещание — теми словами, что решил заказчик. */
    expect(await screen.findByText(ru.settings.sync.encryptionPromise)).toBeTruthy();

    /* 2. Одна кнопка — «Включить облако». */
    fireEvent.click(screen.getByRole('button', { name: ru.settings.sync.encryptionEnable }));

    /* 3. Код показан один раз и он настоящий: длинный и разбит на группы. */
    const shown = await screen.findByTestId('cloud-recovery-code');
    const code = shown.textContent ?? '';
    expect(code.length).toBeGreaterThan(20);
    expect(code).toMatch(/^[0-9A-Z-]+$/);
    /* Ключ на сервере — только обёрнутый: сам код туда не уезжал. */
    expect(JSON.stringify(cloud.syncKey())).not.toContain(code.replace(/-/g, ''));

    /* 4. Пока не подтвердил — облако НЕ подключено. */
    expect(app.getState().backendId, 'облако включилось до подтверждения кода').toBeNull();

    /* 5. «Я сохранил код восстановления» — и только теперь оно работает. */
    fireEvent.click(screen.getByRole('button', { name: ru.settings.sync.recoverySaved }));
    await waitFor(() => expect(app.getState().backendId).toBe('zapiski'));
    expect(app.getState().cloudEncryption).toBe('encrypted_ready');
    /* Код из состояния стёрт: второй раз его не показывают и негде взять. */
    expect(app.getState().cloudRecoveryCode).toBeNull();

    app.dispose();
  });
});

describe('SEC-001 B: перезапуск приложения', () => {
  it('код восстановления второй раз не спрашивают', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);
    const keystore = deviceKeystore();

    const { app: first } = await device(keystore);
    await first.enableCloudEncryption();
    await first.confirmRecoveryCodeSaved();
    expect(first.getState().backendId).toBe('zapiski');
    first.dispose();

    /* Перезапуск: то же устройство, то же хранилище ключа, новый процесс. */
    const { app: restarted } = await device(keystore);
    await restarted.refreshCloudEncryption();

    expect(
      restarted.getState().cloudEncryption,
      'после перезапуска у человека снова спросили код',
    ).toBe('encrypted_ready');
    restarted.dispose();
  });
});

describe('SEC-001 C: второе устройство', () => {
  it('просит код, принимает верный и подключает облако', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);

    const { app: first } = await device(deviceKeystore());
    const code = await first.enableCloudEncryption();
    expect(code).not.toBeNull();
    await first.confirmRecoveryCodeSaved();
    first.dispose();

    /* Другое устройство: своё пустое хранилище ключа. */
    const { app: second } = await device(deviceKeystore());
    mountSettings(second);
    await openCloudCard();

    expect(await screen.findByText(ru.settings.sync.recoveryEnterTitle)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(ru.settings.sync.recoveryEnterLabel), {
      target: { value: code as string },
    });
    fireEvent.click(screen.getByRole('button', { name: ru.settings.sync.recoveryUnlock }));

    await waitFor(() => expect(second.getState().backendId).toBe('zapiski'));
    expect(second.getState().cloudEncryption).toBe('encrypted_ready');
    second.dispose();
  });
});

describe('SEC-001 D: неверный код', () => {
  it('понятная ошибка и ничего разрушительного', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);

    const { app: first } = await device(deviceKeystore());
    await first.enableCloudEncryption();
    await first.confirmRecoveryCodeSaved();
    const keyBefore = JSON.stringify(cloud.syncKey());
    first.dispose();

    const { app: second, storage } = await device(deviceKeystore(), { 'Своя.md': '# Своя\n' });
    mountSettings(second);
    await openCloudCard();
    await screen.findByText(ru.settings.sync.recoveryEnterTitle);

    /* Правильно набранный, но ЧУЖОЙ код: ключ им не разворачивается. */
    fireEvent.change(screen.getByLabelText(ru.settings.sync.recoveryEnterLabel), {
      target: { value: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ' },
    });
    fireEvent.click(screen.getByRole('button', { name: ru.settings.sync.recoveryUnlock }));

    /* Сказано человеческими словами... */
    const message = await screen.findByText(
      (text) => text === ru.settings.sync.recoveryWrong || text === ru.settings.sync.recoveryTypo,
    );
    expect(message).toBeTruthy();
    /* ...и ничего не разрушено: ключ аккаунта на месте, заметки на месте,
       облако не подключилось «наполовину». */
    expect(JSON.stringify(cloud.syncKey())).toBe(keyBefore);
    expect(second.getState().backendId).toBeNull();
    expect(await storage.read('Своя.md')).not.toBeNull();
    second.dispose();
  });
});
