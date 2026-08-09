/**
 * Экраны, у которых поведение задано запретами: paywall, вход, отладочное
 * меню. Проверяется то, чего быть НЕ должно, — именно это ломается тихо.
 */
import { render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@zapiski/ui';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { AppProvider } from '../src/state/context.js';
import { AppController, MATRIX, type MatrixScreen } from '../src/state/store.js';
import { PaywallScreen } from '../src/screens/PaywallScreen.js';
import { SignInScreen } from '../src/screens/SignInScreen.js';
import { DebugMenu } from '../src/screens/DebugMenu.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

function mount(node: ReactNode, controller?: AppController): void {
  const host = createTestHost({ prefs: { onboarded: true } });
  const app = controller ?? new AppController(host);
  render(
    <ToastProvider>
      <AppProvider host={host} controller={app}>
        {node}
      </AppProvider>
    </ToastProvider>,
  );
}

const ru = strings('ru');

describe('paywall — SCREENS §9, список запретов', () => {
  it('кнопка закрытия видима', () => {
    mount(<PaywallScreen />);
    expect(screen.getByRole('button', { name: ru.app.close })).toBeTruthy();
  });

  it('годовой тариф не предвыбран, а его выгода помечена явно', () => {
    mount(<PaywallScreen />);
    const monthly = screen.getByRole('button', { name: new RegExp(ru.paywall.monthly) });
    const yearly = screen.getByRole('button', { name: new RegExp(ru.paywall.yearly) });
    expect(monthly.getAttribute('aria-pressed')).toBe('true');
    expect(yearly.getAttribute('aria-pressed')).toBe('false');
    expect(within(yearly).getByText(ru.paywall.yearlyNote)).toBeTruthy();
  });

  it('на экране нет ни одного таймера обратного отсчёта', () => {
    mount(<PaywallScreen />);
    const text = document.body.textContent ?? '';
    /* Честное обещание вместо давления — оно само упоминает «скидки только
       сегодня», поэтому из текста для проверки его вычитаем. */
    expect(text).toContain(ru.paywall.honest);
    const withoutPromise = text.replace(ru.paywall.honest, '');
    expect(withoutPromise).not.toMatch(/\d+\s*:\s*\d{2}/);
    expect(withoutPromise).not.toMatch(/осталось|только сегодня|истека|таймер/i);
  });
});

describe('вход — только Яндекс ID и magic-link', () => {
  it('нет ни одного поля телефона и ни одного упоминания кода из СМС', () => {
    mount(<SignInScreen />);
    expect(screen.queryByRole('textbox', { name: /телефон/i })).toBeNull();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/код из|введите код|номер телефона/i);
    expect(screen.getByRole('button', { name: ru.signIn.yandex })).toBeTruthy();
    expect(screen.getByRole('button', { name: ru.signIn.sendLink })).toBeTruthy();
  });

  it('обещание «без паролей и СМС» на месте дословно', () => {
    mount(<SignInScreen />);
    expect(screen.getByText(ru.signIn.promise)).toBeTruthy();
  });
});

describe('отладочное меню — приёмочный критерий №10', () => {
  it('на каждую заполненную ячейку §12 есть работающая кнопка, на прочерк — нет', () => {
    const host = createTestHost({ prefs: { onboarded: true } });
    const app = new AppController(host);
    app.toggleDebug(true);
    mount(<DebugMenu />, app);

    for (const screenKey of Object.keys(MATRIX) as MatrixScreen[]) {
      for (const [state, supported] of Object.entries(MATRIX[screenKey])) {
        const label = `${ru.debug.screens[screenKey]} · ${
          ru.debug.states[state as keyof typeof ru.debug.states]
        }`;
        const button = screen.getByRole('button', { name: label }) as HTMLButtonElement;
        expect(button, `нет ячейки ${label}`).toBeTruthy();
        /* Прочерк в ТЗ = ячейка выключена и подписана, почему её нет. */
        expect(button.disabled, `${label}: доступность не совпала с §12`).toBe(!supported);
        if (!supported) expect(button.title).toBe(ru.debug.notApplicable);
      }
    }
  });
});
