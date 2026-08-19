/**
 * Своя строка заголовка окна (ITERATION-1 §6).
 *
 * Дефект: иконка и название приложения показывались дважды — в системной
 * строке заголовка Windows и в сайдбаре. Референсы Todoist и Bear решают это
 * одинаково: системной строки нет вовсе, окно безрамочное, бренд живёт ровно
 * в одном месте.
 *
 * Главное, что проверяется здесь, — не внешний вид, а условие появления.
 * Полоса рисуется только там, где платформа отдала порт управления окном: у
 * веба окна нет, у Android строку ведёт система, и нарисованная поверх неё
 * своя полоса была бы второй подряд.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import type { WindowControls } from '@zapiski/core';
import { AppProvider } from '../src/state/context.js';
import { TitleBar } from '../src/components/TitleBar.js';
import { AppController } from '../src/state/store.js';
import { createTestHost } from './host.js';

function fakeControls(
  maximized = false,
  chrome: WindowControls['chrome'] = 'custom',
): WindowControls & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    chrome,
    inlineStartInset: chrome === 'native-overlay' ? 78 : 0,
    async minimize() {
      calls.push('minimize');
    },
    async toggleMaximize() {
      calls.push('toggleMaximize');
    },
    async close() {
      calls.push('close');
    },
    async isMaximized() {
      return maximized;
    },
    onMaximizeChange() {
      return () => {};
    },
  };
}

async function mount(window: WindowControls | null) {
  const host = createTestHost({ prefs: { onboarded: true } });
  const withWindow = { ...host, platform: { ...host.platform, window } };
  const app = new AppController(withWindow);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={withWindow} controller={app}>
          <TitleBar />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe('строка заголовка появляется только там, где есть окно', () => {
  it('без порта управления окном её нет вовсе', async () => {
    /* Веб и Android: скрытый элемент честнее выключенного (BEHAVIOR §5.1). */
    await mount(null);
    expect(document.querySelector('.za-titlebar')).toBeNull();
  });

  it('с портом — полоса и три кнопки', async () => {
    await mount(fakeControls());
    expect(document.querySelector('.za-titlebar')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Свернуть' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Развернуть' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Закрыть окно' })).toBeTruthy();
  });
});

describe('бренд не дублируется', () => {
  it('в строке заголовка нет ни знака, ни вордмарка', async () => {
    /* Ровно тот дефект, о котором писал пользователь: название приложения
       встречалось и в системном хэдере, и в левой колонке. */
    await mount(fakeControls());
    const bar = document.querySelector('.za-titlebar') as HTMLElement;
    expect(bar.textContent).toBe('');
    expect(bar.querySelector('.za-brand')).toBeNull();
    expect(bar.querySelector('.za-wordmark')).toBeNull();
  });
});

describe('кнопки делают то, что написано', () => {
  it('каждая зовёт свою команду окна', async () => {
    const controls = fakeControls();
    await mount(controls);

    screen.getByRole('button', { name: 'Свернуть' }).click();
    screen.getByRole('button', { name: 'Развернуть' }).click();
    screen.getByRole('button', { name: 'Закрыть окно' }).click();

    expect(controls.calls).toEqual(['minimize', 'toggleMaximize', 'close']);
  });

  it('у развёрнутого окна средняя кнопка называется иначе', async () => {
    await mount(fakeControls(true));
    /* Состояние окна спрашивается асинхронно — первый кадр рисуется до ответа. */
    expect(await screen.findByRole('button', { name: 'Вернуть прежний размер' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Развернуть' })).toBeNull();
  });

  it('двойной клик по полосе разворачивает окно', async () => {
    const controls = fakeControls();
    await mount(controls);
    const bar = document.querySelector('.za-titlebar') as HTMLElement;
    bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(controls.calls).toContain('toggleMaximize');
  });

  it('полоса объявлена зоной перетаскивания, а кнопки — нет', async () => {
    /* Иначе нажатие на «закрыть» начинало бы тащить окно. */
    await mount(fakeControls());
    const bar = document.querySelector('.za-titlebar') as HTMLElement;
    expect(bar.getAttribute('data-tauri-drag-region')).toBe('true');
    for (const button of Array.from(bar.querySelectorAll('button'))) {
      expect(button.hasAttribute('data-tauri-drag-region')).toBe(false);
    }
  });
});

describe('окно оболочки Windows безрамочное', () => {
  /**
   * Рамки окна: один конфиг, две системы.
   *
   * В конфиге стоит macOS-случай — `decorations: true` плюс `Overlay`: там
   * `false` унесло бы вместе с полосой и три системные кнопки, и окно нельзя
   * было бы закрыть мышью. Windows свою полосу рисует сам, поэтому рамки с
   * него снимаются в коде, при старте.
   *
   * Проверяется ОБА конца связки. Пропадёт первый — на macOS исчезнет
   * «светофор»; пропадёт второй — на Windows появится вторая полоса
   * заголовка. Ни то, ни другое не ловится сборкой.
   */
  it('окно macOS сохраняет системные кнопки, Windows снимает рамки в коде', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const root = resolve(__dirname, '../../..');

    const config = JSON.parse(
      readFileSync(resolve(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    ) as {
      app: {
        windows: Array<{ decorations?: boolean; titleBarStyle?: string; hiddenTitle?: boolean }>;
      };
    };
    const window = config.app.windows[0];
    expect(window?.decorations, 'без рамок на macOS нет и кнопок окна').toBe(true);
    expect(window?.titleBarStyle, 'без Overlay полоса заголовка останется видимой').toBe('Overlay');
    expect(window?.hiddenTitle).toBe(true);

    const shell = readFileSync(resolve(root, 'apps/desktop/src-tauri/src/lib.rs'), 'utf8');
    expect(shell, 'рамки не снимаются — на Windows будет вторая полоса').toContain(
      'set_decorations(false)',
    );
    expect(shell, 'рамки снимаются везде — на macOS пропадут кнопки окна').toContain(
      '#[cfg(not(target_os = "macos"))]',
    );
  });

  it('на macOS своих кнопок окна нет — их рисует система', async () => {
    /* Два комплекта кнопок в одной полосе — это не «на всякий случай», а
       интерфейс, в котором человек нажимает не ту. */
    await mount(fakeControls(false, 'native-overlay'));
    expect(document.querySelector('.za-titlebar')).not.toBeNull();
    expect(
      document.querySelector('.za-titlebar__controls'),
      'на macOS кнопки окна рисует система — свои были бы вторыми',
    ).toBeNull();
  });

  it('под «светофор» macOS оставлено поле', async () => {
    /* Без отступа содержимое полосы уезжает под три системные кнопки. */
    await mount(fakeControls(false, 'native-overlay'));
    const bar = document.querySelector('.za-titlebar') as HTMLElement | null;
    expect(bar?.style.paddingInlineStart).toBe('78px');
  });
});
