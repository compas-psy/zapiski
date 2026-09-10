/**
 * Приложение не меняет решение человека о том, где живут заметки.
 *
 * ── Что случилось ───────────────────────────────────────────────────────────
 *
 * «Вчера установил приложение, сразу подключил облако — всё синхронизировал.
 * Сегодня вновь открыл, и оно само переключилось на локальную папку, а файлы
 * исчезли. Почему само переключилось и кнопка "Облако Записок" не нажимается?»
 *
 * Переключения не было. Выбор так и лежал в настройках устройства, но вход в
 * облако за ночь перестал действовать (сессия истекает, отзывается, не
 * переживает переустановку — это норма). Подключиться не вышло, а экран
 * показывал ТОЛЬКО подключённое — то есть «Только на этом устройстве». Со
 * стороны это неотличимо от того, что приложение само передумало.
 *
 * Здесь проверяется обратное: выбор остаётся выбором, отказ называется вслух,
 * а починка предлагается та, которая помогает, — «войти», а не «повторить».
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

/** Устройство человека: облако выбрано, входа больше нет. */
async function bootWithoutSession(): Promise<AppController> {
  const host = createTestHost({
    files: { 'Идеи.md': '# Идеи\n' },
    prefs: { onboarded: true, 'sync.backend': 'zapiski' },
  });
  const app = new AppController(host);
  await app.boot();
  return app;
}

function mount(app: AppController): void {
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

describe('выбор хранилища переживает потерю входа', () => {
  /*
   * Прежде оба теста ниже видели другое: до проверки сессии в `resumeCloud`
   * срабатывал замок — сперва выключатель SEC-001, потом платформенный, — и
   * приложение говорило «синхронизация недоступна». Сказать «войдите снова»
   * тогда было бы неправдой: повторный вход облако всё равно не поднял бы.
   *
   * Замков больше нет, и ветка `cloudNeedsSignIn`, которую прежний
   * комментарий обещал вернуть, стала достижимой. Теперь причина названа
   * верно И лечится предложенным действием — а это разные вещи, и вторая
   * важнее.
   */
  it('облако остаётся выбранным, а не подменяется локальной папкой', async () => {
    const app = await bootWithoutSession();
    await waitFor(() => expect(app.getState().backendChoice).toBe('zapiski'));

    expect(
      app.getState().backendId,
      'подключения нет — и это правда, менять её не надо',
    ).toBeNull();
    expect(
      app.getState().cloudNeedsSignIn,
      'приложение молчит о том, что нужно войти снова',
    ).toBe(true);
    expect(
      app.getState().cloudSyncDisabled,
      'облако объявлено выключенным — это неверная причина, оно просто без входа',
    ).toBe(false);
    app.dispose();
  });

  it('на экране отмечено облако, а причина — вход, и её можно исправить', async () => {
    const app = await bootWithoutSession();
    await waitFor(() => expect(app.getState().backendChoice).toBe('zapiski'));
    mount(app);

    /* Карточка облака помечена «сейчас», а не карточка локальной папки. */
    const cloud = (await screen.findByText(ru.settings.sync.cloud)).closest('.za-card');
    expect(cloud?.className, 'выбранным показано не то, что выбирал человек').toContain(
      'za-card--selected',
    );

    const local = screen.getByText(ru.settings.sync.modeLocalOnly).closest('.za-card');
    expect(local?.className).not.toContain('za-card--selected');

    expect(screen.getAllByText(ru.errors.cloudSignInAgain).length).toBeGreaterThan(0);
    app.dispose();
  });

  it('карточка нажимается целиком, а не одной верхней строкой', async () => {
    const app = await bootWithoutSession();
    mount(app);

    /*
      Заказчик: «кнопка Облако Записок не нажимается». Она работала, но
      занимала только строку заголовка: описание под ней к нажатию отношения
      не имело, а на телефоне это две трети карточки.
    */
    const hint = await screen.findByText(ru.settings.sync.modeLocalOnlyHint);
    expect(
      hint.closest('button'),
      'описание карточки вне кнопки — мимо него человек и промахивается',
    ).toBeTruthy();
    app.dispose();
  });
});
