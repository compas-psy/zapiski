/**
 * Библиотека: создать, найти, перенести (SCREENS §3, §5).
 *
 * Три жалобы заказчика одним куском, потому что это одна история — «до
 * заметки и папки нельзя дотянуться руками»:
 *
 *   · «нет + ков для добавления папок или заметок»;
 *   · «я не могу перетягивать записки в папки»;
 *   · «нет поиска по заметкам, хотя в дизайне есть».
 *
 * Последняя — второй заход на ту же ошибку: поле поиска чинили в прошлый раз,
 * но оно рисовалось только когда список занимает весь экран. В трёхпанельной
 * раскладке — той, что человек видит на Windows в развёрнутом окне, — список
 * «встроенный», и поля не было.
 */
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { NoteListScreen } from '../src/screens/NoteListScreen.js';
import { LibraryPanel, NOTE_DRAG_TYPE } from '../src/screens/LibraryPanel.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

/* Без этого деревья предыдущих проверок остаются в документе, и
   `querySelector` находит строку от УЖЕ размонтированного экрана: обработчики
   у неё отвязаны, и событие уходит в пустоту. */
afterEach(cleanup);

/** Хранилище с одной заметкой в корне и одной папкой. */
async function mount(node: (app: AppController) => ReactElement): Promise<AppController> {
  /* Широкий экран: именно на нём заказчик и не нашёл ни «+», ни поиска. */
  window.innerWidth = 1440;
  const host = createTestHost({
    files: { 'Планёрка.md': '# Планёрка\n\nтекст\n', 'Практика/.keep': '' },
    prefs: { onboarded: true },
  });
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
  /*
   * Ждём конца загрузки, а не только `boot()`.
   *
   * Открытие хранилища заканчивается патчем `route: list` — и если начать
   * нажимать раньше, этот патч прилетит поверх и отменит переход, который
   * человек уже сделал. В приложении такого не бывает: до готовности экран
   * показывает скелетон и нажимать не на что.
   */
  await waitFor(() => expect(app.getState().ready).toBe(true));
  return app;
}

describe('до заметки и папки можно дотянуться руками', () => {
  it('в шапке колонки списка есть «+»', async () => {
    const app = await mount(() => <NoteListScreen embedded />);
    const created = vi.spyOn(app, 'createNote');
    const plus = await screen.findByRole('button', { name: ru.list.newNote });
    fireEvent.click(plus);
    expect(created).toHaveBeenCalled();
  });

  it('поле поиска есть и во встроенной колонке', async () => {
    await mount(() => <NoteListScreen embedded />);
    expect(document.querySelector('.za-listsearch'), 'поля поиска нет').not.toBeNull();
  });

  it('набранное в поле сразу уходит в поиск', async () => {
    const app = await mount(() => <NoteListScreen embedded />);
    const field = document.querySelector('.za-listsearch__input') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'план' } });
    await waitFor(() => expect(app.getState().query).toBe('план'));
    await waitFor(() => expect(app.getState().route.name).toBe('search'));
  });
});

describe('заметка переносится перетаскиванием', () => {
  /** Заготовка `DataTransfer`: в jsdom его нет вовсе. */
  function transfer(): DataTransfer {
    const data = new Map<string, string>();
    return {
      types: [] as string[],
      dropEffect: 'move',
      effectAllowed: 'move',
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
    } as unknown as DataTransfer;
  }

  it('папка принимает заметку и зовёт перенос', async () => {
    const app = await mount(() => (
      <>
        <LibraryPanel />
        <NoteListScreen embedded />
      </>
    ));
    const moved = vi.spyOn(app, 'move').mockResolvedValue(undefined);

    const row = await waitFor(() => {
      const found = document.querySelector('.za-row');
      expect(found, 'строки заметки нет').not.toBeNull();
      return found as HTMLElement;
    });
    const folder = await screen.findByRole('treeitem', { name: /Практика/ });

    expect(row.getAttribute('draggable'), 'строка не тащится').toBe('true');

    /*
     * Свой `DataTransfer` до обработчика не доходит: harness подменяет его
     * своим (проверено — объект в событии не тот, что передан). Поэтому
     * перехватываем тот, который событие несёт на самом деле, и его же
     * передаём в `drop`. В браузере это один и тот же объект, так что путь
     * проверяется настоящий.
     */
    let carried: DataTransfer | undefined;
    row.addEventListener('dragstart', (event) => {
      carried = (event as DragEvent).dataTransfer ?? undefined;
    });
    fireEvent.dragStart(row, { dataTransfer: transfer() });
    /* Именно свой тип: чужие обработчики не должны принимать строку за файл. */
    expect(carried, 'событие пришло без данных').toBeDefined();
    expect((carried as DataTransfer).getData(NOTE_DRAG_TYPE)).toBe('Планёрка.md');

    fireEvent.drop(folder, { dataTransfer: carried });
    expect(moved).toHaveBeenCalledWith('Планёрка.md', 'Практика');
  });

  it('на телефоне строка не тащится: там переносят через меню', async () => {
    window.innerWidth = 390;
    const host = createTestHost({
      files: { 'Планёрка.md': '# Планёрка\n' },
      prefs: { onboarded: true },
    });
    const app = new AppController(host);
    await app.boot();
    render(
      <ThemeProvider persist={false}>
        <ToastProvider>
          <AppProvider host={host} controller={app}>
            <NoteListScreen />
          </AppProvider>
        </ToastProvider>
      </ThemeProvider>,
    );
    const row = await waitFor(() => {
      const found = document.querySelector('.za-row');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(row.getAttribute('draggable')).toBeNull();
  });
});
