/**
 * Облако включено и доступно ВЕЗДЕ.
 *
 * ── Что здесь было раньше ───────────────────────────────────────────────────
 *
 * Файл дважды менял смысл вместе с продуктом, и это стоит держать перед
 * глазами. Сначала он назывался `cloud-kill-switch.test.tsx` и стерёг
 * `CLOUD_SYNC_ENABLED === false` — облако было выключено целиком, потому что
 * содержимое уходило на сервер как есть. Потом стерёг ДВА условия: флаг и
 * платформу, потому что ключ сквозного шифрования негде держать в браузере.
 *
 * ── Что стережётся теперь ───────────────────────────────────────────────────
 *
 * Решение владельца — убрать сквозное шифрование из MVP и вернуть позже через
 * внешнюю ключницу — снимает ВТОРОЕ условие: ключа на пути пользователя нет,
 * хранить в вебе нечего, и платформенный замок стал запретом без причины. Он
 * стоил дорого: облака не было ни в вебе, ни на телефоне без биометрии, и
 * человек узнавал об этом, только добравшись до настроек.
 *
 * Поэтому здесь проверяется обратное прежнему: облако предлагается на КАЖДОЙ
 * платформе, включая веб; отказ без входа ведёт на вход, а не в тупик; и
 * чужие бэкенды всё это по-прежнему не трогает.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CLOUD_SYNC_ENABLED, type PlatformCapabilities } from '@zapiski/core';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { OnboardingScreen } from '../src/screens/OnboardingScreen.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost, fakeBiometrics } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

/** Оболочка с защищённым хранилищем ключа — Windows, macOS, Android. */
function nativePlatform(): Partial<PlatformCapabilities> {
  return { kind: 'windows', biometrics: fakeBiometrics().provider };
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

describe('выключатель снят — это решение, а не случайность', () => {
  it('CLOUD_SYNC_ENABLED === true', () => {
    expect(
      CLOUD_SYNC_ENABLED,
      'облако выключено — значит SEC-001 снова открыт; сверьтесь с design doc и sec001.e2e.test.ts',
    ).toBe(true);
  });
});

describe('в вебе Облако предлагается наравне со всеми', () => {
  it('в настройках карточка не помечена недоступной', async () => {
    const host = createTestHost({ files: {}, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    mountSettings(app);

    expect(await screen.findByText(ru.settings.sync.cloud)).toBeTruthy();
    expect(
      screen.queryByText(ru.settings.sync.cloudUnavailableBadge),
      'веб снова помечен недоступным — платформенный замок вернулся',
    ).toBeNull();
    app.dispose();
  });

  it('в онбординге вариант «Облако Записок» есть', async () => {
    const host = createTestHost({ files: {}, prefs: {} });
    const app = new AppController(host);
    await app.boot();
    render(
      <ThemeProvider persist={false}>
        <ToastProvider>
          <AppProvider host={host} controller={app}>
            <OnboardingScreen step={2} />
          </AppProvider>
        </ToastProvider>
      </ThemeProvider>,
    );

    expect(screen.getByText(ru.onboarding.step2.options.cloud.title)).toBeTruthy();
    app.dispose();
  });

  it('без входа connectCloud() не ходит в сеть, но и не врёт про платформу', async () => {
    const host = createTestHost({ files: { 'Идеи.md': '# Идеи\n' }, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);

    /* Сессии нет — подключать нечего. Но причина теперь другая: не «эта
       платформа не умеет», а «сначала войдите». Поэтому `cloudSyncDisabled`
       НЕ поднимается: он означает «облако выключено совсем», и поднять его
       здесь значило бы назвать неверную причину и спрятать кнопку входа. */
    expect(await app.connectCloud()).toBe(false);

    expect(app.getState().backendId).toBeNull();
    expect(app.getState().cloudSyncDisabled, 'облако объявлено выключенным без причины').toBe(false);
    expect(fetchSpy, 'запрос ушёл без сессии').not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    app.dispose();
  });

  it('нажатие на карточку ведёт на вход, а не в тупик', async () => {
    const host = createTestHost({ files: {}, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    mountSettings(app);

    /* Карточка режима свёрнута, пока её не выбрали, — как и у остальных
       вариантов синка. Сначала раскрываем её, потом жмём кнопку внутри. */
    fireEvent.click(await screen.findByText(ru.settings.sync.cloud));
    fireEvent.click(await screen.findByRole('button', { name: ru.settings.sync.cloudEnable }));

    await waitFor(() => expect(app.getState().route.name).toBe('signin'));
    app.dispose();
  });
});

describe('нативная платформа без биометрии тоже не заперта', () => {
  it('Windows без хранилища ключа: карточка доступна', async () => {
    const host = createTestHost({
      files: {},
      prefs: { onboarded: true },
      platform: { kind: 'windows', biometrics: null },
    });
    const app = new AppController(host);
    await app.boot();
    mountSettings(app);

    expect(await screen.findByText(ru.settings.sync.cloud)).toBeTruthy();
    expect(screen.queryByText(ru.settings.sync.cloudUnavailableBadge)).toBeNull();
    app.dispose();
  });

  it('Windows с хранилищем: как было', async () => {
    const host = createTestHost({ files: {}, prefs: {}, platform: nativePlatform() });
    const app = new AppController(host);
    await app.boot();
    render(
      <ThemeProvider persist={false}>
        <ToastProvider>
          <AppProvider host={host} controller={app}>
            <OnboardingScreen step={2} />
          </AppProvider>
        </ToastProvider>
      </ThemeProvider>,
    );

    expect(screen.getByText(ru.onboarding.step2.options.cloud.title)).toBeTruthy();
    app.dispose();
  });
});

describe('чужие бэкенды гейт не трогает', () => {
  it('WebDAV подключается как обычно — SEC-001 про Облако Записок, не про него', async () => {
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
