/**
 * Таблица показывается таблицей — и у чужого файла тоже.
 *
 * ── Отказ ───────────────────────────────────────────────────────────────────
 *
 * Заказчик: «я скопировал .md файл с хорошей разметкой в ЗАПИСКИ. Посмотри на
 * скрине, как коряво открылась таблица». В приложенном источнике таблицы
 * записаны так, как их пишут все на свете, кроме нас: `|---|---:|---|`, ячейки
 * не добиты пробелами, в ячейке — целое предложение.
 *
 * Прежний показ держался ровно на том, чего в чужом файле нет: палки прятались,
 * а колонки «стояли» лишь потому, что наш же `table-format.ts` добивал ячейки
 * пробелами до общей ширины. Отсюда и скриншот.
 *
 * ── Что здесь сторожится ────────────────────────────────────────────────────
 *
 *  1. невыровненный чужой исходник рисуется настоящей `<table>`;
 *  2. файл при этом НЕ переписывается — ни одного знака (file over app);
 *  3. курсор внутри — сырой markdown, как его и правят;
 *  4. разметка внутри ячейки показывается разметкой, а не звёздочками.
 *
 * Ширины колонок и переносы меряет браузерный прогон
 * (`scripts/check-table-render.mjs`): в happy-dom нет раскладки, и «колонки
 * стоят» от «колонки разъехались» там неотличимо.
 */
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { afterEach, describe, expect, it } from 'vitest';

import { makeState, makeView } from './helpers.js';
import { cellSpans } from '../src/commands/table.js';
import { inlineTokens } from '../src/live-preview/inline-text.js';
import { nextSpans, parseTableSource, tableSpans } from '../src/live-preview/table-view.js';
import { setRawMode } from '../src/live-preview/raw-mode.js';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

/** Таблица ровно того вида, что пришла от заказчика: ничего не выровнено. */
const FOREIGN = [
  '| Параметр | Статус | Рабочие варианты |',
  '|---|---|---:|',
  '| Срок ответа | **Не указано** | от суток до недели, зависит от нагрузки |',
  '| Формат отчёта | Черновик | таблица или список — на выбор |',
].join('\n');

const NOTE = `# Отчёт\n\n${FOREIGN}\n\nХвост после таблицы.\n`;

const tableBox = (): Element | null => document.querySelector('.cm-z-tableview');

describe('чужая таблица рисуется таблицей', () => {
  it('невыровненный исходник даёт настоящую <table> с шапкой и строками', () => {
    const v = makeView(NOTE, { selection: { anchor: 0 } });
    view = v;

    const box = tableBox();
    expect(box, 'таблицы на экране нет — остались палки').not.toBeNull();
    expect(box?.querySelectorAll('thead th')).toHaveLength(3);
    expect(box?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(box?.querySelectorAll('tbody tr:first-child td')).toHaveLength(3);
  });

  it('файл не переписан ни одним знаком', () => {
    /*
     * Выровнять чужой файл при открытии было бы проще всего — и это худший
     * выход: заметка помечается изменённой, уезжает в облако и возвращается на
     * второе устройство «изменённой», хотя человек её не трогал.
     */
    const v = makeView(NOTE, { selection: { anchor: 0 } });
    view = v;
    expect(v.state.doc.toString()).toBe(NOTE);
  });

  it('разметка в ячейке показана разметкой, а не звёздочками', () => {
    const v = makeView(NOTE, { selection: { anchor: 0 } });
    view = v;

    const strong = document.querySelector('.cm-z-tableview .cm-z-strong');
    expect(strong?.textContent).toBe('Не указано');
    expect(tableBox()?.textContent ?? '', 'звёздочки видны читателю').not.toContain('**');
  });

  it('выравнивание колонки из разделителя доходит до ячейки', () => {
    const v = makeView(NOTE, { selection: { anchor: 0 } });
    view = v;

    const last = document.querySelectorAll('.cm-z-tableview thead th')[2] as HTMLElement;
    expect(last.style.textAlign, 'колонка `---:` не прижата вправо').toBe('right');
  });

  it('курсор внутри — таблица снова сырой markdown', () => {
    const v = makeView(NOTE, { selection: { anchor: NOTE.indexOf('Черновик') } });
    view = v;
    expect(tableBox(), 'правится markdown, а не виджет').toBeNull();

    /* Ушёл курсор — таблица вернулась. */
    v.dispatch({ selection: { anchor: 0 } });
    expect(tableBox()).not.toBeNull();
  });

  it('граница таблицы считается прилегающей — стрелка входит в неё, а не через неё', () => {
    /*
     * Курсор, вставший ровно на первую позицию таблицы (так он туда и попадает
     * стрелкой сверху), обязан считаться «внутри»: иначе войти в таблицу с
     * клавиатуры было бы нельзя вовсе — виджет позиций внутри себя не даёт.
     */
    const start = NOTE.indexOf('| Параметр');
    const v = makeView(NOTE, { selection: { anchor: start } });
    view = v;
    expect(tableBox()).toBeNull();
  });

  it('в режиме «Разметка» виджета нет: файл показан как есть', () => {
    const v = makeView(NOTE, { selection: { anchor: 0 } });
    view = v;
    expect(tableBox()).not.toBeNull();

    v.dispatch({ effects: setRawMode.of(true) });
    expect(tableBox(), 'raw-режим обязан показывать сам markdown').toBeNull();

    v.dispatch({ effects: setRawMode.of(false) });
    expect(tableBox()).not.toBeNull();
  });
});

describe('где таблицы в документе', () => {
  const spansOf = (doc: string): Array<[number, number]> =>
    tableSpans(EditorState.create({ doc }).doc).map((span) => [span.from, span.to]);

  it('таблица без строки-разделителя таблицей не считается', () => {
    /* GFM без разделителя таблицы не видит, и мы не выдумываем: тот же файл в
       чужом редакторе выглядел бы иначе. Разделитель дописывает
       `table-format.ts`, когда курсор из набранной руками таблицы уходит. */
    expect(spansOf('вариант А | вариант Б\n| раз | два |\n| три | четыре |')).toHaveLength(0);
  });

  it('две таблицы через абзац не сливаются в одну', () => {
    const doc = ['| а | б |', '| - | - |', '', 'Между.', '', '| в | г |', '| - | - |'].join('\n');
    expect(spansOf(doc)).toHaveLength(2);
  });

  it('границы — от начала первой строки до конца последней', () => {
    const doc = 'До.\n| а | б |\n| - | - |\nПосле.';
    const [span] = spansOf(doc);
    expect(doc.slice(span?.[0], span?.[1])).toBe('| а | б |\n| - | - |');
  });
});

describe('границы пересчитываются по правке, а не заново', () => {
  const state = (doc: string): EditorState => makeState(doc, { selection: { anchor: 0 } });

  it('правка вдали от таблицы сдвигает её границы вместе с текстом', () => {
    const doc = 'Вступление.\n\n| а | б |\n| - | - |\n';
    const start = state(doc);
    const before = tableSpans(start.doc);
    const tr = start.update({ changes: { from: 0, insert: 'Ещё строка.\n' } });
    const after = nextSpans(before, tr).spans;

    expect(after).toHaveLength(1);
    expect(after[0]?.from).toBe((before[0]?.from ?? 0) + 'Ещё строка.\n'.length);
    /* Тот же ответ, что и у полного прохода, — иначе экономия куплена враньём. */
    expect(after).toEqual(tableSpans(tr.state.doc));
  });

  it('строка, вставленная посреди таблицы, разрывает её надвое', () => {
    const doc = '| а | б |\n| - | - |\n| в | г |\n| д | е |\n| ж | з |\n';
    const start = state(doc);
    const before = tableSpans(start.doc);
    expect(before).toHaveLength(1);

    const cut = doc.indexOf('| д');
    const tr = start.update({ changes: { from: cut, insert: 'Просто текст.\n' } });
    const after = nextSpans(before, tr).spans;
    expect(after).toEqual(tableSpans(tr.state.doc));
  });

  it('удалённый абзац склеивает две таблицы в одну', () => {
    const doc = ['| а | б |', '| - | - |', '', '| в | г |', '| - | - |', ''].join('\n');
    const start = state(doc);
    const before = tableSpans(start.doc);
    expect(before).toHaveLength(2);

    const gap = doc.indexOf('| - | - |') + '| - | - |'.length;
    const tr = start.update({ changes: { from: gap, to: gap + 1 } });
    const after = nextSpans(before, tr).spans;
    expect(after).toHaveLength(1);
    expect(after).toEqual(tableSpans(tr.state.doc));
  });

  it('таблица, потерявшая разделитель, перестаёт быть таблицей', () => {
    const doc = '| а | б |\n| - | - |\n| в | г |\n';
    const start = state(doc);
    const before = tableSpans(start.doc);
    const from = doc.indexOf('| - | - |');
    const tr = start.update({ changes: { from, to: from + '| - | - |'.length, insert: '| x | y |' } });
    expect(nextSpans(before, tr).spans).toEqual(tableSpans(tr.state.doc));
  });
});

describe('разбор исходника для показа', () => {
  it('смещение ячейки указывает на её текст, а не на палку', () => {
    const source = '| а | б |\n| - | - |\n| раз | два |';
    const model = parseTableSource(source);
    const cell = model?.body[0]?.[1];
    expect(cell?.text).toBe('два');
    expect(source.slice(cell?.at, (cell?.at ?? 0) + 3)).toBe('два');
  });

  it('строка короче шапки дополняется пустыми ячейками', () => {
    const model = parseTableSource('| а | б | в |\n| - | - | - |\n| раз |');
    expect(model?.width).toBe(3);
    expect(model?.body[0]).toHaveLength(1);
  });

  it('без строки-разделителя разбора нет', () => {
    expect(parseTableSource('| а | б |\n| раз | два |')).toBeNull();
  });
});

describe('ячейки строки и их места', () => {
  it('экранированная палка остаётся в тексте ячейки', () => {
    const spans = cellSpans('| a \\| b | c |');
    expect(spans.map((cell) => cell.text)).toEqual(['a \\| b', 'c']);
  });

  it('смещения указывают на текст без окружающих пробелов', () => {
    const line = '|  раз   | два |';
    const spans = cellSpans(line);
    expect(line.slice(spans[0]?.from, spans[0]?.to)).toBe('раз');
    expect(line.slice(spans[1]?.from, spans[1]?.to)).toBe('два');
  });
});

describe('разметка внутри ячейки', () => {
  const text = (source: string): string =>
    inlineTokens(source)
      .map((token) => token.text)
      .join('');

  it('жирный и код теряют свои знаки', () => {
    expect(text('**Не указано** и `код`')).toBe('Не указано и код');
    expect(inlineTokens('**Не указано**')[0]?.bold).toBe(true);
    expect(inlineTokens('`код`')[0]?.code).toBe(true);
  });

  it('подчёркивание внутри слова не курсив', () => {
    /* Чужие документы полны имён вроде `max_drawdown_target`, и превращать их
       в курсив значит менять текст на экране. */
    expect(inlineTokens('max_drawdown_target').map((token) => token.italic)).toEqual([undefined]);
  });

  it('умножение не курсив', () => {
    expect(inlineTokens('2 * 3 * 4').map((token) => token.italic)).toEqual([undefined]);
  });

  it('одинокая звёздочка остаётся звёздочкой', () => {
    expect(text('снос* по правилам')).toBe('снос* по правилам');
  });

  it('у ссылки показывается подпись, адрес прячется', () => {
    const tokens = inlineTokens('[правила](https://example.org/rules)');
    expect(text('[правила](https://example.org/rules)')).toBe('правила');
    expect(tokens[0]?.link).toBe(true);
  });

  it('wiki-ссылка показывает подпись после палки', () => {
    expect(text('[[Заметка о сроках|сроки]]')).toBe('сроки');
  });

  it('<br> становится переносом, а не текстом', () => {
    const tokens = inlineTokens('раз<br>два');
    expect(tokens.map((token) => token.br === true)).toEqual([false, true, false]);
  });

  it('экранированная палка показывается палкой', () => {
    expect(text('до \\| после')).toBe('до | после');
  });
});
