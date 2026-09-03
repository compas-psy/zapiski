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
import { undo, redo } from '@codemirror/commands';
import { listNewline } from '../src/input/lists.js';
import { makeView, pressBackspace, pressEnter } from './helpers.js';

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

/**
 * Набор текста ПОСИМВОЛЬНО через настоящую цепочку `inputHandler` — тот же
 * путь, что при наборе пальцем на клавиатуре, и ДРУГОЙ путь, чем вставка из
 * буфера: `smart-paste.ts` и `setext-guard.ts`/`autoformat.ts` реагируют на
 * ввод по-разному (P1-аудит §1 прямо требует отдельно проверить оба). Вставка
 * получает готовый текст целиком, набор — по символу, и именно на нём
 * срабатывают посимвольные перехватчики вроде `checkboxShortcut`.
 */
function typeChar(view: EditorView, char: string): void {
  const at = view.state.selection.main.head;
  const handled = view.state
    .facet(EditorView.inputHandler)
    .some((handler) => handler(view, at, at, char, () => null as never) === true);
  if (!handled) view.dispatch({ changes: { from: at, insert: char } });
}

function typeText(view: EditorView, text: string): void {
  for (const char of text) typeChar(view, char);
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
  /*
   * Те же две ловушки, что и вставка «---»/«- список» выше, но набором
   * пальцем: `completeDivider` срабатывает по Enter, а не по факту вставки
   * готового текста, и должен опираться на настоящую строку выше себя, а
   * не молчаливо решить её испортить.
   */
  'набрать «---» посимвольно и нажать Enter': (v) => {
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    typeText(v, '---');
    pressEnter(v);
  },
  'набрать «# Новый заголовок» посимвольно': (v) => {
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    typeText(v, '# Новый заголовок');
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
          const originalDoc = view.state.doc.toString();
          const before = topBlocks(view)[0];
          if (before === undefined) throw new Error('пустая матрица: у стартового блока нет узла');
          const beforeName = before.slice(0, before.indexOf('['));

          action(view);

          const after = topBlocks(view);
          if (!knownMerge) {
            expect(after[0]).toBe(before);
          } else {
            // Слияние ожидаемо расширяет узел списка — но это по-прежнему список
            // того же вида, начинающийся там же (не потерял и не переразобрал
            // «Один»), а всё содержимое документа по-прежнему смоделировано
            // блоками до самого конца — никакой прозы не выпало «между» узлами.
            expect(after[0]?.startsWith(`${beforeName}[0,`)).toBe(true);
            const last = after[after.length - 1] ?? '';
            const lastTo = Number(last.slice(last.lastIndexOf(',') + 1, -1));
            expect(lastTo).toBe(view.state.doc.length);
          }

          /*
           * Undo/redo после структурной правки (пункт §2 задания).
           *
           * ОДНО нажатие Ctrl+Z не обязано откатывать действие целиком: у
           * некоторых действий здесь несколько диспетчей подряд (два Enter
           * плюс набор текста, три набранных символа плюс автоформат по
           * Enter) — это настоящая последовательность нажатий, а не одна
           * программная правка, и историей она честно делится на несколько
           * шагов (typing группируется, а переход к автоформату — новый
           * шаг). Это выяснилось не умозрительно: первая версия проверки
           * ждала ОДНОГО отката и падала на обоих таких действиях — не
           * потому что что-то стёрлось, а потому что откатился только
           * последний шаг. Ждать пошагового отката — не баг, а нормальное
           * поведение любого редактора (Ctrl+Z слово за словом).
           *
           * Настоящая гарантия, которую обязана давать история: сколько бы
           * шагов ни было, откат ДОХОДИТ до исходного документа байт-в-байт
           * без потерь и мусора по дороге, а полный повтор — точно до того,
           * что действие построило. Именно это и проверяется — откатом и
           * повтором до упора, а не одним нажатием.
           */
          const docAfterAction = view.state.doc.toString();
          for (let i = 0; i < 20 && view.state.doc.toString() !== originalDoc; i++) {
            const changed = undo(view);
            if (!changed) break;
          }
          expect(view.state.doc.toString(), 'undo до конца не вернул исходный документ').toBe(
            originalDoc,
          );
          for (let i = 0; i < 20 && view.state.doc.toString() !== docAfterAction; i++) {
            const changed = redo(view);
            if (!changed) break;
          }
          expect(view.state.doc.toString(), 'redo до конца не повторил действие').toBe(
            docAfterAction,
          );
        });
      }
    });
  }
});

/**
 * Backspace на границе блока (P1-аудит §11/§12: «Backspace на границах
 * блоков» — отдельный пункт списка, не покрытый действиями выше).
 *
 * У Backspace, в отличие от вставки и команд разметки, НЕТ своей защиты
 * границы — `pressBackspace` в обычном случае падает прямо в
 * `deleteCharBackward` CodeMirror, посимвольное удаление без какой-либо
 * осведомлённости о блочной структуре. Проверяется самый частый жест:
 * лишняя пустая строка под блоком, и человек стирает её одним Backspace —
 * ЭТО не должно менять тип блока НАД собой, вложенные варианты пропущены —
 * не другой код-путь, тот же `deleteCharBackward` для того же семейства.
 */
describe('Backspace на границе блока не меняет тип соседа сверху (P1-аудит)', () => {
  for (const [startName, startSource] of Object.entries(START_BLOCKS)) {
    if (startName.startsWith('nested')) continue;
    it(`Backspace на пустой строке сразу после «${startName}» не портит его AST`, () => {
      view = makeView(`${startSource}\n\n`, { selection: { anchor: startSource.length + 2 } });
      const before = topBlocks(view)[0];
      if (before === undefined) throw new Error('пустая матрица: у стартового блока нет узла');
      const beforeName = before.slice(0, before.indexOf('['));

      pressBackspace(view);

      const after = topBlocks(view)[0];
      expect(
        after?.startsWith(`${beforeName}[0,`),
        `Backspace сменил тип блока: было ${before}, стало ${after}`,
      ).toBe(true);
    });
  }
});
