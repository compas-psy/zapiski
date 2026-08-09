/**
 * Витрина — артефакт приёмки: если она не собирается, приёмка невозможна.
 * Тест держит её живой и заодно проверяет, что вся библиотека композируется.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Gallery } from '../src/gallery/Gallery';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(cleanup);

describe('Витрина', () => {
  it('рендерится целиком и поднимает свою тему', () => {
    render(<Gallery />);

    for (const title of [
      '1 · Кнопки',
      '2 · Поля ввода',
      '3 · Чипы, теги, бейджи',
      '4 · Переключатели',
      '5 · Строки списка',
      '6 · Оверлеи',
      '7 · Обратная связь',
      '8 · Специальные компоненты',
      '9 · Типографика и подсветка кода',
    ]) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }

    /* Переключатели тем и всех шести акцентов на месте (DS-ALIGNMENT §3). */
    expect(screen.getByRole('radiogroup', { name: 'Тема' })).toBeInTheDocument();
    for (const accent of ['Хвоя', 'Лес', 'Золото', 'Сумерки', 'Гранит', 'Глина']) {
      expect(screen.getByRole('button', { name: accent })).toBeInTheDocument();
    }
    /* Терракота из набора исключена: это цвет идентичности, не интерфейса. */
    expect(screen.queryByRole('button', { name: 'Гранат' })).toBeNull();

    expect(document.documentElement.getAttribute('data-theme')).toBe('simpas');
    expect(document.documentElement.getAttribute('data-accent')).toBe('pine');
  });
});
