/**
 * Автоформатирование при вводе и работа со списками (BEHAVIOR §2.1).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { completeDivider, completeFencedCode } from '../src/input/autoformat.js';
import {
  dedentListItem,
  indentListItem,
  listBackspace,
  listNewline,
  MAX_LIST_DEPTH,
} from '../src/input/lists.js';
import { makeView, pressEnter } from './helpers.js';

/** Строка курсора не принадлежит ни одному `ListItem` — список действительно позади. */
function insideListItem(state: EditorState, pos: number): boolean {
  let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, -1);
  for (; node; node = node.parent) {
    if (node.name === 'ListItem') return true;
  }
  return false;
}

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

/** Прогнать StateCommand по состоянию и вернуть новый документ. */
function runState(
  state: EditorState,
  command: (target: {
    state: EditorState;
    dispatch: (tr: ReturnType<EditorState['update']>) => void;
  }) => boolean,
): { doc: string; ok: boolean; state: EditorState } {
  let next = state;
  const ok = command({ state, dispatch: (tr) => (next = tr.state) });
  return { doc: next.doc.toString(), ok, state: next };
}

function stateOf(doc: string, anchor: number): EditorState {
  const v = makeView(doc, { selection: { anchor } });
  const state = v.state;
  v.destroy();
  return state;
}

describe('автоформатирование при вводе', () => {
  it('`[] ` в начале строки превращается в чекбокс', () => {
    view = makeView('[]', { selection: { anchor: 2 } });
    // inputHandler ловит пробел до попадания в документ.
    const handled = view.state
      .facet(EditorView.inputHandler)
      .some((handler) => handler(view as EditorView, 2, 2, ' ', () => null as never));
    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe('- [ ] ');
  });

  it('`- [] ` тоже превращается в чекбокс, маркер сохраняется', () => {
    view = makeView('- []', { selection: { anchor: 4 } });
    view.state
      .facet(EditorView.inputHandler)
      .some((handler) => handler(view as EditorView, 4, 4, ' ', () => null as never));
    expect(view.state.doc.toString()).toBe('- [ ] ');
  });

  it('вложенный `[] ` сохраняет отступ', () => {
    view = makeView('  - []', { selection: { anchor: 6 } });
    view.state
      .facet(EditorView.inputHandler)
      .some((handler) => handler(view as EditorView, 6, 6, ' ', () => null as never));
    expect(view.state.doc.toString()).toBe('  - [ ] ');
  });

  it('```язык + Enter достраивает код-блок и ставит курсор внутрь', () => {
    view = makeView('```js', { selection: { anchor: 5 } });
    expect(completeFencedCode(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('```js\n\n```');
    expect(view.state.selection.main.head).toBe(6);
  });

  it('повторный Enter в уже закрытом блоке ничего не достраивает', () => {
    view = makeView('```js\nlet a = 1;\n```', { selection: { anchor: 5 } });
    expect(completeFencedCode(view)).toBe(false);
  });

  it('--- + Enter даёт разделитель, а не setext-заголовок', () => {
    view = makeView('Абзац\n---', { selection: { anchor: 9 } });
    expect(completeDivider(view)).toBe(true);
    // Пустая строка выше — иначе CommonMark считает это заголовком H2.
    expect(view.state.doc.toString()).toBe('Абзац\n\n---\n');
  });

  it('--- после пустой строки просто переносит курсор', () => {
    view = makeView('Абзац\n\n---', { selection: { anchor: 10 } });
    expect(completeDivider(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('Абзац\n\n---\n');
  });
});

describe('Enter, Tab и Backspace в списках', () => {
  it('Enter создаёт следующий элемент того же типа', () => {
    const { doc } = runState(stateOf('- первый', 8), listNewline);
    expect(doc).toBe('- первый\n- ');
  });

  it('Enter в нумерованном списке продолжает нумерацию', () => {
    const { doc } = runState(stateOf('1. первый', 9), listNewline);
    expect(doc).toBe('1. первый\n2. ');
  });

  it('Enter в списке задач создаёт новый чекбокс', () => {
    const { doc } = runState(stateOf('- [ ] задача', 12), listNewline);
    expect(doc).toContain('- [ ] ');
    expect(doc.split('\n').length).toBe(2);
  });

  it('Enter на пустом элементе выходит из списка', () => {
    const { doc } = runState(stateOf('- первый\n- ', 11), listNewline);
    expect(doc.endsWith('- ')).toBe(false);
  });

  describe('выход из списка на пустом элементе верхнего уровня — настоящая граница блока (MVP P0)', () => {
    /*
     * Заказчик: обычная последовательность «список → Enter → Enter → следующий
     * абзац» на деле не создаёт новый top-level абзац. `insertNewlineContinue-
     * MarkupCommand` на пустом элементе снимает маркер, но оставляет ОДИН
     * перенос строки — это не настоящая пустая строка CommonMark, а значит
     * следующий введённый текст становится lazy continuation прежнего пункта
     * и молча возвращается внутрь списка/абзаца, из которого человек только
     * что вышел.
     *
     * Слабый тест выше («doc.endsWith('- ') === false») этого не ловит —
     * "- первый\n" тоже не заканчивается на «- », и тест зелёный на дефекте.
     */
    it('bullet: после второго Enter получается настоящая пустая строка, а не lazy continuation', () => {
      view = makeView('- Один', { selection: { anchor: 6 } });
      expect(listNewline(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('- Один\n- ');

      expect(listNewline(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('- Один\n\n');
      expect(view.state.selection.main.head).toBe(view.state.doc.length);
      expect(insideListItem(view.state, view.state.selection.main.head)).toBe(false);

      const pos = view.state.selection.main.head;
      view.dispatch({ changes: { from: pos, insert: 'Текст' }, selection: { anchor: pos + 5 } });
      expect(view.state.doc.toString()).toBe('- Один\n\nТекст');
      expect(insideListItem(view.state, view.state.doc.length)).toBe(false);

      const finalState = view.state;
      const paragraphs = syntaxTree(finalState).topNode.getChildren('Paragraph');
      expect(paragraphs.some((p) => finalState.sliceDoc(p.from, p.to) === 'Текст')).toBe(true);
    });

    it('ordered: та же граница после второго Enter', () => {
      view = makeView('1. Один', { selection: { anchor: 7 } });
      listNewline(view);
      listNewline(view);
      expect(view.state.doc.toString()).toBe('1. Один\n\n');
      expect(insideListItem(view.state, view.state.doc.length)).toBe(false);
    });

    it('task: та же граница после второго Enter', () => {
      view = makeView('- [ ] Один', { selection: { anchor: 10 } });
      listNewline(view);
      listNewline(view);
      expect(view.state.doc.toString()).toBe('- [ ] Один\n\n');
      expect(insideListItem(view.state, view.state.doc.length)).toBe(false);
    });

    it('список не в конце документа: следующий абзац сохраняет тип, а не становится частью списка', () => {
      view = makeView('- Один\n- \nВторой абзац', { selection: { anchor: 9 } });
      expect(listNewline(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('- Один\n\nВторой абзац');
      expect(insideListItem(view.state, view.state.doc.length)).toBe(false);
      const finalState = view.state;
      const paragraphs = syntaxTree(finalState).topNode.getChildren('Paragraph');
      expect(
        paragraphs.some((p) => finalState.sliceDoc(p.from, p.to) === 'Второй абзац'),
      ).toBe(true);
    });

    it('вложенный пустой элемент: Enter выводит на уровень выше, не выходя из списка сразу', () => {
      view = makeView('- Один\n  - ', { selection: { anchor: 11 } });
      expect(listNewline(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('- Один\n- ');
      expect(insideListItem(view.state, view.state.doc.length)).toBe(true);
    });

    it('undo возвращает пустой элемент списка одним логическим шагом', () => {
      // Уже пустой пункт — Enter, который тестируется, ровно один: выход из
      // списка. Undo обязан откатить именно эту транзакцию целиком.
      view = makeView('- Один\n- ', { selection: { anchor: 9 } });
      expect(listNewline(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('- Один\n\n');
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('- Один\n- ');
    });
  });

  it('Tab увеличивает вложенность', () => {
    const { doc, ok } = runState(stateOf('- пункт', 3), indentListItem);
    expect(ok).toBe(true);
    expect(doc).toBe('  - пункт');
  });

  it('вложенность ограничена шестью уровнями', () => {
    let state = stateOf(`${'  '.repeat(MAX_LIST_DEPTH - 1)}- глубоко`, 2);
    const result = runState(state, indentListItem);
    expect(result.ok).toBe(false);
    state = stateOf(`${'  '.repeat(MAX_LIST_DEPTH - 2)}- почти`, 2);
    expect(runState(state, indentListItem).ok).toBe(true);
  });

  it('Shift+Tab уменьшает вложенность', () => {
    const { doc, ok } = runState(stateOf('    - пункт', 6), dedentListItem);
    expect(ok).toBe(true);
    expect(doc).toBe('  - пункт');
  });

  it('Tab вне списка не срабатывает — фокус уходит дальше', () => {
    expect(runState(stateOf('обычный абзац', 3), indentListItem).ok).toBe(false);
  });

  it('Backspace в начале элемента снимает маркер, не удаляя строку', () => {
    const state = stateOf('- пункт', 2);
    const { doc } = runState(state, listBackspace);
    expect(doc).toBe('pпункт'.replace('p', ''));
    expect(doc).toBe('пункт');
  });

  it('несколько выделенных строк сдвигаются одной командой', () => {
    const base = stateOf('- один\n- два', 0);
    const withSelection = base.update({
      selection: EditorSelection.single(0, base.doc.length),
    }).state;
    const { doc } = runState(withSelection, indentListItem);
    expect(doc).toBe('  - один\n  - два');
  });

  /*
   * P1-аудит, самая серьёзная находка списочного аудита: Tab/Shift+Tab на
   * пункте с ВЛОЖЕННЫМ поддеревом двигали только СТРОКУ КУРСОРА — ни
   * `LIST_ITEM`-regex, ни выбор строк по `state.selection.ranges` не знали
   * про дочерние пункты, лежащие НИЖЕ курсора в тексте, но принадлежащие
   * тому же `ListItem` по дереву. Результат на `"- Parent\n  - Child"`,
   * Tab на "Parent": `"  - Parent\n  - Child"` — оба пункта получили
   * ОДИНАКОВЫЙ отступ, и AST это подтверждает буквально: `Child` был
   * `ListItem` ВНУТРИ `Parent`, а стал его СОСЕДОМ в одном плоском
   * `BulletList` — вложенность потеряна безвозвратно одним нажатием.
   */
  describe('Tab/Shift+Tab на пункте с поддеревом двигают поддерево целиком (P1-аудит)', () => {
    function topLevelItems(state: EditorState): number {
      return syntaxTree(state).topNode.getChild('BulletList')?.getChildren('ListItem').length ?? 0;
    }

    it('Tab на родителе уносит вложенный дочерний пункт вместе с собой', () => {
      view = makeView('- Parent\n  - Child', { selection: { anchor: 2 } });
      expect(topLevelItems(view.state)).toBe(1); // Child уже вложен, на верхнем уровне один пункт
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('  - Parent\n    - Child');
      // Дерево обязано остаться тем же: Parent — единственный пункт нового
      // вложенного списка на его собственном уровне, Child по-прежнему внутри.
      expect(insideListItem(view.state, view.state.doc.length)).toBe(true);
    });

    it('Shift+Tab на родителе уносит вложенный дочерний пункт вместе с собой', () => {
      view = makeView('  - Parent\n    - Child', { selection: { anchor: 4 } });
      expect(dedentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('- Parent\n  - Child');
    });

    it('глубже: Tab на родителе с двумя уровнями вложенности двигает всё поддерево', () => {
      view = makeView('- A\n  - B\n    - C', { selection: { anchor: 2 } });
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('  - A\n    - B\n      - C');
    });

    it('Tab на самом ВЛОЖЕННОМ пункте не трогает родителя и не выходит за предел глубины родителя', () => {
      view = makeView('- Parent\n  - Child', { selection: { anchor: 12 } }); // курсор внутри "Child"
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('- Parent\n    - Child');
    });

    it('предел вложенности проверяется по корню поддвига, а не по каждой строке отдельно', () => {
      const deepChild = `${'  '.repeat(MAX_LIST_DEPTH - 1)}- глубоко`;
      view = makeView(`- Parent\n${deepChild}`, { selection: { anchor: 2 } });
      // Parent сам на глубине 0 — сдвиг его поддерева разрешён, несмотря на то
      // что дочерний пункт уже глубоко: предел считается от корня операции.
      expect(indentListItem(view)).toBe(true);
    });
  });

  /*
   * P1-аудит closure-pass, эскалация из классификации: «ширина list-indent
   * не совпадает с шириной маркера». Фиксированные 2 пробела — ширина
   * маркера `- `, но не `1. ` (3 символа) и тем более не `10. ` (4). Tab на
   * нумерованном списке визуально сдвигал текст, но настоящий GFM-парсер
   * вложения не видел вовсе: пункт оставался ПЛОСКИМ соседом того же списка,
   * просто с посторонним отступом внутри.
   */
  describe('шаг Tab для нумерованного списка равен ширине маркера родителя (P1-аудит)', () => {
    function orderedTopLevelItems(state: EditorState): number {
      return syntaxTree(state).topNode.getChild('OrderedList')?.getChildren('ListItem').length ?? 0;
    }

    it('Tab на втором пункте нумерованного списка создаёт настоящее вложение', () => {
      view = makeView('1. Parent\n2. Item', { selection: { anchor: 10 } });
      expect(orderedTopLevelItems(view.state)).toBe(2); // пока плоский список из двух пунктов
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('1. Parent\n   2. Item');
      // После Tab — ровно ОДИН пункт верхнего уровня, второй вложен внутрь.
      expect(orderedTopLevelItems(view.state)).toBe(1);
      expect(insideListItem(view.state, view.state.doc.length)).toBe(true);
    });

    it('двузначный номер: шаг берётся из ширины маркера НАД собой, а не своей', () => {
      const doc = '9. Item9\n10. Item10';
      view = makeView(doc, { selection: { anchor: doc.indexOf('10.') } });
      expect(indentListItem(view)).toBe(true);
      // «9. » — 3 символа, столько же и добавляется, а не ширина «10. » (4).
      expect(view.state.doc.toString()).toBe('9. Item9\n   10. Item10');
      expect(orderedTopLevelItems(view.state)).toBe(1);
    });

    it('Tab → Shift+Tab возвращает документ к исходному байт-в-байт', () => {
      const original = '1. Parent\n2. Item';
      view = makeView(original, { selection: { anchor: 10 } });
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('1. Parent\n   2. Item');
      expect(dedentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(original);
    });

    it('маркированный список — шаг по-прежнему 2 пробела, не задето фиксом', () => {
      view = makeView('- один\n- два', { selection: { anchor: 8 } });
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('- один\n  - два');
    });
  });
});

/**
 * P1-аудит closure-pass, эскалация из классификации доп. находок: «выход
 * Enter из пустой цитаты занимает 3 нажатия и глотает текст» — «NOT
 * ACCEPTABLE — RECOMMEND IMMEDIATE FIX».
 *
 * У списка пустой пункт выходит на ВТОРОМ Enter (доказано выше, «выход из
 * списка на пустом пункте верхнего уровня»). До этого фикса цитата на тот
 * же жест отвечала иначе: второй Enter на пустой строке `>` не выходил из
 * цитаты, а добавлял ещё одну пустую цитируемую строку — выход происходил
 * только на ТРЕТЬЕМ нажатии. Хуже количества нажатий: человек, ожидающий
 * поведения списка, набирал текст сразу после второго Enter — и текст
 * молча становился НОВЫМ ПРОЦИТИРОВАННЫМ абзацем внутри всё ещё открытой
 * цитаты, а не обычным абзацем, каким он должен был стать.
 */
describe('выход из цитаты на пустой строке — тот же жест, что и у списка (P1-аудит)', () => {
  function insideBlockquote(state: EditorState, pos: number): boolean {
    let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, -1);
    for (; node; node = node.parent) {
      if (node.name === 'Blockquote') return true;
    }
    return false;
  }

  it('второй Enter на пустой строке цитаты — настоящий выход, тот же счёт нажатий, что у списка', () => {
    view = makeView('> Цитата', { selection: { anchor: 8 } });
    expect(pressEnter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('> Цитата\n> ');
    expect(insideBlockquote(view.state, view.state.doc.length)).toBe(true);

    expect(pressEnter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('> Цитата\n\n');
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(insideBlockquote(view.state, view.state.doc.length)).toBe(false);
  });

  it('текст, набранный сразу после второго Enter, — обычный абзац, а не новая цитируемая строка', () => {
    view = makeView('> Цитата', { selection: { anchor: 8 } });
    pressEnter(view);
    pressEnter(view);
    const pos = view.state.selection.main.head;
    view.dispatch({ changes: { from: pos, insert: 'Текст' }, selection: { anchor: pos + 5 } });
    expect(view.state.doc.toString()).toBe('> Цитата\n\nТекст');
    expect(insideBlockquote(view.state, view.state.doc.length)).toBe(false);

    const paragraphs = syntaxTree(view.state).topNode.getChildren('Paragraph');
    expect(paragraphs.some((p) => view?.state.sliceDoc(p.from, p.to) === 'Текст')).toBe(true);
  });

  it('цитата не в конце документа: следующий абзац сохраняет тип, а не остаётся в цитате', () => {
    view = makeView('> Цитата\n> \nВторой абзац', { selection: { anchor: 11 } });
    expect(pressEnter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('> Цитата\n\nВторой абзац');
    expect(insideBlockquote(view.state, view.state.doc.length)).toBe(false);
  });

  it('undo возвращает пустую строку цитаты одним логическим шагом', () => {
    view = makeView('> Цитата\n> ', { selection: { anchor: 11 } });
    expect(pressEnter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('> Цитата\n\n');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('> Цитата\n> ');
  });
});
