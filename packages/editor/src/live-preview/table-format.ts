/**
 * Таблица выравнивается сама, когда курсор из неё уходит.
 *
 * Дефект, ради которого написано, заказчик назвал «таблица капут при вводе»,
 * и он воспроизводится с первого символа. Таблица markdown держится на
 * пробелах: колонки стоят ровно, пока каждая ячейка добита до общей ширины.
 * Стоит дописать слово — строка становится длиннее остальных, палки
 * разъезжаются, и вместо таблицы на экране лесенка. Дальше хуже: чем больше
 * правок, тем сильнее перекос, и вручную его не выправить — надо пересчитать
 * ширину каждой колонки по самой длинной ячейке во всей таблице.
 *
 * Почему при выходе, а не на каждый набранный символ. Переписывать строку,
 * в которой стоит курсор, нельзя: во время композиции IME (а это весь ввод
 * на телефоне — свайп, диктовка, автозамена) правка DOM composing-узла даёт
 * «символы-призраки». Об этом весь `ime/composition.ts`, и наступать на те же
 * грабли ради косметики незачем. Пока курсор внутри — таблица показывается
 * сырым markdown, как её и правят; вышел — встала ровно.
 *
 * Ровно поэтому же замена делается ОТДЕЛЬНОЙ транзакцией после обновления, а
 * не внутри него: диспатч изнутри `update` CodeMirror запрещает.
 */
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { PluginValue, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

import { renderTable, tableAt } from '../commands/table.js';
import { isComposing } from '../ime/composition.js';

class TableFormatter implements PluginValue {
  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    if (!update.docChanged && !update.selectionSet) return;
    /* Композиция ещё идёт — не трогаем документ вообще. */
    if (isComposing(update.view)) return;

    /* Где курсор БЫЛ, в координатах нового документа. */
    const was = update.changes.mapPos(update.startState.selection.main.head, 1);
    const now = update.state.selection.main.head;
    const doc = update.state.doc;
    if (was > doc.length || now > doc.length) return;

    const left = tableAt(update.state, was);
    if (!left) return;
    /* Курсор всё ещё в той же таблице — правка не закончена.
       Границы сравниваем по строкам: таблица могла подрасти. */
    const here = tableAt(update.state, now);
    if (here && here.firstLine === left.firstLine) return;

    const from = doc.line(left.firstLine).from;
    const to = doc.line(left.lastLine).to;
    const text = renderTable(left);
    if (doc.sliceString(from, to) === text) return;

    /* Курсор вне заменяемого куска, поэтому его позиция отобразится сама и
       никуда не прыгнет — ради этого выравнивание и отложено до выхода. */
    queueMicrotask(() => {
      if (this.view.state.doc.sliceString(from, to) !== doc.sliceString(from, to)) return;
      this.view.dispatch({
        changes: { from, to, insert: text },
        userEvent: 'input.format',
      });
    });
  }
}

/** Расширение: подключается рядом с live-preview. */
export const tableAutoFormat: Extension = ViewPlugin.fromClass(TableFormatter);

/**
 * Выравнивание разом, без ожидания выхода курсора: этим пользуется редактор
 * таблицы, который переписывает её целиком по своей модели.
 */
export function formatTableAt(view: EditorView, pos = view.state.selection.main.head): boolean {
  const model = tableAt(view.state, pos);
  if (!model) return false;
  const doc = view.state.doc;
  const from = doc.line(model.firstLine).from;
  const to = doc.line(model.lastLine).to;
  const text = renderTable(model);
  if (doc.sliceString(from, to) === text) return false;
  view.dispatch({ changes: { from, to, insert: text }, userEvent: 'input.format' });
  return true;
}
