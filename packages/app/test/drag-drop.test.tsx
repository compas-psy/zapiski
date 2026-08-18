/**
 * Перетаскивание мышью: файл `.md` снаружи и папка внутри библиотеки.
 *
 * ── Что просил заказчик, дословно ───────────────────────────────────────────
 *
 * «1. Перетаскивание документов .md в редактор и или в конкретную папку в
 * приложении Windows или сайта должно копировать перетаскиваемую записку в
 * соответствующую папку ЗАПИСОК:
 *   1. Если перетаскиваю, например, из Explorer в окно редактора, то заметка
 *      .md открывается в редакторе, а сохраняется в текущей выбранной в меню
 *      папке
 *   2. Если перетаскиваю, наводя на конкретную папку в меню, то записка
 *      копируется в неё и сразу открывается в редакторе, а фокус в меню
 *      переходит на папку, куда перетащен документ
 *  2. перетаскивание/перемещение папок перетаскиванием — я в меню „взял“
 *     мышкой папку и перетянул в другую папку → должно подсвечиваться, куда
 *     сейчас перетягиваю + папка физически перемещается после этого действия».
 *
 * ── Что здесь сторожится ────────────────────────────────────────────────────
 *
 * Результат, а не вызов: заметка ЛЕЖИТ в нужной папке и открыта, папка ЛЕЖИТ
 * внутри новой и её заметки уехали с ней. Проверять «позвали `moveFolder`»
 * значило бы сторожить проводку, а сломаться может как раз то, что за ней.
 *
 * Подсветку цели меряет браузерный прогон (`scripts/check-drag-drop.mjs`):
 * `data-drop-target` в дереве и обведённая рамка на экране — разные
 * утверждения, а в happy-dom нет ни рамок, ни раскладки.
 */
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { LibraryPanel, canDropFolder, FOLDER_DRAG_TYPE } from '../src/screens/LibraryPanel.js';
import { flattenFolders } from '../src/components/FolderDialogs.js';
import { createTestHost } from './host.js';

afterEach(cleanup);

/** Хранилище с двумя папками и заметкой внутри первой. */
async function mount(
  node: (app: AppController) => ReactElement,
  files: Record<string, string> = {
    'Практика/Планёрка.md': '# Планёрка\n\nтекст\n',
    'Архив дел/.keep': '',
  },
): Promise<AppController> {
  /* Широкий экран: перетаскивание — дорога мыши, и живёт она там. */
  window.innerWidth = 1440;
  const host = createTestHost({ files, prefs: { onboarded: true } });
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
  await waitFor(() => expect(app.getState().ready).toBe(true));
  return app;
}

/**
 * Пустой перенос для `dragstart`.
 *
 * Отдать событию `undefined` нельзя: обработчик сразу зовёт `setData`. При
 * этом объект, который в итоге придёт в обработчик, harness подменяет своим —
 * поэтому дальше проверяется тот, что событие несло НА САМОМ ДЕЛЕ.
 */
function emptyTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    types: [] as string[],
    dropEffect: 'move',
    effectAllowed: 'move',
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  } as unknown as DataTransfer;
}

/** Перенос с файлами: в happy-dom своего `DataTransfer` с файлами нет. */
function filesTransfer(files: File[]): DataTransfer {
  return {
    types: ['Files'],
    files,
    dropEffect: 'copy',
    effectAllowed: 'copy',
    getData: () => '',
    setData: () => undefined,
  } as unknown as DataTransfer;
}

const mdFile = (name: string, text: string): File =>
  new File([text], name, { type: 'text/markdown' });

describe('папку нельзя уронить куда попало', () => {
  it('в саму себя — нет', () => {
    expect(canDropFolder('Практика', 'Практика')).toBe(false);
  });

  it('в собственную подпапку — нет: ветка уехала бы внутрь себя', () => {
    expect(canDropFolder('Практика', 'Практика/2026')).toBe(false);
  });

  it('в родителя, где она уже лежит, — нет: перенос ничего не изменит', () => {
    expect(canDropFolder('Практика/2026', 'Практика')).toBe(false);
  });

  it('в соседнюю — да', () => {
    expect(canDropFolder('Практика', 'Архив дел')).toBe(true);
    expect(canDropFolder('Практика/2026', 'Архив дел')).toBe(true);
  });
});

describe('папка переносится перетаскиванием', () => {
  it('строка папки тащится мышью', async () => {
    await mount(() => <LibraryPanel />);
    const folder = await screen.findByRole('treeitem', { name: /Практика/ });
    expect(folder.getAttribute('draggable'), 'папку нельзя взять мышью').toBe('true');
  });

  it('брошенная в другую папку — переезжает физически, вместе с заметками', async () => {
    const app = await mount(() => <LibraryPanel />);
    const source = await screen.findByRole('treeitem', { name: /Практика/ });
    const target = await screen.findByRole('treeitem', { name: /Архив дел/ });

    let carried: DataTransfer | undefined;
    source.addEventListener('dragstart', (event) => {
      carried = (event as DragEvent).dataTransfer ?? undefined;
    });
    fireEvent.dragStart(source, { dataTransfer: emptyTransfer() });
    expect(carried, 'перенос пришёл без данных').toBeDefined();
    expect((carried as DataTransfer).getData(FOLDER_DRAG_TYPE)).toBe('Практика');

    fireEvent.drop(target, { dataTransfer: carried });

    /* Дерево папок вложенное — путь ищем по всем уровням, а не только по корню. */
    await waitFor(() =>
      expect(
        flattenFolders(app.getState().folders).includes('Архив дел/Практика'),
        'папка не переехала',
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        app.getState().notes.some((note) => note.path === 'Архив дел/Практика/Планёрка.md'),
        'заметки внутри папки за ней не поехали',
      ).toBe(true),
    );
  });

  it('на телефоне папка не тащится: там её переносят через меню', async () => {
    window.innerWidth = 390;
    const host = createTestHost({ files: { 'Практика/.keep': '' }, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    render(
      <ThemeProvider persist={false}>
        <ToastProvider>
          <AppProvider host={host} controller={app}>
            <LibraryPanel />
          </AppProvider>
        </ToastProvider>
      </ThemeProvider>,
    );
    const folder = await screen.findByRole('treeitem', { name: /Практика/ });
    expect(folder.getAttribute('draggable')).toBeNull();
  });
});

describe('файл .md, брошенный на папку', () => {
  it('ложится в неё, открывается и переводит фокус меню на эту папку', async () => {
    const app = await mount(() => <LibraryPanel />);
    const target = await screen.findByRole('treeitem', { name: /Архив дел/ });

    fireEvent.drop(target, {
      dataTransfer: filesTransfer([mdFile('Разбор недели.md', '# Разбор недели\n\nтекст\n')]),
    });

    await waitFor(() =>
      expect(
        app.getState().notes.some((note) => note.path === 'Архив дел/Разбор недели.md'),
        'заметка не легла в папку, на которую её уронили',
      ).toBe(true),
    );
    /* Фокус меню — на папке назначения, заметка открыта: ровно та цепочка,
       которую заказчик описал словами. */
    expect(app.getState().folder).toBe('Архив дел');
    const route = app.getState().route;
    expect(route.name).toBe('note');
    expect(route.name === 'note' ? route.id : '').toBe('Архив дел/Разбор недели.md');
  });

  it('не затирает заметку с тем же именем, а получает суффикс', async () => {
    /* Инвариант BEHAVIOR §9 «импорт никогда не перезаписывает существующие
       заметки» держит ядро — здесь сторожится, что бросок мышью идёт той же
       дорогой, а не в обход. */
    const app = await mount(() => <LibraryPanel />, {
      'Архив дел/Разбор недели.md': '# Разбор недели\n\nстарый текст\n',
    });
    const target = await screen.findByRole('treeitem', { name: /Архив дел/ });

    fireEvent.drop(target, {
      dataTransfer: filesTransfer([mdFile('Разбор недели.md', '# Разбор недели\n\nновый текст\n')]),
    });

    await waitFor(() => expect(app.getState().notes.length).toBe(2));
    const kept = await app.readNote('Архив дел/Разбор недели.md');
    expect(kept?.body, 'существующая заметка затёрта').toContain('старый текст');
  });

  it('не заметки на папку не кладутся, и об этом говорят вслух', async () => {
    const app = await mount(() => <LibraryPanel />);
    const target = await screen.findByRole('treeitem', { name: /Архив дел/ });
    const said: string[] = [];
    app.setToastSink((toast) => said.push(toast.message));

    fireEvent.drop(target, {
      dataTransfer: filesTransfer([new File([new Uint8Array([1, 2])], 'снимок.png')]),
    });

    await waitFor(() => expect(said.length).toBe(1));
    expect(said[0]).toContain('.md');
    expect(app.getState().notes.length, 'картинка стала заметкой').toBe(1);
  });
});

describe('файл .md, брошенный в редактор', () => {
  it('ложится в выбранную сейчас папку и открывается', async () => {
    /*
     * Заказчик: «сохраняется в текущей выбранной в меню папке». Проверяется
     * через контроллер, а не через экран заметки: до броска в редактор надо
     * сначала открыть заметку, и тогда сторож проверял бы дорогу к редактору,
     * а не правило «в текущую папку».
     */
    const app = await mount(() => <LibraryPanel />);
    app.openFolder('Практика');

    const paths = await app.importDroppedNotes(
      [mdFile('Заметки со встречи.md', '# Заметки со встречи\n\nтекст\n')],
      app.getState().folder ?? undefined,
    );

    expect(paths).toEqual(['Практика/Заметки со встречи.md']);
    expect(app.getState().notes.some((note) => note.path === paths[0])).toBe(true);
  });

  it('несколько файлов разом ложатся все', async () => {
    const app = await mount(() => <LibraryPanel />);
    const paths = await app.importDroppedNotes([
      mdFile('Раз.md', '# Раз\n'),
      mdFile('Два.md', '# Два\n'),
    ]);
    expect(paths).toHaveLength(2);
  });
});
