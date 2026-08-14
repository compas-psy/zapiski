/**
 * Что показывает открытая папка.
 *
 * ── Что прислал заказчик ────────────────────────────────────────────────────
 *
 * «Непонятное отображение записок из подпапок. Заметки были перемещены из папки
 * ЗАПИСКИ в её подпапку ДОРАБОТКИ. Когда отображается так, то не понятно,
 * находятся ли заметки в корневой папке, которая открыта, или в подпапке».
 *
 * И отдельным пунктом, но про то же самое: «есть ощущение, что после
 * перетаскивания записки из одной папки в другую её копия остаётся в старой
 * папке». Копии нет — заметка одна, и это проверяется здесь же: родитель
 * продолжал показывать её как свою, и выглядело это как двойник.
 *
 * Решение: открытая папка показывает СВОЁ содержимое (так ведут себя проводник
 * и Finder), а прежний порядок остаётся выбором — и тогда у каждой заметки из
 * подпапки подписано, откуда она.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { NoteListScreen } from '../src/screens/NoteListScreen.js';
import { createTestHost } from './host.js';

afterEach(cleanup);

const FILES = {
  'Записки/Внутри папки.md': '# Внутри папки\n\nсвоё\n',
  'Записки/Доработки/Из подпапки.md': '# Из подпапки\n\nвложенное\n',
};

async function boot(): Promise<AppController> {
  const host = createTestHost({ files: FILES, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  return app;
}

function mount(app: AppController): void {
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={app.host} controller={app}>
          <NoteListScreen />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe('по умолчанию папка показывает своё', () => {
  it('заметка из подпапки в родительской не показывается', async () => {
    const app = await boot();
    app.openFolder('Записки');
    mount(app);

    await waitFor(() => expect(screen.getByText('Внутри папки')).toBeTruthy());
    expect(
      screen.queryByText('Из подпапки'),
      'заметка из подпапки снова показана как своя — из-за этого перенос выглядит как копия',
    ).toBeNull();
    app.dispose();
  });

  it('в самой подпапке она есть — заметка не потерялась', async () => {
    const app = await boot();
    app.openFolder('Записки/Доработки');
    mount(app);

    await waitFor(() => expect(screen.getByText('Из подпапки')).toBeTruthy());
    app.dispose();
  });

  it('«Все заметки» показывают всё — там папок нет вовсе', async () => {
    const app = await boot();
    app.openFolder(null);
    mount(app);

    await waitFor(() => expect(screen.getByText('Внутри папки')).toBeTruthy());
    expect(screen.getByText('Из подпапки')).toBeTruthy();
    app.dispose();
  });
});

describe('прежний порядок остаётся выбором', () => {
  it('при «и из вложенных» заметка видна и подписана своей папкой', async () => {
    const app = await boot();
    await app.setSubfolderNotes(true);
    app.openFolder('Записки');
    mount(app);

    await waitFor(() => expect(screen.getByText('Из подпапки')).toBeTruthy());
    /* Подпись отвечает ровно на заданный вопрос: где эта заметка лежит. */
    expect(
      screen.getByText('Доработки'),
      'заметка из подпапки показана без единого признака, откуда она',
    ).toBeTruthy();
    /* Своя заметка подписи не получает: она и так в открытой папке. */
    const own = screen.getByText('Внутри папки').closest('.za-row');
    expect(own?.textContent).not.toContain('Доработки');
    app.dispose();
  });

  it('выбор переживает перезапуск', async () => {
    const host = createTestHost({ files: FILES, prefs: { onboarded: true } });
    const first = new AppController(host);
    await first.boot();
    await first.setSubfolderNotes(true);
    first.dispose();

    const second = new AppController(host);
    await second.boot();
    expect(second.subfolderNotesValue()).toBe(true);
    second.dispose();
  });
});

describe('перенос не оставляет копий', () => {
  it('после переноса заметка есть ровно в одном месте', async () => {
    const app = await boot();
    await app.move('Записки/Внутри папки.md', 'Записки/Доработки');

    const paths = app.getState().notes.map((note) => note.path);
    expect(paths).toContain('Записки/Доработки/Внутри папки.md');
    expect(paths, 'в старой папке остался файл').not.toContain('Записки/Внутри папки.md');
    expect(paths.filter((path) => path.endsWith('Внутри папки.md'))).toHaveLength(1);
    app.dispose();
  });
});
