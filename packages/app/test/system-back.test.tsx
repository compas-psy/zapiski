/**
 * Системное «назад»: кнопка и жест Android.
 *
 * ── Что прислал заказчик ────────────────────────────────────────────────────
 *
 * «Системная андроидовская кнопка назад должна работать на любом окне
 * приложения. Сейчас (я использую свайп справа с краю налево) меня перекидывает
 * в систему, а не оставляет в приложении».
 *
 * Так и было, и причина не в жесте: Tauri сознательно не вешает свой
 * обработчик (`handleBackNavigation = false`), поэтому событие уходило системе
 * как «закрыть приложение» — одинаково из настроек, из заметки и из открытой
 * библиотеки.
 *
 * Здесь проверяется продуктовая половина: что считать шагом назад. Половина
 * платформенная — активность спрашивает фронтенд и уважает ответ — живёт в
 * `apps/mobile` и проверяется сборкой.
 *
 * Отдельная проверка внизу — про «назад» на корневом экране: там приложение
 * обязано сказать «мне нечего закрывать» и отпустить человека. Приложение, из
 * которого не выйти, — дефект не меньший, чем то, на что жаловался заказчик.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../src/App.js';
import { AppController } from '../src/state/store.js';
import { createTestHost } from './host.js';

afterEach(cleanup);

async function boot(files: Record<string, string> = {}): Promise<AppController> {
  const host = createTestHost({ files, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  return app;
}

describe('назад закрывает то, что лежит поверх экрана', () => {
  it('открытая библиотека закрывается, а не выбрасывает из приложения', async () => {
    const app = await boot();
    app.toggleLibrary(true);

    expect(app.handleSystemBack(), 'приложение отдало жест системе').toBe(true);
    expect(app.getState().libraryOpen).toBe(false);
    app.dispose();
  });

  it('палитра команд закрывается первой — она поверх всего', async () => {
    const app = await boot();
    app.toggleLibrary(true);
    app.togglePalette(true);

    expect(app.handleSystemBack()).toBe(true);
    expect(app.getState().paletteOpen).toBe(false);
    /* Библиотека под палитрой осталась: одно нажатие — один слой. */
    expect(app.getState().libraryOpen).toBe(true);
    app.dispose();
  });

  it('режим фокуса возвращает хром, а не закрывает заметку', async () => {
    const app = await boot({ 'Идеи.md': '# Идеи\n' });
    app.openNote('Идеи.md');
    app.toggleFocusMode(true);

    expect(app.handleSystemBack()).toBe(true);
    expect(app.getState().focusMode).toBe(false);
    expect(app.getState().route.name, 'заметку закрыли вместе с режимом фокуса').toBe('note');
    app.dispose();
  });
});

describe('назад ведёт по экранам', () => {
  it('из настроек возвращает туда, откуда пришли', async () => {
    const app = await boot({ 'Идеи.md': '# Идеи\n' });
    app.openNote('Идеи.md');
    app.openSettings();

    expect(app.handleSystemBack()).toBe(true);
    const route = app.getState().route;
    expect(route.name).toBe('note');
    app.dispose();
  });

  it('из заметки — к списку', async () => {
    const app = await boot({ 'Идеи.md': '# Идеи\n' });
    app.openNote('Идеи.md');

    expect(app.handleSystemBack()).toBe(true);
    expect(app.getState().route.name).toBe('list');
    app.dispose();
  });

  it('из папки — ко всем заметкам, а не наружу', async () => {
    const app = await boot({ 'Практика/Разбор.md': '# Разбор\n' });
    app.openFolder('Практика');
    /* Открытие папки — это переход, поэтому первый «назад» разбирает историю
       экранов, а второй снимает сам фильтр. Оба остаются внутри приложения. */
    while (app.handleSystemBack()) {
      if (app.getState().folder === null) break;
    }
    expect(app.getState().folder, 'фильтр по папке пережил «назад»').toBeNull();
    app.dispose();
  });
});

describe('назад на корневом экране отпускает', () => {
  it('в списке без фильтров приложение говорит «мне нечего закрывать»', async () => {
    const app = await boot();
    expect(
      app.handleSystemBack(),
      'приложение удерживает жест — из него нельзя будет выйти',
    ).toBe(false);
    app.dispose();
  });
});

describe('оболочка подключена к этому разбору', () => {
  it('живое приложение отвечает на нажатие и закрывает открытый экран', async () => {
    /* Без подписки вся работа выше бесполезна: активность спросит, а отвечать
       будет некому — и жест снова уведёт человека в систему. Поэтому здесь
       настоящее приложение целиком, а не контроллер отдельно. */
    let handler: (() => boolean) | null = null;
    const host = {
      /* Платформа именно Android: в вебе без аккаунта поднимаются ворота
         входа, а «назад» — история про приложение за ними. */
      ...createTestHost({
        files: { 'Идеи.md': '# Идеи\n' },
        prefs: { onboarded: true },
        platform: { kind: 'android' },
      }),
      onSystemBack: (fn: () => boolean): (() => void) => {
        handler = fn;
        return () => {
          handler = null;
        };
      },
    };

    render(<App host={host} />);
    await waitFor(() => expect(handler, 'порт «назад» никто не слушает').not.toBeNull());

    const ask = handler as unknown as () => boolean;
    /* Открываем библиотеку так, как её открывает человек на телефоне — кнопкой
       в шапке списка. */
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть библиотеку' }));
    await screen.findByRole('button', { name: 'Справка' });

    expect(ask(), 'приложение отдало жест системе прямо с открытой библиотекой').toBe(true);
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Справка' }),
        'библиотека осталась открытой — «назад» до приложения не дошло',
      ).toBeNull(),
    );
  });
});
