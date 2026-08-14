/**
 * Подпапка открывается на телефоне.
 *
 * ── Что сказал заказчик ─────────────────────────────────────────────────────
 *
 * «Подпапки не открываются по тапу (в ЗАПИСКИ есть подпапка ДОРАБОТКИ)».
 *
 * ── Почему это случалось ────────────────────────────────────────────────────
 *
 * Тап по папке делал два дела разом: раскрывал узел дерева и выбирал папку.
 * Выбор папки закрывает библиотеку — на телефоне она ящик, — а `Drawer` при
 * закрытии размонтируется вместе с деревом. Раскрытие жило во внутреннем
 * состоянии `Tree` и умирало там же. Открыв библиотеку заново, человек видел
 * снова свёрнутый корень: подпапка не появлялась НИКОГДА, сколько ни тапай.
 *
 * Проверок две, и они про разные половины починки: шеврон раскрывает, не
 * уводя из библиотеки, а раскрытие переживает её закрытие.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { LibraryPanel } from '../src/screens/LibraryPanel.js';
import { createTestHost } from './host.js';

afterEach(cleanup);

/** Хранилище заказчика: папка ЗАПИСКИ и подпапка ДОРАБОТКИ внутри. */
async function boot(): Promise<AppController> {
  const host = createTestHost({
    files: {
      'ЗАПИСКИ/Первая.md': '# Первая\n',
      'ЗАПИСКИ/ДОРАБОТКИ/Вторая.md': '# Вторая\n',
    },
    prefs: { onboarded: true },
  });
  const app = new AppController(host);
  await app.boot();
  await app.refresh();
  return app;
}

/**
 * Строка дерева по имени папки.
 *
 * Именно в дереве, а не где угодно на экране: имя «ЗАПИСКИ» носит ещё и
 * вордмарк в шапке библиотеки, и поиск по всему документу находил его первым —
 * тест ловил заголовок вместо папки.
 */
function folderRow(name: string): HTMLElement {
  const nodes = screen
    .getAllByText(name)
    .map((node) => node.closest('.z-tree__item'))
    .filter((node): node is HTMLElement => node !== null);
  const row = nodes[0];
  if (!row) throw new Error(`папки «${name}» нет в дереве`);
  return row;
}

function mount(app: AppController): void {
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={app.host} controller={app}>
          <LibraryPanel />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe('дорога к подпапке', () => {
  it('шеврон раскрывает папку и оставляет человека в библиотеке', async () => {
    const app = await boot();
    mount(app);

    await screen.findAllByText('ЗАПИСКИ');
    expect(screen.queryByText('ДОРАБОТКИ'), 'подпапка видна до раскрытия').toBeNull();

    const chevron = folderRow('ЗАПИСКИ').querySelector('.z-tree__chevron');
    expect(chevron, 'шеврона нет — раскрывать нечем').toBeTruthy();
    fireEvent.click(chevron as Element);

    await waitFor(() => expect(screen.getByText('ДОРАБОТКИ')).toBeTruthy());
    /* Ящик остался открытым, папка не выбрана: шеврон — про показать, а не
       про перейти. Иначе на телефоне раскрытие снова исчезало бы вместе с
       библиотекой. */
    expect(app.getState().libraryOpen).toBe(false);
    expect(app.getState().folder, 'шеврон увёл в список вместо раскрытия').toBeNull();

    fireEvent.click(chevron as Element);
    await waitFor(() => expect(screen.queryByText('ДОРАБОТКИ')).toBeNull());
    app.dispose();
  });

  it('раскрытие переживает закрытие библиотеки', async () => {
    const app = await boot();
    mount(app);

    /* Тап по строке — как на телефоне: библиотека закроется, покажется список
       заметок папки. */
    await screen.findAllByText('ЗАПИСКИ');
    fireEvent.click(folderRow('ЗАПИСКИ'));
    await waitFor(() => expect(app.getState().folder).toBe('ЗАПИСКИ'));
    expect(
      app.getState().expandedFolders,
      'раскрытие живёт в дереве и умрёт вместе с ящиком',
    ).toContain('ЗАПИСКИ');

    /* Библиотека открывается заново — узел обязан остаться раскрытым. */
    cleanup();
    mount(app);
    await waitFor(() => expect(screen.getByText('ДОРАБОТКИ')).toBeTruthy());

    fireEvent.click(screen.getByText('ДОРАБОТКИ'));
    await waitFor(() => expect(app.getState().folder).toBe('ЗАПИСКИ/ДОРАБОТКИ'));
    app.dispose();
  });

  it('открытая подпапка раскрывает всех предков — видно, где ты', async () => {
    const app = await boot();
    /* Дорога не через дерево: заметку открыли поиском, крошкой или ссылкой. */
    app.openFolder('ЗАПИСКИ/ДОРАБОТКИ');
    mount(app);

    await waitFor(() => expect(screen.getByText('ДОРАБОТКИ')).toBeTruthy());
    expect(app.getState().expandedFolders).toContain('ЗАПИСКИ');
    app.dispose();
  });
});
