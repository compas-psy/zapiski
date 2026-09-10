/**
 * Облако: сценарий владельца, через НАСТОЯЩИЙ прикладной путь.
 *
 * ── Что проверяется ─────────────────────────────────────────────────────────
 *
 * Дословно то, что было заказано:
 *
 *   1. поставил Windows, подключил облако — неважно, были ли уже локальные
 *      заметки: всё уезжает в облако;
 *   2. поставил Android, подключил облако — файлы приезжают в локальную папку;
 *   3. дальше правки ходят в обе стороны.
 *
 * Ни кода восстановления, ни онбординга ключа, ни платформенных условий:
 * сквозное шифрование вырезано из MVP целиком.
 *
 * ── Почему стенд говорит серверными адресами ────────────────────────────────
 *
 * Между ядром и сервером стоит переводчик (`state/cloud.ts`): ядро ходит по
 * `/vault/list` и `/vault/blob?path=`, наружу уходит `/vault/manifest` и
 * `/vault/blob/<путь>`. Подставлять надо то, что уходит НАРУЖУ, иначе тест
 * проверяет не тот слой и молча зеленеет на 404.
 *
 * И каждая проверка смотрит в облако и в чужое хранилище, а не только на
 * состояние: «backendId стал zapiski» проходит и тогда, когда ни один байт
 * никуда не доехал.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { VaultStorage } from '@zapiski/core';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PreferencesStore } from '../src/contract.js';
import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost, memoryPreferences } from './host.js';

const ru = strings('ru');
const SESSION = { accessToken: 'token', refreshToken: 'refresh', deviceId: 'dev-0123456789ab' };
const NOTE = 'Идеи.md';
const TEXT = '# Идеи\n\nпервая мысль\n';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Одно облако на весь тест — как один аккаунт на нескольких устройствах. */
function sharedCloud(): { fetch: typeof fetch; blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const impl = (async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'https://zapiski.cmpas.ru');
    const method = init?.method ?? 'GET';

    if (url.pathname === '/api/v1/auth/refresh') {
      return json({ accessToken: SESSION.accessToken, refreshToken: SESSION.refreshToken }, 200);
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

    if (url.pathname.startsWith('/api/v1/vault/crdt')) return json({ updates: [], accepted: 0 }, 200);
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  return { fetch: impl, blobs };
}

/** Устройство: своя оболочка, своё локальное хранилище, общий аккаунт. */
async function device(
  kind: 'windows' | 'android' | 'web',
  files: Record<string, string> = {},
  prefsStore?: PreferencesStore,
): Promise<{ app: AppController; storage: VaultStorage }> {
  const host = createTestHost({
    files,
    platform: { kind },
    ...(prefsStore ? { prefsStore } : { prefs: { onboarded: true, 'auth.session': SESSION } }),
  });
  const app = new AppController(host);
  await app.boot();
  return { app, storage: host.storage };
}

describe('облако подключается и синхронизирует', () => {
  it('Windows: подключил — локальные заметки уехали в облако', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);
    const { app } = await device('windows', { [NOTE]: TEXT });

    expect(await app.connectCloud(), 'подключение отказало').toBe(true);
    await app.syncNow();

    expect([...cloud.blobs.keys()], 'заметка не долетела до облака').toContain(NOTE);
    expect(new TextDecoder().decode(cloud.blobs.get(NOTE)!)).toBe(TEXT);
    app.dispose();
  });

  it('Windows: подключил без единой заметки — облако не ломается', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);
    const { app } = await device('windows', {});

    expect(await app.connectCloud()).toBe(true);
    await app.syncNow();
    expect(app.getState().backendId).toBe('zapiski');
    app.dispose();
  });

  it('Android: подключил — заметки приехали в локальную папку', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);

    const first = await device('windows', { [NOTE]: TEXT });
    expect(await first.app.connectCloud()).toBe(true);
    await first.app.syncNow();
    first.app.dispose();

    /* Второе устройство: пустая папка, тот же аккаунт, НИЧЕГО не вводим. */
    const second = await device('android', {});
    expect(await second.app.connectCloud()).toBe(true);
    await second.app.syncNow();

    await waitFor(async () =>
      expect(await second.storage.read(NOTE), 'заметка не приехала на второе устройство').not.toBeNull(),
    );
    expect(new TextDecoder().decode((await second.storage.read(NOTE))!)).toBe(TEXT);
    second.app.dispose();
  });

  it('заметка, созданная на телефоне, приезжает на компьютер', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);

    const first = await device('windows', { [NOTE]: TEXT });
    expect(await first.app.connectCloud()).toBe(true);
    await first.app.syncNow();

    const second = await device('android', {});
    expect(await second.app.connectCloud()).toBe(true);
    await second.app.syncNow();

    /* Создаём заметку ПРОДУКТОВЫМ путём, а не записью в хранилище мимо
       приложения: иначе индекс синка о ней не узнает, и тест проверял бы
       не тот механизм, который работает у человека. */
    const created = await second.app.saveQuickNote('мысль с телефона');
    expect(created, 'заметка на телефоне не создалась').not.toBeNull();
    await second.app.syncNow();
    second.app.dispose();

    // Компьютер синхронизируется — и забирает её себе в локальную папку.
    await first.app.syncNow();
    const landed = await first.storage.read(created!);
    expect(landed, 'заметка с телефона не приехала на компьютер').not.toBeNull();
    expect(new TextDecoder().decode(landed!)).toContain('мысль с телефона');
    first.app.dispose();
  });

  it('в вебе облако предлагается наравне со всеми', async () => {
    const cloud = sharedCloud();
    vi.stubGlobal('fetch', cloud.fetch);
    const { app } = await device('web', {});

    render(
      <ThemeProvider persist={false}>
        <ToastProvider>
          <AppProvider host={app.host} controller={app}>
            <SettingsScreen section="sync" />
          </AppProvider>
        </ToastProvider>
      </ThemeProvider>,
    );

    expect(await screen.findByText(ru.settings.sync.cloud)).toBeTruthy();
    expect(
      screen.queryByText(ru.settings.sync.cloudUnavailableBadge),
      'веб снова помечен недоступным — платформенный замок вернулся',
    ).toBeNull();
    app.dispose();
  });
});
