/**
 * Картинки становятся в ряд, пока помещаются по ширине.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Заказчик: «если добавлять картинки в ЗАПИСКУ, то они размещаются только друг
 * под другом». Причин было две, и одной правки не хватало ни для чего.
 *
 *  1. Оформление: обёртка картинки была `display: block; width: 100%` — блок на
 *     всю ширину колонки, сколько бы места ни оставалось справа.
 *  2. Разметка: команда вставки всегда открывала НОВУЮ строку, а строка в
 *     CodeMirror — отдельный блок. Рядом такие блоки не встанут никаким CSS,
 *     поэтому починка одного оформления ничего бы не изменила.
 *
 * Здесь сторожится вторая половина — та, что живёт в документе и потому
 * проверяема без браузера. Первая половина (инлайн-блок и перенос) — свойство
 * раскладки, её видно только на экране, и она проверяется прогоном в браузере.
 *
 * ── Правило ─────────────────────────────────────────────────────────────────
 *
 * Картинки, добавленные одна за другой, попадают на одну строку. Разрывает
 * группу пустая строка — она была разрывом абзаца и в markdown, и в голове
 * человека. Текст рядом с картинкой запрещает дописывание: строка с буквами —
 * это абзац, а не ряд.
 */
import { EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { insertImage, isImagesOnlyLine } from '../src/index.js';

/** Прогнать команду и вернуть получившийся документ и позицию курсора. */
function run(doc: string, cursor: number, command: StateCommand): { doc: string; head: number } {
  let state = EditorState.create({ doc, selection: { anchor: cursor } });
  command({
    state,
    dispatch: (transaction) => {
      state = transaction.state;
    },
  });
  return { doc: state.doc.toString(), head: state.selection.main.head };
}

const A = '![](attachments/Images/a.png)';
const B = '![](attachments/Images/b.png)';

describe('строка с одними картинками', () => {
  it('узнаётся', () => {
    expect(isImagesOnlyLine(A)).toBe(true);
    expect(isImagesOnlyLine(`${A} ${B}`)).toBe(true);
    expect(isImagesOnlyLine(`  ${A}  `)).toBe(true);
  });

  it('строка с текстом рядом — не ряд картинок', () => {
    /* Абзац с картинкой посреди слов дописывать нельзя: получится каша из
       иллюстрации и мысли. */
    expect(isImagesOnlyLine(`вот схема ${A}`)).toBe(false);
    expect(isImagesOnlyLine(`${A} — вот она`)).toBe(false);
    expect(isImagesOnlyLine('')).toBe(false);
    expect(isImagesOnlyLine('   ')).toBe(false);
  });
});

describe('вторая картинка встаёт рядом с первой', () => {
  it('в пустой заметке первая уходит своей строкой', () => {
    const { doc } = run('', 0, insertImage(A));
    expect(doc).toBe(`${A}\n`);
  });

  it('вторая дописывается в ту же строку, а не под неё', () => {
    /*
     * Главный случай. После первой вставки курсор стоит на пустой строке ПОД
     * картинкой — именно оттуда человек и добавляет вторую. Раньше она уходила
     * вниз, и получался столбец.
     */
    const first = run('', 0, insertImage(A));
    const second = run(first.doc, first.head, insertImage(B));

    expect(second.doc).toBe(`${A} ${B}\n`);
    /* И третья — туда же: ряд растёт, а переносит его браузер по ширине. */
    const third = run(second.doc, second.head, insertImage(A));
    expect(third.doc).toBe(`${A} ${B} ${A}\n`);
  });

  it('курсор внутри строки с картинками — дописываем в конец строки', () => {
    const { doc } = run(`${A}\n`, 3, insertImage(B));
    expect(doc).toBe(`${A} ${B}\n`);
  });

  it('пустая строка разрывает ряд', () => {
    /* Человек нажал Enter дважды — он начал новый абзац, и картинка обязана
       начать новый ряд, а не приклеиться к прошлому. */
    const { doc } = run(`${A}\n\n`, `${A}\n\n`.length, insertImage(B));
    expect(doc).toBe(`${A}\n\n${B}\n`);
  });

  it('текст в строке отправляет картинку своим блоком', () => {
    const { doc } = run('первая мысль', 'первая мысль'.length, insertImage(A));
    expect(doc).toBe(`первая мысль\n\n${A}\n`);
  });

  it('ряд с заданной шириной продолжается тем же рядом', () => {
    /* Ширина живёт в подписи (`|320`) — это соглашение Obsidian. Ряд из
       ужатых картинок и есть то, ради чего заказчик просил перенос по ширине. */
    const sized = '![схема|320](attachments/Images/a.png)';
    const first = run(`${sized}\n`, 0, insertImage(B));
    expect(first.doc).toBe(`${sized} ${B}\n`);
  });
});
