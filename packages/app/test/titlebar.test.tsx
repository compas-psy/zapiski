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

function fakeControls(maximized = false): WindowControls & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
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
  it('decorations выключены в конфиге Tauri', async () => {
    /* Без этого своя полоса стала бы второй: системная осталась бы сверху. */
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const config = JSON.parse(
      readFileSync(resolve(__dirname, '../../../apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    ) as { app: { windows: Array<{ decorations?: boolean }> } };
    expect(config.app.windows[0]?.decorations).toBe(false);
  });
});
