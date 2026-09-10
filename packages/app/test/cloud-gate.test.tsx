/**
 * SEC-001 — облако включено, и включено по ДВУМ условиям.
 *
 * ── Что здесь было раньше ───────────────────────────────────────────────────
 *
 * Этот файл назывался `cloud-kill-switch.test.tsx` и стерёг обратное:
 * `CLOUD_SYNC_ENABLED === false`. Выключатель ставили потому, что облако не
 * оборачивало содержимое заметки собственным ключом — сервер получал его как
 * есть. Дефекта больше нет: конверт AES-256-GCM под ключами из SMK, путь
 * заменён токеном, а прикладная фабрика физически не собирает бэкенд без
 * ключа (`state/cloud-access.ts`, `cloud-access.test.ts`, сквозной сценарий —
 * `packages/core/test/sec001.e2e.test.ts`).
 *
 * ── Что стережётся теперь ───────────────────────────────────────────────────
 *
 * Второе условие никуда не делось и оно платформенное: ключ синка обязан
 * лежать в хранилище уровня Keychain/Keystore/DPAPI. У браузера аппаратного
 * эквивалента нет (design §3.1), поэтому в вебе Облако выключено ЧЕСТНО и по
 * названной причине — а не тихо и не «пока не успели». Именно это и
 * проверяется: что веб не предлагает того, чего не может, а Windows, macOS и
 * Android этим не задерживаются.
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

describe('в вебе Облако не предлагается — и причина названа', () => {
  it('в настройках карточка есть, но помечена недоступной', async () => {
    const host = createTestHost({ files: {}, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    mountSettings(app);

    /* Карточка на месте — но сказано, что в браузере она не работает, и
       почему. Спрятать её значило бы оставить человека гадать. */
    expect(await screen.findByText(ru.settings.sync.cloudUnavailableBadge)).toBeTruthy();
    expect(screen.getByText(ru.settings.sync.modeLocalOnly)).toBeTruthy();
    app.dispose();
  });

  it('в онбординге варианта «Облако Записок» нет', async () => {
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

    expect(screen.queryByText(ru.onboarding.step2.options.cloud.title)).toBeNull();
    expect(screen.getByText(ru.onboarding.step2.options.local.title)).toBeTruthy();
    expect(screen.getByText(ru.onboarding.step2.options.own.title)).toBeTruthy();
    app.dispose();
  });

  it('connectCloud() отказывает ДО сети — ни один байт не уходит', async () => {
    const host = createTestHost({ files: { 'Идеи.md': '# Идеи\n' }, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);

    expect(await app.connectCloud()).toBe(false);

    expect(app.getState().backendId).toBeNull();
    expect(app.getState().cloudSyncDisabled, 'причина не названа').toBe(true);
    expect(fetchSpy, 'запрос ушёл, хотя облако недоступно на этой платформе').not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    app.dispose();
  });
});

describe('у кого облако было выбрано в вебе — оно не переподключается молча', () => {
  async function bootWithCloudAlreadyChosen(): Promise<AppController> {
    const host = createTestHost({
      files: { 'Идеи.md': '# Идеи\n' },
      prefs: { onboarded: true, 'sync.backend': 'zapiski' },
    });
    const app = new AppController(host);
    await app.boot();
    return app;
  }

  it('resumeCloud() отказывается переподключать облако при старте', async () => {
    const app = await bootWithCloudAlreadyChosen();
    await waitFor(() => expect(app.getState().backendChoice).toBe('zapiski'));

    /* Выбор человека помнится... */
    expect(app.getState().backendChoice, 'выбор стёрт вместо честного отказа').toBe('zapiski');
    /* ...но подключения нет: ключ синка в браузере держать негде. */
    expect(app.getState().backendId, 'облако подключилось само на неподдержанной платформе').toBeNull();
    expect(app.getState().cloudSyncDisabled, 'причина не названа').toBe(true);
    app.dispose();
  });

  it('на экране карточка честно недоступна, а не притворяется рабочей', async () => {
    const app = await bootWithCloudAlreadyChosen();
    await waitFor(() => expect(app.getState().backendChoice).toBe('zapiski'));
    mountSettings(app);

    const cloud = (await screen.findByText(ru.settings.sync.cloud)).closest('.za-card');
    expect(cloud, 'карточка Облака пропала у того, кто её уже выбирал').not.toBeNull();
    expect(cloud?.className).toContain('za-card--selected');

    /* Честный текст — и плашкой в разделе, и внутри самой карточки. */
    expect(screen.getAllByText(ru.errors.cloudSyncDisabled).length).toBeGreaterThan(0);
    expect(await screen.findByText(ru.settings.sync.encryptionWebOnly)).toBeTruthy();
    app.dispose();
  });

  it('нажатие на карточку не уводит на экран входа — вход тут не помог бы', async () => {
    const app = await bootWithCloudAlreadyChosen();
    await waitFor(() => expect(app.getState().backendChoice).toBe('zapiski'));
    mountSettings(app);

    const beginSignIn = vi.spyOn(app, 'beginSignIn');
    const card = (await screen.findByText(ru.settings.sync.cloud)).closest('button');
    expect(card, 'у карточки нет собственной кнопки').not.toBeNull();
    fireEvent.click(card as HTMLButtonElement);

    expect(beginSignIn, 'клик по недоступной карточке отправил человека входить').not.toHaveBeenCalled();
    expect(app.getState().backendId).toBeNull();
    app.dispose();
  });
});

describe('там, где хранилище ключа есть, облако предлагается', () => {
  it('Windows: вариант «Облако Записок» виден в онбординге', async () => {
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

  it('Windows: карточка в настройках не помечена недоступной', async () => {
    const host = createTestHost({ files: {}, prefs: { onboarded: true }, platform: nativePlatform() });
    const app = new AppController(host);
    await app.boot();
    mountSettings(app);

    expect(await screen.findByText(ru.settings.sync.cloud)).toBeTruthy();
    expect(screen.queryByText(ru.settings.sync.cloudUnavailableBadge)).toBeNull();
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
