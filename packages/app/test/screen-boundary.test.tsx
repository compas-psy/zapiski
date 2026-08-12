/**
 * Упавший экран не уносит с собой приложение.
 *
 * До этой границы во всём коде не было ни одного `componentDidCatch`: любая
 * ошибка внутри любого экрана гасила окно целиком и оставляла белый
 * прямоугольник. На десктопе это хотя бы видно в консоли; на телефоне консоли
 * нет, и отказ неотличим от «кнопка не работает» — часть отзыва заказчика
 * выглядела именно так.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { ScreenBoundary } from '../src/components/ScreenBoundary.js';
import { strings } from '../src/i18n/index.js';

const ru = strings('ru');

/** Компонент, который падает на рендере. */
function Broken(): never {
  throw new Error('нарочно');
}

beforeEach(() => {
  /* React печатает пойманную ошибку сам — в выводе теста это шум. */
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('граница ошибки', () => {
  it('показывает плашку вместо пустоты', () => {
    render(
      <ScreenBoundary strings={ru} resetKey="a">
        <Broken />
      </ScreenBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(ru.app.crashed)).toBeTruthy();
  });

  it('исправный экран не трогает вовсе', () => {
    render(
      <ScreenBoundary strings={ru} resetKey="a">
        <p>заметка</p>
      </ScreenBoundary>,
    );
    expect(screen.getByText('заметка')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('уход на другой экран снимает плашку', () => {
    /* Без сброса человек возвращается к той же плашке даже там, где всё в
       порядке, — то есть один упавший экран запирал бы всю навигацию. */
    const { rerender } = render(
      <ScreenBoundary strings={ru} resetKey="note">
        <Broken />
      </ScreenBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    rerender(
      <ScreenBoundary strings={ru} resetKey="settings">
        <p>настройки</p>
      </ScreenBoundary>,
    );
    expect(screen.getByText('настройки')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('текст объясняет, что заметки целы', () => {
    /* Главный страх в этот момент — «я потерял записи». Отвечаем на него
       прямо, а не показываем стек, который человеку ничего не даёт. */
    render(
      <ScreenBoundary strings={ru} resetKey="a">
        <Broken />
      </ScreenBoundary>,
    );
    expect(screen.getByText(ru.app.crashedHint).textContent).toContain('файлах');
  });
});
