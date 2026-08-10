/**
 * Правила REBUILD.md — те из них, что проверяются кодом, а не глазами.
 *
 * Документ разбирает скриншоты сборки и по каждому дефекту даёт правило.
 * Здесь закреплены правила, у которых есть однозначный признак в разметке:
 * счётчики «0», пустое состояние внутри навигации, диалог с четырьмя
 * одинаковыми словами. Остальное (ступень между фоном и поверхностью, один
 * зелёный на экран) проверяется сравнением токенов с эталоном — это делает
 * `scripts/check-design-tokens.mjs`.
 */
import { render, screen } from '@testing-library/react';
import { ToastProvider } from '@zapiski/ui';
import { describe, expect, it } from 'vitest';
import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { LibraryPanel } from '../src/screens/LibraryPanel.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

async function mount(files: Record<string, string> = {}): Promise<void> {
  const host = createTestHost({ files, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  render(
    <ToastProvider>
      <AppProvider host={host} controller={app}>
        <LibraryPanel />
      </AppProvider>
    </ToastProvider>,
  );
}

describe('§1.12 — счётчика «0» нет нигде', () => {
  it('на пустом хранилище ни один счётчик не напечатан', async () => {
    await mount();
    // «Все заметки 0» и «Закреплённые 0» притягивали внимание к пустоте.
    expect(document.querySelectorAll('.za-nav__count')).toHaveLength(0);
  });

  it('счётчик появляется, как только есть что считать', async () => {
    await mount({ 'Заметка.md': '# Заметка\n' });
    const counts = [...document.querySelectorAll('.za-nav__count')].map((n) => n.textContent);
    expect(counts).toContain('1');
    // Закреплённых по-прежнему нет — и нуля тоже нет.
    expect(counts).not.toContain('0');
  });
});

describe('§1.3 — навигация не показывает иллюстрацию и призыв к действию', () => {
  it('пустая библиотека — одна строка, а не пустое состояние с кругом', async () => {
    await mount();
    expect(screen.getByText(ru.library.emptyFolders)).toBeTruthy();
    // Круг пустого состояния живёт только в контентной области.
    expect(document.querySelectorAll('.z-empty')).toHaveLength(0);
  });

  it('«Новая папка» осталась достижимой — обычным пунктом списка', async () => {
    await mount();
    const button = screen.getByRole('button', { name: new RegExp(ru.library.newFolder) });
    // В общем ритме навигации, а не отдельной кнопкой поверх пустого состояния.
    expect(button.className).toContain('za-nav__item');
  });
});

describe('§1.4 — диалог не повторяет одно слово четыре раза', () => {
  it('поле пустое, с подсказкой, а кнопка — глагол', async () => {
    await mount();
    screen.getByRole('button', { name: new RegExp(ru.library.newFolder) }).click();

    const field = await screen.findByLabelText<HTMLInputElement>(ru.library.folderNamePrompt);
    expect(field.value).toBe('');
    expect(field.placeholder).toBe(ru.library.folderNameHint);

    // Кнопка подтверждения — «Создать», а не третий повтор заголовка.
    expect(screen.getByRole('button', { name: ru.library.create })).toBeTruthy();
  });

  it('подпись над полем не видна — она только для скринридера', async () => {
    await mount();
    screen.getByRole('button', { name: new RegExp(ru.library.newFolder) }).click();
    await screen.findByLabelText(ru.library.folderNamePrompt);

    // Текста «Название папки» на экране нет: при одном поле он лишний.
    expect(screen.queryByText(ru.library.folderNamePrompt)).toBeNull();
  });
});
