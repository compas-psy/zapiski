/**
 * Что осталось стеречь у облака после того, как замки сняты.
 *
 * ── История файла, потому что она объясняет его нынешний размер ─────────────
 *
 * Он назывался `cloud-kill-switch.test.tsx` и стерёг `CLOUD_SYNC_ENABLED ===
 * false`: облако было выключено целиком, потому что содержимое уходило на
 * сервер как есть. Потом стерёг два условия — флаг и платформу, потому что
 * ключ сквозного шифрования негде держать в браузере. Теперь сквозное
 * шифрование вырезано из MVP, платформенный замок снят, и стеречь их нечего.
 *
 * Осталось три вещи, и все три — про то, чтобы отказ назывался своим именем:
 *   • флаг включён, и это решение, а не случайность;
 *   • без входа облако не подключается, но и не объявляется «выключенным» —
 *     иначе от человека прячется кнопка входа;
 *   • чужие бэкенды всё это по-прежнему не трогает.
 *
 * Что облако предлагается на КАЖДОЙ платформе и что заметки реально ходят
 * между устройствами — в `cloud.acceptance.test.tsx`, там это проверяется
 * сценарием, а не наличием надписи.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { CLOUD_SYNC_ENABLED } from '@zapiski/core';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

describe('облако включено — это решение, а не случайность', () => {
  it('CLOUD_SYNC_ENABLED === true', () => {
    expect(
      CLOUD_SYNC_ENABLED,
      'облако выключено флагом — сверьтесь с cloud.acceptance.test.tsx, прежде чем менять',
    ).toBe(true);
  });
});

describe('без входа отказ называется своим именем', () => {
  it('connectCloud() не ходит в сеть и не объявляет облако выключенным', async () => {
    const host = createTestHost({ files: { 'Идеи.md': '# Идеи\n' }, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);

    expect(await app.connectCloud()).toBe(false);

    expect(app.getState().backendId).toBeNull();
    /* Причина — «сначала войдите», а не «облако выключено». Разница не
       косметическая: `cloudSyncDisabled` убирает с экрана кнопку входа, то
       есть прячет от человека ровно то действие, которое ему и нужно. */
    expect(app.getState().cloudSyncDisabled).toBe(false);
    expect(fetchSpy, 'запрос ушёл без сессии').not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    app.dispose();
  });

  it('карточка облака на экране есть и не помечена недоступной', async () => {
    const host = createTestHost({ files: {}, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
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
      'облако снова помечено недоступным — замок вернулся',
    ).toBeNull();
    app.dispose();
  });
});

describe('«Синхронизировать сейчас» не молчит', () => {
  /*
   * Заказчик: «когда нажимаю на синхронизацию, не происходит ничего». Так и
   * было: без подключённого бэкенда `syncNow` выходил первой же строкой, не
   * сказав ни слова. Человек нажимает и заключает, что сломано приложение —
   * ровно тот же дефект, что «Справка есть, а дороги к ней нет».
   */
  async function toastsOf(prefs: Record<string, unknown>): Promise<string[]> {
    const host = createTestHost({ files: { 'Идеи.md': '# Идеи\n' }, prefs });
    const app = new AppController(host);
    await app.boot();
    const said: string[] = [];
    app.setToastSink((request) => said.push(request.message));
    await app.syncNow();
    app.dispose();
    return said;
  }

  it('без выбранного хранилища объясняет, что синхронизировать не с чем', async () => {
    const said = await toastsOf({ onboarded: true });

    expect(said, 'нажатие осталось без ответа').not.toEqual([]);
    expect(said).toContain(ru.errors.syncNoBackend);
  });

  it('облако выбрано, но вход истёк — зовёт войти, а не жалуется на синк', async () => {
    const said = await toastsOf({ onboarded: true, 'sync.backend': 'zapiski' });

    expect(said).toContain(ru.errors.cloudSignInAgain);
    expect(said, 'сказано «не с чем синхронизировать» там, где нужен вход').not.toContain(
      ru.errors.syncNoBackend,
    );
  });
});

describe('чужие бэкенды это не трогает', () => {
  it('WebDAV подключается как обычно', async () => {
    const { WebDAVBackend } = await import('@zapiski/core');
    const host = createTestHost({ files: {}, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();

    const backend = new WebDAVBackend({
      baseUrl: 'https://example.invalid/dav',
      username: 'marina',
      password: 'secret',
      fetch: vi.fn(async () => new Response(null, { status: 207 })),
    });
    await app.switchBackend(backend);

    expect(app.getState().backendId).toBe('webdav');
    app.dispose();
  });
});
