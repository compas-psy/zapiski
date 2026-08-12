/**
 * Отмена удаления строки и столбца таблицы (ITERATION-1 §4).
 *
 * §4 называет удаление отменяемой операцией и требует тост «Строка удалена ·
 * Отменить». Тосты рисует приложение — в редакторе их нет и быть не должно, —
 * поэтому проверяется именно стык: панель объявляет отменяемое действие,
 * приложение поднимает тост, нажатие возвращает таблицу.
 *
 * Обещание отмены без работающей отмены хуже отсутствия обещания: человек
 * жмёт «Отменить» ровно один раз и делает вывод обо всём приложении.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { describe, expect, it } from 'vitest';

import { ru as editorRu } from '@zapiski/editor';
import { AppProvider } from '../src/state/context.js';
import { activeEditor } from '../src/state/active-editor.js';
import { AppController } from '../src/state/store.js';
import { NoteScreen } from '../src/screens/NoteScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');
const copy = editorRu.panel;

const TABLE = ['| Дело   | Срок |', '| ------ | ---- |', '| созвон | пн   |', '| отчёт  | ср   |'].join(
  '\n',
);

/** Нажатие кнопки панели: она слушает pointerdown, а не click. */
function press(element: Element): void {
  fireEvent.pointerDown(element);
  fireEvent.pointerUp(element);
}

/** Заметка с таблицей и курсором в строке «созвон». */
async function mountTable(): Promise<void> {
  window.innerWidth = 390;
  const host = createTestHost({
    files: { 'Заметка.md': `# Заметка\n\n${TABLE}\n` },
    prefs: { onboarded: true },
  });
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <NoteScreen path="Заметка.md" />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  await screen.findByRole('textbox', { name: 'Название заметки' });

  /* Курсор ставится в ячейку «созвон»: меню правки таблицы появляется только
     когда курсор внутри неё. Представление берётся из того же регистра, что и
     у палитры команд, — своего доступа к `EditorView` у экрана нет. */
  const view = await waitFor(() => {
    const found = activeEditor()?.view;
    expect(found, 'редактор не зарегистрирован').toBeTruthy();
    return found;
  });
  const at = view!.state.doc.toString().indexOf('созвон');
  expect(at, 'таблица не попала в текст').toBeGreaterThan(-1);
  await act(async () => {
    view!.dispatch({ selection: { anchor: at + 3 } });
  });
}

/**
 * Кнопка «Отменить» ИЗ ТОСТА.
 *
 * По имени её не отличить: в панели рядом стоит своя «Отменить» — обычная
 * отмена редактора. Ищем внутри тоста, иначе тест поймал бы не ту кнопку и
 * прошёл бы, ничего не проверив.
 */
async function undoInToast(): Promise<HTMLElement> {
  const toast = (await screen.findByRole('status')) as HTMLElement;
  return within(toast).getByRole('button', { name: ru.actions.undo });
}

/** Пункт меню панели по подписи. */
function menuItem(text: string): HTMLElement {
  const found = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent?.includes(text),
  );
  expect(found, `пункта «${text}» нет в меню`).toBeTruthy();
  return found as HTMLElement;
}

describe('панель видит живой редактор', () => {
  it('меню правки таблицы открывается сразу, без единого нажатия клавиши', async () => {
    /* Представление CodeMirror живёт не весь срок экрана: перезаход в
       хранилище поднимает флаг «загружаюсь», экран уходит в скелетон, и
       редактор пересоздаётся. Ссылка в ref об этом никому не сообщала —
       панель держала представление, которого уже нет, и меню правки таблицы
       не открывалось вовсе. Первое же нажатие клавиши всё чинило, поэтому
       дефект и выглядел мистикой. */
    await mountTable();
    press(screen.getByRole('button', { name: copy.table }));
    expect(menuItem(copy.tableMenu.removeRow)).toBeTruthy();
  });

  it('палитра команд получает тот же живой редактор', async () => {
    await mountTable();
    const view = activeEditor()?.view;
    expect(view, 'в регистре разрушенный редактор').toBeTruthy();
    expect(view?.dom.isConnected).toBe(true);
  });
});

describe('удаление строки таблицы отменяется', () => {
  it('тост появляется и говорит, что именно удалено', async () => {
    await mountTable();
    press(screen.getByRole('button', { name: copy.table }));
    press(menuItem(copy.tableMenu.removeRow));

    expect(await screen.findByText(copy.tableMenu.rowRemoved)).toBeTruthy();
    expect(await undoInToast()).toBeTruthy();
  });

  it('«Отменить» возвращает строку в текст', async () => {
    await mountTable();
    press(screen.getByRole('button', { name: copy.table }));
    press(menuItem(copy.tableMenu.removeRow));

    const text = (): string => activeEditor()?.view?.state.doc.toString() ?? '';
    expect(text()).not.toContain('созвон');

    fireEvent.click(await undoInToast());
    expect(text()).toContain('созвон');
  });
});
