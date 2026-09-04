/**
 * Шаг 2 онбординга: папку спрашивают только там, где вопрос осмыслен.
 *
 * ── Как менялось требование ─────────────────────────────────────────────────
 *
 * Сначала заказчик писал про Android: «самый главный косяк — не выбирается
 * папка, где хранить заметки». Тогда онбординг научился звать системный выбор
 * (`vaultFolders.chooseFolder`), и этот файл сторожил именно вызов диалога.
 *
 * Проверив живую сборку, заказчик уточнил: «выбор папки — лишнее для Android и
 * требует пояснений на Windows и Web». Он прав, и первое требование это не
 * отменяет, а уточняет: **выбрать** папку по-прежнему можно — но по своей
 * воле, в настройках, а не на первом запуске. На телефоне человек нажимает
 * «Облако Записок» и получает файловый диалог, из которого не следует ничего:
 * ни где окажутся заметки, ни зачем это спрашивают.
 *
 * Правило теперь такое:
 *  • Android — папка приложения молча, без системного окна;
 *  • веб — папки нет вовсе;
 *  • Windows — окно нужно по делу (умолчания там нет), и тогда до нажатия
 *    сказано, зачем оно.
 *
 * Вторая половина правила — «выбор остался в настройках» — сторожится в
 * `vault-location.test.tsx`: там проверяется и сам выбор, и предупреждение о
 * цене (поверх системного провайдера атомарной записи нет).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@zapiski/ui';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { OnboardingScreen } from '../src/screens/OnboardingScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

/** Экран шага 2 на заданной платформе. */
function mount(host: ReturnType<typeof createTestHost>): AppController {
  const app = new AppController(host);
  render(
    <ToastProvider>
      <AppProvider host={host} controller={app}>
        <OnboardingScreen step={2} />
      </AppProvider>
    </ToastProvider>,
  );
  return app;
}

describe('шаг 2: выбор места для заметок', () => {
  it('Android не спрашивает папку — заметки ложатся в папку приложения', async () => {
    const chooseFolder = vi.fn(async () => null);
    const pick = vi.fn(async () => null);
    const base = createTestHost();
    const host = {
      ...base,
      platform: {
        ...base.platform,
        kind: 'android' as const,
        pickVaultDirectory: pick,
        vaultFolders: { chooseFolder, useAppFolder: async () => null, current: async () => null },
      },
    };

    const app = mount(host);
    /* Кнопка обещает то, что произойдёт: никакого «Выбрать папку». */
    fireEvent.click(screen.getByRole('button', { name: ru.onboarding.step2.next }));

    await waitFor(() => expect(pick).toHaveBeenCalled());
    expect(
      chooseFolder,
      'на первом запуске Android открыл системный выбор папки — человек его не просил',
    ).not.toHaveBeenCalled();
    /* И сказано, где заметки окажутся и как выбрать другую папку потом. */
    expect(screen.getByText(ru.onboarding.step2.whereAndroid)).toBeTruthy();
    app.dispose();
  });

  it('Windows спрашивает папку и объясняет зачем', async () => {
    /* Умолчания на Windows нет: заметки обязаны лечь в папку, которую человек
       назовёт. Значит окно нужно — а раз нужно, о нём говорят заранее. */
    const base = createTestHost();
    const pick = vi.fn(async () => null);
    const host = {
      ...base,
      platform: {
        ...base.platform,
        kind: 'windows' as const,
        vaultFolders: undefined,
        pickVaultDirectory: pick,
      },
    };

    const app = mount(host);
    expect(screen.getByText(ru.onboarding.step2.whereDesktop)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: ru.onboarding.step2.pickFolder }));

    await waitFor(() => expect(pick).toHaveBeenCalled());
    app.dispose();
  });

  it('Windows: варианта «Облако Записок» в онбординге больше нет (SEC-001 kill-switch)', () => {
    /*
      Раньше здесь проверялось «выбор облака тоже ведёт к папке, и кнопка об
      этом говорит» — прежде при выборе облака кнопка говорила «Дальше», а
      окно выбора папки всё равно открывалось. Тот дефект по-прежнему
      исправлен, но сам вариант временно не предлагается вовсе
      (`CLOUD_SYNC_ENABLED`, `core/cloud-sync.ts`, `cloud-kill-switch.test.tsx`)
      — пока это так, кликнуть по нему в онбординге невозможно физически, и
      старая проверка вернётся вместе с флагом.
    */
    const base = createTestHost();
    const pick = vi.fn(async () => null);
    const host = {
      ...base,
      platform: { ...base.platform, kind: 'windows' as const, pickVaultDirectory: pick },
    };

    const app = mount(host);
    expect(screen.queryByText(ru.onboarding.step2.options.cloud.title)).toBeNull();
    app.dispose();
  });

  it('в браузере папки нет вовсе', async () => {
    const base = createTestHost();
    const pick = vi.fn(async () => null);
    const host = { ...base, platform: { ...base.platform, kind: 'web' as const, pickVaultDirectory: pick } };

    const app = mount(host);
    expect(screen.getByText(ru.onboarding.step2.whereWeb)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: ru.onboarding.step2.next }));

    await waitFor(() => expect(app.getState().route.name).not.toBe('onboarding'));
    expect(pick, 'сайт полез спрашивать папку, которой у него нет').not.toHaveBeenCalled();
    app.dispose();
  });
});
