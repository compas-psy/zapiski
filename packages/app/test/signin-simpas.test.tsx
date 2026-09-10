/**
 * Экран входа после перехода на единый СИМПАС.
 *
 * Решение учредителя: на экране остаётся ОДНА кнопка, Яндекс и почта уходят.
 * Отсюда два обязательства, и второе важнее первого.
 *
 * ── Одна кнопка ─────────────────────────────────────────────────────────────
 *
 * Пока сервер объявляет `simpas: true`, никаких других способов на экране быть
 * не должно: два входа рядом — это два разных аккаунта у одного человека,
 * заведённых по невнимательности.
 *
 * ── Аварийная дверь ─────────────────────────────────────────────────────────
 *
 * Раз СИМПАС становится единственной дверью, его недоступность = наша
 * недоступность для новых входов. Агент единого входа сформулировал границу
 * точно: «маршрут, до которого человеку не добраться, аварийным путём не
 * является». Поэтому почтовый вход остаётся достижимым по адресу `?door=email`
 * — без кнопки, но по-настоящему.
 *
 * И третье, менее очевидное: пока сервер СИМПАС не настроен, экран обязан
 * показывать прежние способы. Иначе выкладка кода вперёд ключа заперла бы вход
 * целиком.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { SignInScreen } from '../src/screens/SignInScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Сервер, который объявляет ровно то, что попросили. */
function serverWith(methods: { yandex: boolean; simpas: boolean }): typeof fetch {
  return (async (input: string) => {
    if (String(input).includes('/auth/methods')) {
      return new Response(JSON.stringify(methods), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

async function mount(
  methods: { yandex: boolean; simpas: boolean },
  search = '',
): Promise<AppController> {
  vi.stubGlobal('fetch', serverWith(methods));
  /* Адрес читается экраном напрямую: аварийная дверь — это именно адрес, а не
     состояние приложения, иначе до неё не добраться из браузера. */
  window.history.replaceState({}, '', `/notes/${search}`);

  const host = createTestHost({ files: {}, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <SignInScreen />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  return app;
}

describe('единый вход настроен', () => {
  it('на экране одна кнопка — ни Яндекса, ни почты', async () => {
    const app = await mount({ yandex: true, simpas: true });

    expect(await screen.findByRole('button', { name: ru.signIn.simpas })).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: ru.signIn.yandex }),
        'Яндекс остался на экране — два входа заведут человеку два аккаунта',
      ).toBeNull(),
    );
    expect(
      screen.queryByRole('button', { name: ru.signIn.sendLink }),
      'почтовый вход остался кнопкой',
    ).toBeNull();
    app.dispose();
  });

  it('нажатие уводит на СИМПАС системным браузером', async () => {
    const app = await mount({ yandex: true, simpas: true });
    const opened: string[] = [];
    app.host.openExternal = async (url: string) => {
      opened.push(url);
    };

    (await screen.findByRole('button', { name: ru.signIn.simpas })).click();

    await waitFor(() => expect(opened.length, 'нажатие не открыло ничего').toBeGreaterThan(0));
    expect(opened[0]).toContain('/auth/simpas');
    app.dispose();
  });

  it('аварийная дверь ?door=email показывает почтовый вход', async () => {
    const app = await mount({ yandex: false, simpas: true }, '?door=email');

    expect(
      await screen.findByRole('button', { name: ru.signIn.sendLink }),
      'дверь недостижима — аварийным путём это не является',
    ).toBeTruthy();
    app.dispose();
  });
});

describe('единый вход ещё не настроен', () => {
  it('показывает прежние способы, а не запертую дверь', async () => {
    const app = await mount({ yandex: true, simpas: false });

    expect(await screen.findByRole('button', { name: ru.signIn.yandex })).toBeTruthy();
    expect(screen.getByRole('button', { name: ru.signIn.sendLink })).toBeTruthy();
    expect(screen.queryByRole('button', { name: ru.signIn.simpas })).toBeNull();
    app.dispose();
  });
});
