/**
 * Единый владелец правила «нужна ли настоящая пустая строка, чтобы очередное
 * действие не переопределило AST соседнего блока» (BEHAVIOR MVP §8).
 *
 * До этого модуля правило жило внутри `commands/formatting.ts` и было
 * известно только `input/setext-guard.ts` — а следующая жалоба того же
 * класса («список → Enter × 2 → абзац» и «Setext не снимается командой
 * "Обычный текст"») чинилась заново, своим кодом на месте использования.
 * Один владелец — значит одна проверка синтаксическим деревом, а не пять
 * похожих regex, которые однажды разъедутся.
 */
import { syntaxTree } from '@codemirror/language';
import type { EditorState, ChangeSpec } from '@codemirror/state';

/**
 * Пустой пункт списка ИЛИ одиночный `=` — единственные маркеры, которым
 * может понадобиться пустая строка сверху. `=` сюда попал по той же причине,
 * что и `-`/`*`/`+`: он не список, а единственный кандидат в Setext-H1
 * (`====`), и без этой же защиты набор `=` под абзацем молча укрупняет его
 * в заголовок (P1-аудит — тот же класс дефекта, что уже закрыт для `-`).
 */
const EMPTY_LIST_ITEM = /^[\t ]{0,3}(?:[-*+=]|\d+[.)])[\t ]*$/;

/**
 * Строка выше `lineNumber` — «опасный» сосед, у которого непустая строка
 * рядом способна переопределить его AST-тип (Setext underline, поглощение
 * списком и т. п.).
 *
 * Безопасен ровно один сосед — пункт списка: там `- ` начинает соседний
 * пункт, и пустая строка только разредила бы список. Во всех остальных
 * случаях непустой соседней строки пустая строка ставится: правило
 * разрешительное (а не «это абзац» / «это заголовок»), потому что виды
 * блока, которые Setext-подчёркивание готово поглотить, шире одного абзаца
 * — например, строка таблицы.
 *
 * Принадлежность списку выясняется у того же дерева разбора, которым
 * рисуется живой показ, — гадать по виду строки здесь нечем.
 */
function previousLineIsDangerousNeighbor(state: EditorState, lineNumber: number): boolean {
  if (lineNumber <= 1) return false;
  const previous = state.doc.line(lineNumber - 1);
  if (previous.text.trim().length === 0) return false;

  const node = syntaxTree(state).resolveInner(Math.min(previous.from + 1, previous.to), 1);
  for (let cursor: typeof node | null = node; cursor !== null; cursor = cursor.parent) {
    if (cursor.name === 'ListItem') return false;
  }
  return true;
}

/**
 * Нужна ли пустая строка перед вставляемым маркером `nextText` на строке
 * `lineNumber`.
 */
export function needsBlankLineBefore(
  state: EditorState,
  lineNumber: number,
  nextText: string,
): boolean {
  if (!EMPTY_LIST_ITEM.test(nextText)) return false;
  return previousLineIsDangerousNeighbor(state, lineNumber);
}

/**
 * Строка, способная сама начать блок, который переопределит AST соседа
 * сверху (BEHAVIOR MVP §9 — защита Paste): маркер списка/нумерации/цитаты
 * ИЛИ Setext-подчёркивание/тематический разрыв (`---`, `===`, 3+ символа).
 *
 * Уже пропущенное правило `needsBlankLineBefore` рассчитано на строго ПУСТОЙ
 * пункт списка (кнопка/ручной ввод одного маркера); вставка приносит целый
 * готовый текст, где первая строка списка обычно уже с содержимым
 * (`- раз`), а сама «опасная» форма шире — включает и thematic-break-подобные
 * строки, которых при точечном вводе одного символа не бывает.
 */
const PASTE_BLOCK_START = /^[\t ]{0,3}(?:(?:[-*+]|\d+[.)])(?:[\t ]|$)|>[\t ]?|[-=]{3,}[\t ]*$)/;

/**
 * Нужна ли пустая строка перед вставляемым текстом `pastedText`, если он
 * ложится на строку `lineNumber` (первую строку текущего выделения после
 * вставки).
 */
export function pasteNeedsBlankLineBefore(
  state: EditorState,
  lineNumber: number,
  pastedText: string,
): boolean {
  const firstLine = pastedText.split('\n', 1)[0] ?? '';
  if (!PASTE_BLOCK_START.test(firstLine)) return false;
  return previousLineIsDangerousNeighbor(state, lineNumber);
}

/**
 * Курсор уже внутри открытого блока кода (P1-аудит).
 *
 * Четыре обработчика ввода (`checkboxShortcut`, `setextGuard`,
 * `completeDivider`, `enterAtBlockStart`) разбирают ТЕКСТ строки под
 * курсором regex'ом — и одинаково не знали, что строка при этом может лежать
 * внутри уже открытого код-блока. Код-комментарий `# fake` или голая `[]` в
 * примере JSON тогда read'ились как настоящая разметка и переписывались:
 * содержимое кода — единственное место документа, которое не должно
 * переинтерпретироваться НИКОГДА, вне зависимости от того, на что оно похоже.
 * Правда о границе кода — только в дереве разбора, как и у Setext.
 */
export function isInsideFence(state: EditorState, pos: number): boolean {
  const node = syntaxTree(state).resolveInner(pos, -1);
  for (let cursor: typeof node | null = node; cursor !== null; cursor = cursor.parent) {
    if (cursor.name === 'FencedCode') return true;
  }
  return false;
}

/**
 * Строка Setext-подчёркивания заголовка, которому принадлежит `pos` — если
 * таковой вообще есть.
 *
 * У Setext (`Текст\n---` → H2, `Текст\n===` → H1) маркер живёт на СЛЕДУЮЩЕЙ
 * строке, а не на строке содержимого — ни один построчный regex его не
 * увидит с позиции текущей строки. Правда о заголовке — только в дереве
 * разбора.
 */
export function setextUnderlineOf(
  state: EditorState,
  pos: number,
): { from: number; to: number } | null {
  let node = syntaxTree(state).resolveInner(pos, 1);
  for (; node.parent; node = node.parent) {
    if (node.name === 'SetextHeading1' || node.name === 'SetextHeading2') {
      const mark = node.getChild('HeaderMark');
      if (!mark) return null;
      const line = state.doc.lineAt(mark.from);
      return { from: line.from, to: line.to };
    }
  }
  return null;
}

/**
 * Стереть строку-границу (пустой маркер списка, Setext-подчёркивание) до
 * настоящей пустой Markdown-строки — то есть до двух подряд `\n`.
 *
 * Стирается именно текст строки, а не сам перенос: если ниже уже есть ещё
 * содержимое, отделяющий его перенос строки сам становится вторым `\n` —
 * ничего добавлять не нужно. Если же эта строка последняя в документе,
 * второго переноса взять неоткуда, и его приходится вставить явно.
 *
 * (Оба места, где это понадобилось — выход из списка на пустом пункте
 * верхнего уровня и снятие Setext-подчёркивания командой «Обычный текст» —
 * доказаны отдельно, диагностикой синтаксического дерева на реальных
 * документах, до того как эта функция получила общее имя.)
 */
export function collapseLineToBlankBoundary(
  state: EditorState,
  line: { from: number; to: number },
): { changes: ChangeSpec; cursor: number } {
  const atDocumentEnd = line.to === state.doc.length;
  const insert = atDocumentEnd ? '\n' : '';
  return {
    changes: { from: line.from, to: line.to, insert },
    cursor: line.from + insert.length,
  };
}
