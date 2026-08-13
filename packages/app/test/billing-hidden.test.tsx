/**
 * Тарифы спрятаны, а не удалены. И вход выглядит как вход.
 *
 * ── Что просил заказчик ─────────────────────────────────────────────────────
 *
 * «На MVP всё должно быть бесплатно, а потом добавим оплату. Экраны с
 * тарифами запомни и не уничтожай, а спрячь».
 *
 * Отсюда две проверки, а не одна: разговора о тарифах в интерфейсе быть не
 * должно — и при этом экран тарифов обязан остаться в коде рабочим, чтобы его
 * можно было вернуть одной строкой, а не писать заново.
 *
 * ── Почему тут же иконка Яндекса ────────────────────────────────────────────
 *
 * Кнопка входа ссылалась на `/assets/yandex-logo.png` — файл, которого нет ни
 * в одной сборке (оригинал лежит в документации). Пустое место на главной
 * кнопке входа — то же самое семейство дефектов, что и paywall на бесплатном
 * продукте: интерфейс говорит не то, что есть на самом деле.
 */
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { BILLING_ENABLED } from '@zapiski/core';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { PaywallScreen } from '../src/screens/PaywallScreen.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { SignInScreen } from '../src/screens/SignInScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

async function mount(node: (app: AppController) => ReactNode): Promise<AppController> {
  const host = createTestHost({ files: {}, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          {node(app)}
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  return app;
}

describe('пока оплаты нет, о ней и не говорим', () => {
  it('выключатель выключен: это решение, а не случайность', () => {
    expect(BILLING_ENABLED, 'оплату включили в приложении — сверьтесь с сервером').toBe(false);
  });

  it('в настройках нет раздела с тарифами', async () => {
    const app = await mount(() => <SettingsScreen section="account" />);
    /* Ищем по названию раздела из реестра, а не по служебному id: человек
       видит именно название. */
    expect(screen.queryByText(ru.settings.sections.plus)).toBeNull();
    app.dispose();
  });

  it('в аккаунте нет строки про тариф', async () => {
    /* Аккаунт задаётся ДО отрисовки: без него раздел показывает приглашение
       войти, и строки про тариф там не будет по совсем другой причине —
       проверка прошла бы, ничего не проверив. */
    const host = createTestHost({ files: {}, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    app.setAccount({ email: 'marina@ya.ru', plan: 'free' });

    render(
      <ThemeProvider persist={false}>
        <ToastProvider>
          <AppProvider host={host} controller={app}>
            <SettingsScreen section="account" />
          </AppProvider>
        </ToastProvider>
      </ThemeProvider>,
    );

    expect(screen.getByText('marina@ya.ru'), 'аккаунт не подставился').toBeTruthy();
    expect(screen.queryByText(ru.settings.account.plan)).toBeNull();
    app.dispose();
  });

  it('экран тарифов цел и открывается сам по себе', async () => {
    /* Спрятан — значит не показывается по дороге, а не «сломан». Монтируем
       напрямую: так проверяется, что возвращать будет что. */
    const app = await mount(() => <PaywallScreen />);
    expect(screen.getByText(ru.paywall.subtitle)).toBeTruthy();
    app.dispose();
  });
});

describe('кнопка входа через Яндекс выглядит как кнопка входа', () => {
  it('логотип приезжает из пакета, а не из адреса, которого нет', async () => {
    const app = await mount(() => <SignInScreen />);
    const logo = document.querySelector('img.za-yandex-logo') as HTMLImageElement | null;

    expect(logo, 'логотипа на кнопке нет вовсе').not.toBeNull();
    const src = logo?.getAttribute('src') ?? '';
    /* Ровно тот дефект, что был: абсолютный путь от корня сайта. В вебе он
       давал 404, в Tauri корень вообще другой. */
    expect(src.startsWith('/assets/'), `логотип снова ищется по адресу ${src}`).toBe(false);
    expect(src.length, 'адрес логотипа пуст').toBeGreaterThan(0);
    app.dispose();
  });
});
