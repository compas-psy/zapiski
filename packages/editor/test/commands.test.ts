/**
 * Команды форматирования и хоткеи (BEHAVIOR §7, §2.7).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import {
  cycleHeading,
  insertCodeBlock,
  insertLink,
  insertTable,
  insertWikiLink,
  setHeading,
  toggleBold,
  toggleBulletList,
  toggleHighlight,
  toggleItalic,
  toggleOrderedList,
  toggleQuote,
  toggleStrike,
  toggleUnderline,
  toggleTaskList,
} from '../src/commands/formatting.js';
import { editorCommands } from '../src/commands/keymap.js';
import { toggleRawMode, rawModeField } from '../src/live-preview/raw-mode.js';
import { makeView } from './helpers.js';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function open(doc: string, anchor: number, head?: number): EditorView {
  view = makeView(doc, { selection: { anchor, ...(head === undefined ? {} : { head }) } });
  return view;
}

describe('пробел в выделении не ломает разметку', () => {
  /*
   * Заказчик: «метки ~~ вставляются с обоих сторон выделенного блока, но
   * фрагмент не перечёркивается». Причина — один пробел: двойной щелчок по
   * слову выделяет его ВМЕСТЕ с пробелом за ним, а закрывающий маркер, перед
   * которым стоит пробел, по правилам markdown закрывающим не считается. На
   * экране оставались обычные тильды и никакого зачёркивания.
   *
   * Проверяется текст документа: именно он уезжает в файл и именно его читает
   * любой другой редактор.
   */
  const cases: Array<[string, (view: EditorView) => boolean, string]> = [
    ['зачёркнутый', toggleStrike, '~~'],
    ['жирный', toggleBold, '**'],
    ['курсив', toggleItalic, '*'],
    ['подсветка', toggleHighlight, '=='],
  ];

  for (const [name, run, mark] of cases) {
    it(`${name}: маркеры ложатся внутрь пробелов`, () => {
      /* Выделено «текст » — со хвостовым пробелом, как отдаёт двойной щелчок. */
      const v = open('Обычный текст здесь', 8, 14);
      run(v);
      expect(v.state.doc.toString()).toBe(`Обычный ${mark}текст${mark} здесь`);
    });
  }

  it('выделение целой строки с переводом строки не ломается', () => {
    const v = open('Первая строка\nвторая', 0, 14);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('**Первая строка**\nвторая');
  });

  it('выделены одни пробелы — ведём себя как без выделения', () => {
    const v = open('до    после', 2, 6);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('до****    после');
  });

  it('пробелы внутри выделения не трогаются', () => {
    const v = open('раз два три', 0, 11);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('**раз два три**');
  });
});

describe('парные маркеры', () => {
  it('Ctrl+B оборачивает выделение', () => {
    const v = open('жирный текст', 0, 6);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('**жирный** текст');
  });

  it('повторный Ctrl+B снимает обёртку', () => {
    const v = open('**жирный** текст', 2, 8);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('жирный текст');
  });

  it('без выделения вставляет пару и ставит курсор между маркерами', () => {
    const v = open('', 0);
    toggleItalic(v);
    expect(v.state.doc.toString()).toBe('**');
    expect(v.state.selection.main.head).toBe(1);
  });

  it('Ctrl+U даёт ==подсветку==, а не подчёркивание', () => {
    const v = open('важно', 0, 5);
    toggleHighlight(v);
    expect(v.state.doc.toString()).toBe('==важно==');
  });

  it('подчёркнутый оборачивает в <u> и снимается повторным нажатием', () => {
    /*
     * Заказчик попросил кнопку подчёркивания рядом с курсивом и зачёркнутым.
     * Своего знака у markdown для него нет ни в CommonMark, ни в GFM, поэтому
     * берётся html — тот же приём, что уже взят для надстрочного текста.
     */
    const v = open('важно', 0, 5);
    toggleUnderline(v);
    expect(v.state.doc.toString()).toBe('<u>важно</u>');

    toggleUnderline(v);
    expect(v.state.doc.toString(), 'повторное нажатие не сняло разметку').toBe('важно');
  });
});

/**
 * P1-аудит: Ctrl+I поверх уже жирного текста должен добавить курсив к
 * жирному (`***word***`), а не снять жирный. Направление «жирный → курсив»
 * ломалось, а обратное («курсив → жирный») — нет, и разница объясняется
 * устройством `hasOuter` в `toggleWrap`.
 *
 * Для `doc = "**word**"`, выделение "word" (позиции 2–6), `toggleItalic`
 * (`open = close = '*'`): `outerFrom = 2 - 1 = 1`, `sliceDoc(1, 2)` — это
 * ВТОРОЙ символ открывающего `**`, тоже `'*'`. Проверка «совпал ли открывающий
 * маркер» этого не различает и совпадает случайно: символ действительно `*`,
 * но как часть более длинного маркера `**`, а не сам по себе. `hasOuter`
 * становится `true`, код разворачивает то, что считает курсивом, и жирный
 * маркер стирается наполовину — результат `*word*`, жирности нет вовсе.
 *
 * Обратное направление («курсив → жирный», `doc = "*word*"`, `toggleBold`,
 * `open = close = '**'`) совпадения не ловит: `outerFrom = 2 - 2 = 0`,
 * `sliceDoc(0, 2)` — это `"*w"`, а не `"**"`, потому что открывающий маркер
 * короче двух символов. Отсюда и асимметрия из аудита.
 */
describe('жирный + курсив вместе (P1-аудит)', () => {
  it('Ctrl+I поверх «**word**» добавляет курсив, а не снимает жирный', () => {
    const v = open('**word**', 2, 6);
    toggleItalic(v);
    expect(v.state.doc.toString()).toBe('***word***');
    /*
     * `***word***` разбирается как `Emphasis[0,10] > StrongEmphasis[1,9]`
     * (внешний слой — курсив, внутренний — жирный: подтверждено дампом
     * дерева, у "word" нет собственного узла, поэтому `resolveInner`
     * посередине содержимого возвращает именно `StrongEmphasis`, самый
     * внутренний ИМЕНОВАННЫЙ узел).
     */
    const tree = syntaxTree(v.state);
    const inner = tree.resolveInner(5, 0);
    expect(inner.name).toBe('StrongEmphasis');
    expect(inner.parent?.name).toBe('Emphasis');
  });

  it('Ctrl+B поверх «*word*» добавляет жирный, а не снимает курсив (уже верно — не регресс)', () => {
    const v = open('*word*', 1, 5);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('***word***');
  });

  it('Ctrl+I поверх «***word***» снимает курсив и оставляет жирный', () => {
    const v = open('***word***', 3, 7);
    toggleItalic(v);
    expect(v.state.doc.toString()).toBe('**word**');
  });

  it('Ctrl+B поверх «**word**» по-прежнему снимает жирный целиком (не задето фиксом)', () => {
    const v = open('**word**', 2, 6);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('word');
  });

  it('Ctrl+B поверх «***word***» снимает жирный и оставляет курсив (не задето фиксом: open.length===2 — своя ветка)', () => {
    const v = open('***word***', 3, 7);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('*word*');
  });

  it('туда-обратно: курсив на жирном добавляется и снимается без потерь', () => {
    const v = open('**word**', 2, 6);
    toggleItalic(v);
    expect(v.state.doc.toString()).toBe('***word***');
    toggleItalic(v);
    expect(v.state.doc.toString()).toBe('**word**');
  });
});

/**
 * P1-аудит closure-pass: «пересекающееся inline-форматирование ломает
 * существующую Markdown-разметку». Выделение, которое ЧАСТИЧНО задевает
 * готовый маркер (не целиком внутри, не целиком снаружи — режет саму
 * границу маркера), раньше вставляло новую пару символов буквально по
 * краям выделения, не зная, что там проходит середина чужого маркера.
 *
 * Пример: `**bold** text`, выделено «old\*\* t» (позиции 4–10, пересекает
 * закрывающий `**` и уходит в соседнее слово), `Ctrl+B` — было:
 * `**bo**ld** t**ext`, разметка сломана необратимо (проверено вручную
 * перед фиксом, см. коммит).
 *
 * Правило: если граница выделения лежит СТРОГО внутри уже существующего
 * оборачиваемого узла — эта граница раздвигается до границы узла целиком,
 * пока резать середину чужого маркера негде не станет вовсе. Итог не
 * обязан быть «минимальным» (лишний уровень вложенности допустим), но
 * обязан быть ВАЛИДНЫМ markdown, где старое форматирование не потеряно —
 * проверяется деревом, не только строкой.
 */
describe('пересекающееся выделение не ломает существующую разметку (P1-аудит)', () => {
  it('выделение через закрывающий ** внутрь соседнего слова — bold остаётся целым узлом', () => {
    const v = open('**bold** text', 4, 10);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('****bold** t**ext');
    const tree = syntaxTree(v.state);
    // Старый "bold" остался ЦЕЛЫМ вложенным StrongEmphasis — не разрублен.
    const boldNode = tree.resolveInner(6, 0); // где-то внутри "bold"
    let node: typeof boldNode | null = boldNode;
    let foundClean = false;
    for (; node; node = node.parent) {
      if (node.name === 'StrongEmphasis' && v.state.sliceDoc(node.from, node.to) === '**bold**') {
        foundClean = true;
        break;
      }
    }
    expect(foundClean, 'исходный **bold** должен остаться целым узлом дерева').toBe(true);
  });

  it('выделение через открывающий ** из соседнего слова — bold остаётся целым узлом', () => {
    const v = open('text **bold**', 3, 9);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('tex**t **bold****');
    const tree = syntaxTree(v.state);
    const node = tree.resolveInner(10, 0); // где-то внутри "bold"
    let cur: typeof node | null = node;
    let foundClean = false;
    for (; cur; cur = cur.parent) {
      if (cur.name === 'StrongEmphasis' && v.state.sliceDoc(cur.from, cur.to) === '**bold**') {
        foundClean = true;
        break;
      }
    }
    expect(foundClean, 'исходный **bold** должен остаться целым узлом дерева').toBe(true);
  });

  it('выделение частично внутри курсива, Ctrl+B — курсив остаётся целым узлом, документ валиден', () => {
    const v = open('*italic* text', 3, 10);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('***italic* t**ext');
    const tree = syntaxTree(v.state);
    const node = tree.resolveInner(5, 0); // где-то внутри "italic"
    let cur: typeof node | null = node;
    let foundClean = false;
    for (; cur; cur = cur.parent) {
      if (cur.name === 'Emphasis' && v.state.sliceDoc(cur.from, cur.to) === '*italic*') {
        foundClean = true;
        break;
      }
    }
    expect(foundClean, 'исходный *italic* должен остаться целым узлом дерева').toBe(true);
  });

  it('выделение целиком внутри готового маркера — обычное снятие, не задето фиксом', () => {
    const v = open('**bold** text', 2, 6);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('bold text');
  });
});

/**
 * P1-аудит closure-pass: «форматирование через границу блока оставляет
 * мусорные маркеры». `**` открытый в одном абзаце и закрытый в другом — не
 * разметка ни для одного парсера: CommonMark inline-разбор не выходит за
 * пределы блока, в котором начался. Выделение через два абзаца и Ctrl+B
 * оставляло два бессмысленных `**` голым текстом — жирности не было нигде.
 * Правильный ответ — честный отказ (документ не меняется), а не вставка
 * маркеров, которые ничего не форматируют.
 */
describe('форматирование через границу блока отказывается, а не мусорит (P1-аудит)', () => {
  it('выделение через два абзаца — документ не меняется', () => {
    const v = open('First paragraph\n\nSecond paragraph', 6, 25);
    const before = v.state.doc.toString();
    toggleBold(v);
    expect(v.state.doc.toString()).toBe(before);
  });

  it('выделение из абзаца в пункт списка — документ не меняется', () => {
    const v = open('Text here\n\n- item one', 5, 20);
    const before = v.state.doc.toString();
    toggleBold(v);
    expect(v.state.doc.toString()).toBe(before);
  });

  it('выделение из заголовка в абзац — документ не меняется', () => {
    const v = open('# Heading\n\nBody text', 3, 15);
    const before = v.state.doc.toString();
    toggleBold(v);
    expect(v.state.doc.toString()).toBe(before);
  });

  it('выделение внутри ОДНОГО абзаца по-прежнему работает — не задето фиксом', () => {
    const v = open('First paragraph\n\nSecond paragraph', 0, 5);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('**First** paragraph\n\nSecond paragraph');
  });
});

describe('заголовки', () => {
  it('Ctrl+1..6 ставят нужный уровень', () => {
    for (let level = 1; level <= 6; level++) {
      const v = open('Заголовок', 3);
      setHeading(level)(v);
      expect(v.state.doc.toString()).toBe(`${'#'.repeat(level)} Заголовок`);
      v.destroy();
      view = null;
    }
  });

  it('Ctrl+0 возвращает обычный абзац', () => {
    const v = open('### Заголовок', 5);
    setHeading(0)(v);
    expect(v.state.doc.toString()).toBe('Заголовок');
  });

  it('повторный Ctrl+2 снимает заголовок', () => {
    const v = open('## Заголовок', 5);
    setHeading(2)(v);
    expect(v.state.doc.toString()).toBe('Заголовок');
  });

  describe('Setext heading recovery — «Обычный текст» снимает и подчёркивание (MVP P0 §7)', () => {
    /*
     * Заказчик: «текст вдруг стал крупным, а избавиться невозможно». Причина —
     * у Setext-заголовка маркер живёт на СЛЕДУЮЩЕЙ строке (подчёркивание `---`
     * или `===`), а `setHeading(0)` снимает маркер только текущей строки через
     * `splitLine()`. На строке содержимого маркера нет вовсе — команда была
     * молчаливым no-op именно там, где пользователь её и вызывал.
     */
    it('Setext H2 (---) без текста ниже: подчёркивание снимается целиком', () => {
      const v = open('Текст\n-----', 2);
      expect(setHeading(0)(v)).toBe(true);
      expect(v.state.doc.toString()).toBe('Текст\n\n');
      expect(syntaxTree(v.state).topNode.getChild('SetextHeading2')).toBeNull();
    });

    it('Setext H2 (---) с текстом ниже: подчёркивание уходит, абзац остаётся нетронутым', () => {
      const v = open('Текст\n-----\nСледующий', 2);
      expect(setHeading(0)(v)).toBe(true);
      expect(v.state.doc.toString()).toBe('Текст\n\nСледующий');
      const tree = syntaxTree(v.state);
      expect(tree.topNode.getChild('SetextHeading2')).toBeNull();
      const paragraphs = tree.topNode.getChildren('Paragraph');
      expect(paragraphs.some((p) => v.state.sliceDoc(p.from, p.to) === 'Следующий')).toBe(true);
    });

    it('Setext H1 (===) снимается тем же способом', () => {
      const v = open('Текст\n=====', 2);
      expect(setHeading(0)(v)).toBe(true);
      expect(v.state.doc.toString()).toBe('Текст\n\n');
      expect(syntaxTree(v.state).topNode.getChild('SetextHeading1')).toBeNull();
    });

    it('курсор на самой строке подчёркивания — тот же результат', () => {
      const v = open('Текст\n-----', 7);
      expect(setHeading(0)(v)).toBe(true);
      expect(v.state.doc.toString()).toBe('Текст\n\n');
    });

    it('Ctrl+2 на первой строке МНОГОСТРОЧНОГО Setext честно рвёт его на ATX + абзац', () => {
      /*
       * `Заголовок\nТекст\n-----` — это ОДИН Setext H2 (CommonMark разрешает
       * многострочное содержимое подчёркиванию: обе строки без пустой между
       * ними — один и тот же абзац, и `-----` подчёркивает его целиком, а не
       * только «Текст»; проверено деревом разбора). Курсор на первой строке —
       * курсор ВНУТРИ этого заголовка, а не рядом с чужим.
       *
       * До P1-аудита команда трогала только строку «Заголовок» и оставляла
       * «Текст\n-----» как есть — но результат `## Заголовок\nТекст\n-----`
       * заново разбирается уже НЕ как «нетронутый чужой Setext», а как ДВА
       * заголовка: ATX H2 «Заголовок» и НОВЫЙ, никем не просимый Setext H2
       * «Текст» — то есть прежнее поведение само создавало заголовок из
       * воздуха, просто на строку ниже. Теперь подчёркивание снимается вместе
       * с превращением в ATX, и «Текст» остаётся обычным абзацем — везде
       * ровно то, о чём попросили, и ничего лишнего не появляется.
       */
      const v = open('Заголовок\nТекст\n-----', 2);
      setHeading(2)(v);
      expect(v.state.doc.toString()).toBe('## Заголовок\nТекст\n\n');
      const tree = syntaxTree(v.state);
      expect(tree.topNode.getChild('SetextHeading2')).toBeNull();
      expect(tree.topNode.getChild('ATXHeading2')).not.toBeNull();
      const paragraphs = tree.topNode.getChildren('Paragraph');
      expect(paragraphs.some((p) => v.state.sliceDoc(p.from, p.to) === 'Текст')).toBe(true);
    });
  });

  describe('setHeading(N>0) на Setext-заголовке не оставляет мусора (P1-аудит)', () => {
    /*
     * `setHeading(0)`/«Обычный текст» уже умел снимать Setext-подчёркивание
     * (см. блок выше) — а сам выбор конкретного уровня (Ctrl+1…6) не умел
     * вовсе: он прописывал ATX-маркер НАД строкой содержимого, но
     * подчёркивание СНИЗУ не трогал. Для H2/H1 это оставляло посторонний
     * HorizontalRule под новым заголовком; для любого другого уровня — ещё
     * хуже: буквальный текст «=====» становился видимым абзацем под
     * заголовком, которого никто не печатал.
     */
    it('Setext H2 (---) → Ctrl+1: подчёркивание уходит, никакого HorizontalRule не остаётся', () => {
      const v = open('Текст\n-----', 2);
      expect(setHeading(1)(v)).toBe(true);
      // Подчёркивание в конце документа схлопывается до настоящей пустой
      // строки — тот же приём и тот же итог, что уже доказан для Ctrl+0.
      expect(v.state.doc.toString()).toBe('# Текст\n\n');
      const tree = syntaxTree(v.state);
      expect(tree.topNode.getChild('SetextHeading2')).toBeNull();
      expect(tree.topNode.getChild('HorizontalRule')).toBeNull();
      expect(tree.topNode.getChild('ATXHeading1')).not.toBeNull();
    });

    it('Setext H1 (===) → Ctrl+3: подчёркивание уходит, «=====» не остаётся видимым текстом', () => {
      const v = open('Текст\n=====', 2);
      expect(setHeading(3)(v)).toBe(true);
      expect(v.state.doc.toString()).toBe('### Текст\n\n');
      const tree = syntaxTree(v.state);
      expect(tree.topNode.getChild('SetextHeading1')).toBeNull();
      expect(v.state.doc.toString()).not.toContain('=====');
      expect(tree.topNode.getChild('ATXHeading3')).not.toBeNull();
    });

    it('Setext H1 (===) → Ctrl+1: даже «тот же самый» уровень не no-op, а честное превращение в ATX', () => {
      const v = open('Текст\n=====', 2);
      expect(setHeading(1)(v)).toBe(true);
      // Подчёркивание в конце документа схлопывается до настоящей пустой
      // строки — тот же приём и тот же итог, что уже доказан для Ctrl+0
      // (см. «Setext H2 (---) без текста ниже» выше).
      expect(v.state.doc.toString()).toBe('# Текст\n\n');
      expect(syntaxTree(v.state).topNode.getChild('SetextHeading1')).toBeNull();
    });

    it('текст ниже подчёркивания остаётся нетронутым', () => {
      const v = open('Текст\n-----\nСледующий абзац', 2);
      expect(setHeading(2)(v)).toBe(true);
      expect(v.state.doc.toString()).toBe('## Текст\n\nСледующий абзац');
    });
  });

  it('«H» в тулбаре крутит H1 → H2 → H3 → обычный', () => {
    const v = open('Текст', 2);
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('# Текст');
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('## Текст');
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('### Текст');
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('Текст');
  });
});

describe('блочные команды', () => {
  it('маркированный и нумерованный списки', () => {
    const v = open('один\nдва', 0, 8);
    toggleBulletList(v);
    expect(v.state.doc.toString()).toBe('- один\n- два');
    v.dispatch({ selection: EditorSelection.single(0, v.state.doc.length) });
    toggleOrderedList(v);
    expect(v.state.doc.toString()).toBe('1. один\n2. два');
  });

  it('чекбоксы и цитата', () => {
    const v = open('дело', 0, 4);
    toggleTaskList(v);
    expect(v.state.doc.toString()).toBe('- [ ] дело');
    const q = makeView('мысль', { selection: { anchor: 0, head: 5 } });
    toggleQuote(q);
    expect(q.state.doc.toString()).toBe('> мысль');
    q.destroy();
  });

  it('код-блок оборачивает выделение', () => {
    const v = open('let a = 1;', 0, 10);
    insertCodeBlock(v);
    expect(v.state.doc.toString()).toBe('```\nlet a = 1;\n```');
  });

  it('код-блок без выделения ставит курсор внутрь', () => {
    const v = open('', 0);
    insertCodeBlock(v);
    expect(v.state.doc.toString()).toBe('```\n\n```');
    expect(v.state.selection.main.head).toBe(4);
  });
});

describe('вставки ссылок и таблиц', () => {
  it('Ctrl+L оборачивает выделение и ставит курсор в url', () => {
    const v = open('текст', 0, 5);
    insertLink(v);
    expect(v.state.doc.toString()).toBe('[текст]()');
    expect(v.state.selection.main.head).toBe(8);
  });

  it('Ctrl+Shift+W вставляет wiki-ссылку с курсором внутри', () => {
    const v = open('', 0);
    insertWikiLink(v);
    expect(v.state.doc.toString()).toBe('[[]]');
    expect(v.state.selection.main.head).toBe(2);
  });

  it('таблица вставляется с шапкой и разделителем', () => {
    const v = open('', 0);
    insertTable(v);
    const lines = v.state.doc.toString().split('\n');
    /* Заготовка — три столбца и две строки тела, как в приложениях, откуда
       человек приходит: шапка, разделитель и две пустые строки. */
    expect(lines.length).toBe(4);
    expect(lines[0]?.split('|').filter((cell) => cell.trim() !== '')).toHaveLength(3);
    expect(lines[1]).toContain('---');
  });
});

describe('карта хоткеев', () => {
  it('покрывает все хоткеи редактора из BEHAVIOR §7', () => {
    const keys = new Set(editorCommands.map((c) => c.key));
    for (const key of [
      'Mod-b',
      'Mod-i',
      'Mod-u',
      'Mod-Shift-u',
      'Mod-1',
      'Mod-2',
      'Mod-3',
      'Mod-4',
      'Mod-5',
      'Mod-6',
      'Mod-0',
      'Mod-Shift-l',
      'Mod-Shift-o',
      'Mod-Shift-k',
      'Mod-Shift-q',
      'Mod-Shift-c',
      'Mod-l',
      'Mod-Shift-w',
      'Mod-d',
      'Alt-ArrowUp',
      'Alt-ArrowDown',
      'Mod-Enter',
      'Mod-f',
      'Mod-h',
      'Mod-e',
      'Mod-Shift-f',
    ]) {
      expect(keys, `нет хоткея ${key}`).toContain(key);
    }
  });

  it('идентификаторы команд уникальны — палитра строится из этого списка', () => {
    const ids = editorCommands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Ctrl+E переключает raw-режим', () => {
    const v = open('# Заголовок', 0);
    expect(v.state.field(rawModeField)).toBe(false);
    toggleRawMode(v);
    expect(v.state.field(rawModeField)).toBe(true);
    toggleRawMode(v);
    expect(v.state.field(rawModeField)).toBe(false);
  });
});

/**
 * Начертания на ссылке (снимок веб-версии).
 *
 * Заказчик: «вот так выглядит ссылка, но её нельзя обернуть жирным или
 * курсивом или жирным курсивом». И правда: пара маркеров падала в середину
 * подписи — `[Вот**** так выглядит ссылка](адрес)`.
 */
describe('жирный и курсив на ссылке', () => {
  const LINK = '[подпись](https://example.org)';

  it('курсор внутри ссылки оборачивает её целиком', () => {
    const v = open(LINK, 3);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe(`**${LINK}**`);
  });

  it('повторное нажатие снимает', () => {
    const v = open(`**${LINK}**`, 5);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe(LINK);
  });

  it('курсив ведёт себя так же', () => {
    const v = open(LINK, 3);
    toggleItalic(v);
    expect(v.state.doc.toString()).toBe(`*${LINK}*`);
  });

  it('вне ссылки поведение прежнее: пара маркеров под курсором', () => {
    const v = open('обычный текст', 3);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('обы****чный текст');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Список под абзацем не делает из абзаца заголовок
// ─────────────────────────────────────────────────────────────────────────────

describe('маркерный список под абзацем', () => {
  /*
   * Заказчик: «набрал текст, потом ":", потом Enter, потом выбрал маркированный
   * список — и весь текст выше стал заголовком. При этом # нигде в тексте нет».
   *
   * В CommonMark строка из дефисов под абзацем — подчёркивание заголовка, а не
   * список: пустой пункт абзац прервать не может. Ровно это и происходило.
   *
   * Проверяется ТЕКСТ документа, а не показ: заголовок был настоящий, файл с
   * ним так же откроется в Obsidian и на GitHub.
   */
  it('ставит пустую строку, иначе абзац станет заголовком', () => {
    const v = open('Слишком много выбора:\n', 22);
    toggleBulletList(v);
    expect(v.state.doc.toString()).toBe('Слишком много выбора:\n\n- ');
  });

  it('курсор остаётся за маркером, а не перед ним', () => {
    const v = open('Слишком много выбора:\n', 22);
    toggleBulletList(v);
    /* Строка с маркером — последняя, курсор в её конце. */
    const line = v.state.doc.line(v.state.doc.lines);
    expect(v.state.selection.main.head).toBe(line.to);
  });

  it('внутри списка пустой строки не добавляет: она разредила бы список', () => {
    const v = open('- первый\n', 9);
    toggleBulletList(v);
    expect(v.state.doc.toString()).toBe('- первый\n- ');
  });

  it('после пустой строки ничего лишнего не вставляет', () => {
    const v = open('Абзац\n\n', 7);
    toggleBulletList(v);
    expect(v.state.doc.toString()).toBe('Абзац\n\n- ');
  });

  it('на непустой строке пустую строку не вставляет: там список и так список', () => {
    const v = open('Абзац\nпункт', 7);
    toggleBulletList(v);
    expect(v.state.doc.toString()).toBe('Абзац\n- пункт');
  });

  it('нумерованный список под абзацем тоже требует пустой строки', () => {
    /*
     * Это утверждение я сначала написал неверно — ждал `Абзац\n1. `, потому
     * что заголовка там действительно не появляется. Но и списка не
     * появляется: пустой пункт не может прервать абзац, и «1.» молча
     * прилипает к нему текстом. Кнопка нажата, а результата нет — беда
     * тише предыдущей, но того же рода. Нашла её матрица окружений.
     */
    const v = open('Абзац\n', 6);
    toggleOrderedList(v);
    expect(v.state.doc.toString()).toBe('Абзац\n\n1. ');
  });

  it('цитата под абзацем тоже остаётся цитатой', () => {
    const v = open('Абзац\n', 6);
    toggleQuote(v);
    expect(v.state.doc.toString()).toBe('Абзац\n> ');
  });

  it('после правки парсер не видит заголовка — а это и есть жалоба', () => {
    /*
     * Утверждение о ТЕКСТЕ доказывает не всё: заказчик жаловался не на строку,
     * а на то, что абзац стал крупным. Крупным его делает разбор, поэтому
     * спрашиваем дерево — то самое, которым рисуется живой показ.
     */
    const v = open('Слишком много выбора:\n', 22);
    toggleBulletList(v);
    const names: string[] = [];
    syntaxTree(v.state).iterate({ enter: (node) => void names.push(node.name) });
    expect(names.filter((n) => /Heading/.test(n)), 'абзац снова стал заголовком').toEqual([]);
    expect(names).toContain('BulletList');
  });

  it('снятие маркера пустой строки не добавляет', () => {
    const v = open('Абзац\n\n- пункт', 10);
    toggleBulletList(v);
    expect(v.state.doc.toString()).toBe('Абзац\n\nпункт');
  });
});
