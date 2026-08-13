/**
 * Переключатель режимов на заметке (замечание 3).
 *
 * Заказчик просил его «сверху справа на каждой заметке», понятными символами:
 * простой режим — как Telegram, разметки не видно вовсе; профессиональный —
 * разметка проявляется в блоке под курсором, и внутри него свой переключатель
 * «вся разметка / просмотр».
 *
 * Поля состояния для этого в редакторе были с самого начала (`simple`/`pro` и
 * raw), а дороги к ним с экрана заметки не было: режим можно было сменить
 * только в Настройках, а показ разметки — сочетанием клавиш, которого на
 * телефоне нет. Здесь сторожится именно дорога.
 */
import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { describe, expect, it } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { ModeSwitch } from '../src/components/ModeSwitch.js';
import { createTestHost } from './host.js';

function mount(): AppController {
  const host = createTestHost({ prefs: { onboarded: true } });
  const app = new AppController(host);
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <ModeSwitch />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  return app;
}

describe('переключатель режимов', () => {
  it('в простом режиме показа разметки не предлагает', () => {
    /* «Показать разметку» в простом режиме было бы дверью в то, чего человек
       не выбирал: там разметки нет ни в одном состоянии. */
    mount();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('нажатие переключает режим, и появляется вторая кнопка', () => {
    mount();
    fireEvent.click(screen.getByRole('button'));

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    /* Первая кнопка теперь «нажата» — режим профессиональный. */
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('вторая кнопка включает показ всей разметки', () => {
    const app = mount();
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getAllByRole('button')[1] as HTMLElement);

    expect(app.getState().rawMode).toBe(true);
  });

  it('возврат в простой режим гасит показ разметки', () => {
    /* Иначе настройка осталась бы включённой невидимо и «выстрелила» при
       следующем возврате в профессиональный режим. */
    const app = mount();
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getAllByRole('button')[1] as HTMLElement);
    expect(app.getState().rawMode).toBe(true);

    fireEvent.click(screen.getAllByRole('button')[0] as HTMLElement);
    expect(app.getState().rawMode).toBe(false);
  });

  it('у каждой кнопки есть слова, а не только символ', () => {
    /* Символы — для глаза, слова — для скринридера и подсказки. */
    mount();
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-label')).toBeTruthy();
    expect(button.getAttribute('title')).toBeTruthy();
  });
});
