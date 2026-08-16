/**
 * Первый экран в браузере заканчивается заметкой, а не диалогом файловой
 * системы.
 *
 * ── Что случилось у человека ────────────────────────────────────────────────
 *
 * Постороннему человеку дали открыть zapiski.cmpas.ru с Android. Он вошёл,
 * нажал «Новая записка» — сайт ответил «папка недоступна». Обновил страницу,
 * выбрал вместо облака папку — открылось системное окно выбора папки, он
 * выбрал каталог, и экран замер на кнопке «Дальше» насовсем.
 *
 * Причин две, и обе здесь проверяются. Сайту папка не нужна вовсе: его
 * хранилище — хранилище браузера. А проверка выбранной папки идёт через
 * провайдер Android, который имеет право не ответить никогда, — значит
 * спрашивать её на первом экране нельзя даже там, где диалог открывается.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { OnboardingScreen } from '../src/screens/OnboardingScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

function mount(app: AppController): void {
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={app.host} controller={app}>
          <OnboardingScreen step={2} />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe('онбординг в браузере', () => {
  it('не открывает выбор папки даже тогда, когда браузер отказал в хранилище', async () => {
    const host = createTestHost();
    /* Ровно тот случай: платформа объявляет себя вебом. */
    (host.platform as { kind: string }).kind = 'web';
    /*
      Хранилища браузера НЕТ — это и есть положение того человека: приватное
      окно, запрет на данные сайтов или пустая квота. Именно здесь прежний код
      шёл к выбору папки: `storage ??= pickVaultDirectory()`. На телефоне это
      открывало системный диалог, который потом не отвечал.
    */
    (host as unknown as { restoreVault: () => Promise<null> }).restoreVault = async () => null;
    const picker = vi.fn(async () => null);
    (host.platform as unknown as { pickVaultDirectory: () => Promise<null> }).pickVaultDirectory =
      picker;
    const app = new AppController(host);
    await app.boot();
    mount(app);

    fireEvent.click(screen.getByRole('button', { name: ru.onboarding.step2.next }));

    await waitFor(() => expect(app.getState().route.name).not.toBe('onboarding'));
    expect(picker, 'сайт снова спрашивает папку — человеку её выбирать негде').not.toHaveBeenCalled();
    /* И человек услышал настоящую причину, а не «папка недоступна». */
    expect(
      screen.queryByText(ru.errors.browserStorageUnavailable),
      'про отказ браузера не сказано ни слова',
    ).toBeTruthy();
    app.dispose();
  });

  it('кнопка обещает «Дальше», а не выбор папки', async () => {
    const host = createTestHost();
    (host.platform as { kind: string }).kind = 'web';
    const app = new AppController(host);
    await app.boot();
    mount(app);

    /* Даже когда выбрано облако: в браузере следующий шаг — вход, а не
       файловый диалог. */
    fireEvent.click(screen.getByText(ru.onboarding.step2.options.cloud.title));
    expect(screen.getByRole('button', { name: ru.onboarding.step2.next })).toBeTruthy();
    expect(screen.queryByRole('button', { name: ru.onboarding.step2.pickFolder })).toBeNull();
    app.dispose();
  });

  it('в оболочке (Windows) выбор папки остаётся — там он и уместен', async () => {
    const host = createTestHost();
    (host.platform as { kind: string }).kind = 'windows';
    const picker = vi.fn(async () => null);
    (host.platform as unknown as { pickVaultDirectory: () => Promise<null> }).pickVaultDirectory =
      picker;
    const app = new AppController(host);
    await app.boot();
    mount(app);

    /* Кнопка называет то, что случится: на Windows следом откроется окно
       выбора папки, и «Дальше» было бы обещанием мимо дела. */
    fireEvent.click(screen.getByRole('button', { name: ru.onboarding.step2.pickFolder }));
    await waitFor(() => expect(picker).toHaveBeenCalled());
    app.dispose();
  });
});
