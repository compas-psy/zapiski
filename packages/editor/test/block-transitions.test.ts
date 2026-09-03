/**
 * Регрессионная матрица переходов между блочными типами (MVP P0 §11).
 *
 * Не бесконечный перебор всех сочетаний — представительный набор действий,
 * которые исторически и порождали ловушки этого класса (выход из списка,
 * Setext, вставка), применённый ПОСЛЕ каждого вида стартового блока.
 *
 * Главная проверка §11: до и после операции AST соседнего НЕИЗМЕНЯЕМОГО блока
 * не должен менять тип. Здесь проверка строже — сравнивается весь отпечаток
 * (имя узла + границы) первого топ-уровневого блока документа: если действие
 * адресовано только новому содержимому, добавленному СТРОГО ПОСЛЕ стартового
 * блока, узел стартового блока обязан остаться тем же самым — не просто
 * «похожего типа», а буквально не сдвинуться и не переразобраться.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { listNewline } from '../src/input/lists.js';
import { makeView } from './helpers.js';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

/** Отпечаток топ-уровневых блоков документа: имя узла + границы, по порядку. */
function topBlocks(view: EditorView): string[] {
  const out: string[] = [];
  let node = syntaxTree(view.state).topNode.firstChild;
  while (node) {
    out.push(`${node.name}[${node.from},${node.to}]`);
    node = node.nextSibling;
  }
  return out;
}

/** Минимальный DataTransfer для jsdom — тот же приём, что и в paste.test.ts. */
function clipboard(text: string): DataTransfer {
  return {
    getData: (type: string) => (type === 'text/plain' ? text : ''),
    files: { length: 0, item: () => null },
    items: { length: 0 },
  } as unknown as DataTransfer;
}

function dispatchPaste(target: EditorView, text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent & {
    clipboardData: DataTransfer;
  };
  Object.defineProperty(event, 'clipboardData', { value: clipboard(text) });
  target.contentDOM.dispatchEvent(event);
}

/** Стартовые блоки из §11 — источник, дающий РОВНО один топ-уровневый блок. */
const START_BLOCKS: Record<string, string> = {
  paragraph: 'Обычный абзац',
  bullet: '- Один',
  ordered: '1. Один',
  task: '- [ ] Один',
  'nested bullet': '- Один\n  - Вложенный',
  'nested ordered': '1. Один\n   1. Вложенный',
  'heading H1': '# Заголовок',
  'heading H2': '## Заголовок',
  blockquote: '> Цитата',
  table: '| A | B |\n| --- | --- |\n| 1 | 2 |',
  'fenced code': '```js\nlet a = 1;\n```',
  'thematic break': '***',
};

/** Действия из §11/§12 — то, что раньше умело переопределять соседний блок. */
const ACTIONS: Record<string, (v: EditorView) => void> = {
  'список → Enter × 2 → paragraph': (v) => {
    const at = v.state.doc.length;
    v.dispatch({ changes: { from: at, insert: '- Раз' }, selection: { anchor: at + 5 } });
    listNewline(v);
    listNewline(v);
    const pos = v.state.selection.main.head;
    v.dispatch({ changes: { from: pos, insert: 'Текст' }, selection: { anchor: pos + 5 } });
  },
  'paste "---"': (v) => {
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    dispatchPaste(v, '---');
  },
  'paste "- новый список"': (v) => {
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    dispatchPaste(v, '- новый список');
  },
  'paste "1. новый список"': (v) => {
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    dispatchPaste(v, '1. новый список');
  },
};

/**
 * Известное, корректное исключение из «не меняет AST»: CommonMark сливает
 * ДВА списка одного семейства маркеров в ОДИН loose list, если между ними
 * ровно одна пустая строка, — это стандартное поведение формата (то же самое
 * получится в любом markdown-редакторе), а не порча блока сверху. Список
 * маркеров, который porождает каждое действие, действительно того же
 * семейства, что и старт, — проверено по факту (`BulletList[0,13]` вместо
 * `BulletList[0,6]` — «Раз» стал вторым пунктом ТОГО ЖЕ списка, а не потерял
 * «Один» и не поглотил «Текст», который остаётся отдельным Paragraph ниже).
 */
const BULLET_FAMILY_STARTS = new Set(['bullet', 'task', 'nested bullet']);
const ORDERED_FAMILY_STARTS = new Set(['ordered', 'nested ordered']);
const BULLET_PRODUCING_ACTIONS = new Set(['список → Enter × 2 → paragraph', 'paste "- новый список"']);
const ORDERED_PRODUCING_ACTIONS = new Set(['paste "1. новый список"']);

function isKnownListMerge(startName: string, actionName: string): boolean {
  if (BULLET_FAMILY_STARTS.has(startName) && BULLET_PRODUCING_ACTIONS.has(actionName)) return true;
  if (ORDERED_FAMILY_STARTS.has(startName) && ORDERED_PRODUCING_ACTIONS.has(actionName)) return true;
  return false;
}

describe('регрессионная матрица блочных переходов (block-transitions)', () => {
  for (const [startName, startSource] of Object.entries(START_BLOCKS)) {
    describe(`START = ${startName}`, () => {
      for (const [actionName, action] of Object.entries(ACTIONS)) {
        const knownMerge = isKnownListMerge(startName, actionName);
        const title = knownMerge
          ? `${actionName} сливается в тот же список (CommonMark loose list) — не корчит его`
          : `${actionName} после блока не меняет его AST`;

        it(title, () => {
          // Блок отделён гарантированно настоящей пустой строкой — сама граница
          // не тестируется здесь (это P0 §4/§7/§9, покрыто отдельно), проверяется
          // только то, что действие НИЖЕ не задевает узел блока ВЫШЕ.
          view = makeView(`${startSource}\n\n`, { selection: { anchor: startSource.length + 2 } });
          const before = topBlocks(view)[0];
          if (before === undefined) throw new Error('пустая матрица: у стартового блока нет узла');
          const beforeName = before.slice(0, before.indexOf('['));

          action(view);

          const after = topBlocks(view);
          if (!knownMerge) {
            expect(after[0]).toBe(before);
            return;
          }
          // Слияние ожидаемо расширяет узел списка — но это по-прежнему список
          // того же вида, начинающийся там же (не потерял и не переразобрал
          // «Один»), а всё содержимое документа по-прежнему смоделировано
          // блоками до самого конца — никакой прозы не выпало «между» узлами.
          expect(after[0]?.startsWith(`${beforeName}[0,`)).toBe(true);
          const last = after[after.length - 1] ?? '';
          const lastTo = Number(last.slice(last.lastIndexOf(',') + 1, -1));
          expect(lastTo).toBe(view.state.doc.length);
        });
      }
    });
  }
});
