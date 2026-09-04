/**
 * SEC-001 kill-switch: временная мера, пока zero-knowledge-синк не готов.
 *
 * ── Что просил заказчик (P1-аудит closure-pass) ─────────────────────────────
 *
 * «SEC-001 не теоретический — облако доступно и синк идёт открытым текстом.
 * Пока zero-knowledge не реализован: спрятать/выключить "Облако Записок" для
 * обычных пользователей; НЕ удалять код облака; сделать явный feature flag,
 * а не закомментированный интерфейс; человек, у которого облако уже было
 * включено, не должен продолжать молча слать открытый текст; показать
 * корректное состояние "Облачная синхронизация временно недоступна"».
 *
 * Это не решение SEC-001, а его отсрочка — сам класс `ZapiskiCloudBackend`,
 * весь `sync/**`, серверные маршруты `/vault/*` остаются на месте и
 * по-прежнему покрыты собственными тестами (`packages/core/test/sync.test.ts`,
 * `security.zero-knowledge.test.ts`) — они конструируют бэкенд напрямую и
 * флага не видят: он стоит на прикладном уровне (`AppController.
 * connectCloud`/`resumeCloud`), а не в самом протоколе.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CLOUD_SYNC_ENABLED } from '@zapiski/core';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { OnboardingScreen } from '../src/screens/OnboardingScreen.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

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

describe('выключатель выключен — это решение, а не случайность', () => {
  it('CLOUD_SYNC_ENABLED === false', () => {
    expect(
      CLOUD_SYNC_ENABLED,
      'облачная синхронизация включена — SEC-001 должен быть реализован, сверьтесь с design doc',
    ).toBe(false);
  });
});

describe('новому человеку Облако Записок не предлагается', () => {
  it('в настройках карточки Облака нет вовсе', async () => {
    const host = createTestHost({ files: {}, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    mountSettings(app);

    expect(screen.queryByText(ru.settings.sync.cloud)).toBeNull();
    /* Остальные режимы — на месте, прячем только облако. */
    expect(screen.getByText(ru.settings.sync.modeLocalOnly)).toBeTruthy();
    app.dispose();
  });

  it('в онбординге варианта «Облако Записок» тоже нет', async () => {
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
});

describe('у кого облако уже было включено — оно не переподключается молча', () => {
  /** Устройство человека, который подключил Облако ДО того, как узнали про SEC-001. */
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
    /* ...но подключения нет — ни байта содержимого заметки никуда не ушло. */
    expect(app.getState().backendId, 'облако подключилось само, несмотря на флаг').toBeNull();
    expect(app.getState().cloudSyncDisabled, 'причина не названа').toBe(true);
    app.dispose();
  });

  it('connectCloud() отказывает до сети — ни один запрос не уходит', async () => {
    const app = await bootWithCloudAlreadyChosen();
    /* boot() уже прогнал resumeCloud и получил отказ — пробуем ещё раз явно,
       как если бы человек сам нажал на карточку. */
    const connected = await app.connectCloud();

    expect(connected, 'connectCloud() отчитался об успехе при выключенном флаге').toBe(false);
    expect(app.getState().backendId).toBeNull();
    expect(app.getState().cloudSyncDisabled).toBe(true);
    app.dispose();
  });

  it('на экране карточка облака честно недоступна, а не пропадает и не притворяется рабочей', async () => {
    const app = await bootWithCloudAlreadyChosen();
    await waitFor(() => expect(app.getState().backendChoice).toBe('zapiski'));
    mountSettings(app);

    /* Карточка осталась — иначе человек не понял бы, куда делись заметки. */
    const cloud = (await screen.findByText(ru.settings.sync.cloud)).closest('.za-card');
    expect(cloud, 'карточка Облака пропала у того, кто её уже выбирал').not.toBeNull();
    expect(cloud?.className).toContain('za-card--selected');

    /* Честный текст — и на карточке, и плашкой (тост живёт секунды и уходит,
       плашка настроек остаётся). */
    expect(screen.getAllByText(ru.errors.cloudSyncDisabled).length).toBeGreaterThan(0);
    expect(screen.getByText(ru.settings.sync.cloudUnavailableBadge)).toBeTruthy();
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

    /*
     * Отличие от `cloudNeedsSignIn` (истёкшая сессия, `backend-choice.test.tsx`)
     * принципиально: там нажатие ведёт входить, потому что вход решает
     * проблему. Здесь — не решает, поэтому карточка не должна пытаться.
     */
    expect(beginSignIn, 'клик по недоступной карточке отправил человека входить').not.toHaveBeenCalled();
    expect(app.getState().backendId).toBeNull();
    app.dispose();
  });
});

describe('чужие бэкенды флаг не трогает', () => {
  it('WebDAV и Яндекс.Диск подключаются как обычно — SEC-001 про CMPAS Cloud, не про них', async () => {
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
