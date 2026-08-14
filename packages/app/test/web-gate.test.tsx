/**
 * Веб: без аккаунта дальше не пускаем.
 *
 * ── Почему так решено ───────────────────────────────────────────────────────
 *
 * Заказчик: «вход должен быть с авторизацией в web, так как, если человек
 * заходит, например, с iOS, а потом с windows, у него будут разные заметки,
 * так как устройства разные. но в случае с приложениями это понятно, то в
 * случае с web — нет. человек будет считать, что данные потерялись».
 *
 * То есть ворота — не про сбор адресов, а про доверие: в браузере заметки
 * живут в этом браузере, и без аккаунта второй заход с другого устройства
 * неотличим от пропажи данных.
 *
 * ── Что здесь проверяется ───────────────────────────────────────────────────
 *
 * Три вещи, каждая из которых легко ломается порознь: ворота стоят именно в
 * вебе, они пропускают вошедшего, и в оболочках их нет — там папка на
 * устройстве видна, и объяснять нечего.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../src/App.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

function mount(kind: 'web' | 'windows' | 'android', prefs: Record<string, unknown> = {}) {
  const host = createTestHost({ files: {}, prefs: { onboarded: true, ...prefs } });
  /* Оболочка отличается ровно одним полем — тем самым, по которому и
     принимается решение. */
  (host.platform as { kind: string }).kind = kind;
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <App host={host} locale="ru" />
      </ToastProvider>
    </ThemeProvider>,
  );
  return host;
}

/** Сессия в настройках — то, что остаётся после успешного входа. */
const SIGNED_IN = {
  'auth.session': {
    accessToken: 'token',
    refreshToken: 'refresh',
    deviceId: 'device-0001',
    email: 'marina@ya.ru',
    expiresAt: Date.now() + 3_600_000,
  },
};

describe('ворота веба', () => {
  it('без аккаунта веб показывает вход, а не заметки', async () => {
    mount('web');
    await waitFor(() => expect(screen.getByText(ru.signIn.gateTitle)).toBeTruthy());
    /* И объясняет причину: вход без причины читается как сбор адресов. */
    expect(screen.getByText(ru.signIn.gateReason)).toBeTruthy();
  });

  it('на воротах нет кнопки «назад» — возвращаться некуда', async () => {
    mount('web');
    await waitFor(() => expect(screen.getByText(ru.signIn.gateTitle)).toBeTruthy());
    expect(screen.queryByRole('button', { name: ru.app.back })).toBeNull();
  });

  it('вошедшего ворота пропускают', async () => {
    mount('web', SIGNED_IN);
    await waitFor(() => expect(screen.queryByText(ru.signIn.gateReason)).toBeNull());
  });

  for (const kind of ['windows', 'android'] as const) {
    it(`в оболочке ${kind} ворот нет: папка на устройстве видна и понятна`, async () => {
      mount(kind);
      /* Ждём, пока загрузка кончится: до этого ворот нет ни у кого, и
         проверка прошла бы, ничего не проверив. */
      await waitFor(() => expect(document.querySelector('.za-app')).toBeTruthy());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByText(ru.signIn.gateReason)).toBeNull();
    });
  }
});
