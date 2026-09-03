/**
 * Правка таблиц (ITERATION-1 §4).
 *
 * Спецификация называет это «самой недооценённой частью, без которой таблица
 * нередактируема на телефоне», и она права: markdown-таблица держится на
 * палках `|`, и вставка столбца руками означает поправить каждую строку, не
 * сбившись.
 *
 * Здесь проверяется модель — разбор, действия, сборка обратно. Она умышленно
 * не знает ни о DOM, ни о представлении: ровность таблицы можно проверить
 * только текстом, а именно ровность и ломается первой.
 */
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import {
  alignColumn,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  removeColumn,
  removeRow,
  renderTable,
  setCell,
  tableAt,
  tableEnter,
  toggleHeader,
} from '../src/commands/table.js';
import { makeView } from './helpers.js';

/** Канонический вид: колонки по самой длинной ячейке, минимум три дефиса. */
const TABLE = [
  '| Дело   | Срок |',
  '| ------ | ---- |',
  '| созвон | пн   |',
  '| отчёт  | ср   |',
].join('\n');

/** Состояние с курсором на позиции `|` в тексте (палка таблицы — `¦`). */
function at(text: string): EditorState {
  const pos = text.indexOf('¦');
  return EditorState.create({ doc: text.replace('¦', ''), selection: { anchor: Math.max(0, pos) } });
}

/** Разбор + действие + сборка — то, что реально ложится в файл. */
function applied(text: string, act: (model: NonNullable<ReturnType<typeof tableAt>>) => unknown): string {
  const state = at(text);
  const model = tableAt(state);
  expect(model, 'таблица не разобралась').not.toBeNull();
  const next = act(model as NonNullable<typeof model>);
  if (next === null) return '';
  return renderTable(next as NonNullable<typeof model>);
}

describe('разбор таблицы под курсором', () => {
  it('находит границы, шапку и ячейки', () => {
    const model = tableAt(at(TABLE.replace('созвон', 'соз¦вон')));
    expect(model?.header).toBe(true);
    expect(model?.rows).toEqual([
      ['Дело', 'Срок'],
      ['созвон', 'пн'],
      ['отчёт', 'ср'],
    ]);
    /* Разделитель выброшен из строк: курсор во второй строке данных — это
       строка 1, а не 2. */
    expect(model?.row).toBe(1);
  });

  it('знает колонку по числу палок слева от курсора', () => {
    expect(tableAt(at('| a | ¦b |\n| - | - |'))?.column).toBe(1);
    expect(tableAt(at('| ¦a | b |\n| - | - |'))?.column).toBe(0);
  });

  it('вне таблицы — null', () => {
    expect(tableAt(at('обычный ¦текст'))).toBeNull();
  });

  it('соседняя таблица через абзац — другая таблица', () => {
    const text = '| a |\n| - |\n\nтекст\n\n| b¦ |\n| - |';
    const model = tableAt(at(text));
    expect(model?.rows).toEqual([['b']]);
  });

  it('таблица без разделителя опознаётся, но шапки у неё нет', () => {
    const model = tableAt(at('| a¦ | b |\n| c | d |'));
    expect(model?.header).toBe(false);
    expect(model?.rows.length).toBe(2);
  });

  it('рваные строки дополняются пустыми ячейками', () => {
    /* Чужой файл вправе быть неровным — разбор не должен об это спотыкаться. */
    const model = tableAt(at('| a¦ | b | c |\n| - | - | - |\n| d |'));
    expect(model?.rows[1]).toEqual(['d', '', '']);
  });
});

describe('строки', () => {
  it('вставка снизу', () => {
    const out = applied(TABLE.replace('созвон', 'соз¦вон'), (model) => insertRow(model, 'below'));
    expect(out.split('\n')[3]).toMatch(/^\|\s+\|\s+\|$/);
    expect(out.split('\n')).toHaveLength(5);
  });

  it('вставка сверху не подменяет шапку', () => {
    /* Курсор в шапке, «вставить сверху» — новая строка обязана уйти ПОД
       разделитель, иначе таблица теряет заголовок. */
    const out = applied(TABLE.replace('Дело', 'Де¦ло'), (model) => insertRow(model, 'above'));
    expect(out.split('\n')[0]).toContain('Дело');
    expect(out.split('\n')[1]).toMatch(/^\|\s*-/);
  });

  it('удаление', () => {
    const out = applied(TABLE.replace('созвон', 'соз¦вон'), removeRow);
    expect(out).not.toContain('созвон');
    expect(out).toContain('отчёт');
  });

  it('шапку удалить нельзя', () => {
    /* Без неё таблица распадается на строки с палками. */
    const model = tableAt(at(TABLE.replace('Дело', 'Де¦ло')));
    expect(removeRow(model as NonNullable<typeof model>)).toBeNull();
  });

  it('последнюю строку удалить нельзя', () => {
    const model = tableAt(at('| a¦ |'));
    expect(removeRow(model as NonNullable<typeof model>)).toBeNull();
  });
});

describe('столбцы', () => {
  it('вставка справа добавляет ячейку в каждую строку', () => {
    const out = applied(TABLE.replace('Дело', 'Де¦ло'), (model) => insertColumn(model, 'right'));
    for (const line of out.split('\n')) {
      expect((line.match(/\|/g) ?? []).length, line).toBe(4);
    }
  });

  it('вставка слева — перед тем столбцом, где курсор', () => {
    /* Курсор во второй колонке: пустая встаёт между «Дело» и «Срок». */
    const out = applied(TABLE.replace('Срок', 'Ср¦ок'), (model) => insertColumn(model, 'left'));
    expect(out.split('\n')[0]).toMatch(/^\|\s+Дело\s+\|\s+\|\s+Срок\s+\|$/);
  });

  it('удаление убирает ячейку во всех строках', () => {
    const out = applied(TABLE.replace('Срок', 'Ср¦ок'), removeColumn);
    expect(out).not.toContain('Срок');
    expect(out).not.toContain('пн');
    expect(out).toContain('созвон');
  });

  it('последний столбец удалить нельзя', () => {
    const model = tableAt(at('| a¦ |\n| - |'));
    expect(removeColumn(model as NonNullable<typeof model>)).toBeNull();
  });
});

describe('выравнивание', () => {
  it('по центру кодируется двоеточиями с двух сторон', () => {
    const out = applied(TABLE.replace('Срок', 'Ср¦ок'), (model) => alignColumn(model, 'center'));
    const divider = out.split('\n')[1] as string;
    expect(divider.split('|')[2]).toMatch(/^\s*:-+:\s*$/);
  });

  it('по правому краю — двоеточие справа', () => {
    const out = applied(TABLE.replace('Срок', 'Ср¦ок'), (model) => alignColumn(model, 'right'));
    expect((out.split('\n')[1] as string).split('|')[2]).toMatch(/^\s*-+:\s*$/);
  });

  it('выравнивание сохраняется при разборе обратно', () => {
    const out = applied(TABLE.replace('Срок', 'Ср¦ок'), (model) => alignColumn(model, 'center'));
    expect(tableAt(at(out.replace('Срок', 'Ср¦ок')))?.aligns[1]).toBe('center');
  });

  it('таблице без шапки выравнивание её добавляет', () => {
    /* Выравнивание кодирует именно строка-разделитель: без неё его негде
       хранить, и «применилось, но не сохранилось» было бы враньём. */
    const out = applied('| a¦ | b |\n| c | d |', (model) => alignColumn(model, 'right'));
    expect(out.split('\n')[1]).toMatch(/^\|\s*-+:?\s*\|/);
  });
});

describe('строка заголовка', () => {
  it('снимается и возвращается', () => {
    const without = applied(TABLE.replace('Дело', 'Де¦ло'), toggleHeader);
    expect(without.split('\n')).toHaveLength(3);
    expect(without.split('\n')[1]).toContain('созвон');
  });
});

describe('таблица остаётся ровной', () => {
  it('колонки выровнены по самой длинной ячейке', () => {
    const out = applied(TABLE.replace('созвон', 'соз¦вон'), (model) => insertRow(model, 'below'));
    const widths = out.split('\n').map((line) => line.length);
    expect(new Set(widths).size, `строки разной длины: ${widths.join(', ')}`).toBe(1);
  });

  it('кириллица считается по символам, а не по байтам', () => {
    /* Иначе русская ячейка получила бы вдвое больше места, чем занимает. */
    const out = renderTable({
      rows: [
        ['ключ', 'значение'],
        ['да', 'нет'],
      ],
      aligns: ['none', 'none'],
      header: true,
    });
    const widths = out.split('\n').map((line) => line.length);
    expect(new Set(widths).size).toBe(1);
  });

  it('разбор и сборка не меняют таблицу, которая уже ровная', () => {
    const model = tableAt(at(TABLE.replace('созвон', 'соз¦вон')));
    expect(renderTable(model as NonNullable<typeof model>)).toBe(TABLE);
  });
});

/**
 * Перестановка перетаскиванием и правка ячейки — то, ради чего заказчик
 * попросил виджет вместо меню. Само перетаскивание живёт в React-компоненте,
 * здесь — арифметика, которую он зовёт.
 */
describe('перестановка строк и столбцов', () => {
  it('строка встаёт на новое место', () => {
    const model = tableAt(at(TABLE.replace('созвон', 'соз¦вон')));
    const next = moveRow(model as NonNullable<typeof model>, 2, 1);
    expect(next?.rows.map((row) => row[0])).toEqual(['Дело', 'отчёт', 'созвон']);
  });

  it('шапку не уносят и на её место не кладут', () => {
    /* Иначе заголовком стали бы чужие данные: первая строка таблицы и есть
       заголовок, это разметка, а не порядок. */
    const model = tableAt(at(TABLE.replace('созвон', 'соз¦вон'))) as NonNullable<
      ReturnType<typeof tableAt>
    >;
    expect(moveRow(model, 0, 2)).toBeNull();
    expect(moveRow(model, 2, 0)).toBeNull();
  });

  it('столбец переезжает вместе со своим выравниванием', () => {
    const model = tableAt(at('| a¦ | b |\n| :-- | --: |\n| 1 | 2 |')) as NonNullable<
      ReturnType<typeof tableAt>
    >;
    const next = moveColumn(model, 0, 1);
    expect(next?.rows[0]).toEqual(['b', 'a']);
    expect(next?.aligns).toEqual(['right', 'left']);
  });

  it('перестановка в то же место ничего не делает', () => {
    const model = tableAt(at(TABLE.replace('созвон', 'соз¦вон'))) as NonNullable<
      ReturnType<typeof tableAt>
    >;
    expect(moveRow(model, 1, 1)).toBeNull();
    expect(moveColumn(model, 1, 1)).toBeNull();
  });
});

describe('правка ячейки', () => {
  it('текст ложится в свою ячейку и таблица остаётся ровной', () => {
    const model = tableAt(at(TABLE.replace('созвон', 'соз¦вон'))) as NonNullable<
      ReturnType<typeof tableAt>
    >;
    const out = renderTable(setCell(model, 1, 0, 'встреча у нотариуса'));
    expect(out).toContain('встреча у нотариуса');
    const widths = out.split('\n').map((line) => line.length);
    expect(new Set(widths).size, `строки разной длины: ${widths.join(', ')}`).toBe(1);
  });

  it('палка в тексте экранируется, а не рвёт строку на лишний столбец', () => {
    const model = tableAt(at(TABLE.replace('созвон', 'соз¦вон'))) as NonNullable<
      ReturnType<typeof tableAt>
    >;
    const out = renderTable(setCell(model, 1, 0, 'до | после'));
    const again = tableAt(at(out.replace('Дело', 'Де¦ло'))) as NonNullable<
      ReturnType<typeof tableAt>
    >;
    expect(again.rows[0]).toHaveLength(2);
    expect(again.rows[1]?.[0]).toBe('до \\| после');
  });

  it('пробелы по краям остаются в ячейке до записи в файл', () => {
    /* Обрезать их в модели значило бы съедать пробел ровно в тот момент,
       когда его набирают между словами. */
    const model = tableAt(at(TABLE.replace('созвон', 'соз¦вон'))) as NonNullable<
      ReturnType<typeof tableAt>
    >;
    expect(setCell(model, 1, 0, 'Бумага ').rows[1]?.[0]).toBe('Бумага ');
  });
});

/**
 * P1-аудит: обычный Enter внутри строки таблицы разрубал `| 1 | 2 |` пополам
 * — половина оставалась в таблице, вторая переставала начинаться с `|` и
 * выпадала из TABLE_ROW насовсем. Тихая потеря данных на ровном месте:
 * ни диалога, ни визуальной тревоги, автосохранение фиксирует урон. Здесь —
 * проверка через настоящий `EditorView`, а не только модель: дефект был
 * именно в маршруте нажатия клавиши, а не в разборе.
 */
describe('Enter внутри таблицы', () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  const DOC = '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\nхвост';

  it('посреди ячейки не разрубает строку — таблица остаётся одним блоком', () => {
    const pos = DOC.indexOf('1');
    view = makeView(DOC, { selection: { anchor: pos } });
    tableEnter(view);

    expect(view.state.doc.toString()).toBe(DOC);
    const model = tableAt(view.state, pos);
    expect(model).not.toBeNull();
    expect(model?.lastLine).toBe(4);
  });

  it('в конце НЕ последней строки таблицы тоже не разрывает таблицу надвое', () => {
    const pos = DOC.indexOf('| 1 | 2 |') + '| 1 | 2 |'.length;
    view = makeView(DOC, { selection: { anchor: pos } });
    tableEnter(view);

    expect(view.state.doc.toString()).toBe(DOC);
    const model = tableAt(view.state, pos);
    expect(model?.lastLine).toBe(4);
  });

  it('в конце ПОСЛЕДНЕЙ строки таблицы обычный Enter по-прежнему создаёт абзац после неё', () => {
    const pos = DOC.indexOf('| 3 | 4 |') + '| 3 | 4 |'.length;
    view = makeView(DOC, { selection: { anchor: pos } });
    const handled = tableEnter(view);

    // Не обработано ЭТОЙ командой — цепочка Enter доходит до обычного
    // перевода строки, который и добавляет абзац после таблицы.
    expect(handled).toBe(false);
  });

  it('вне таблицы не вмешивается', () => {
    view = makeView('Обычный абзац', { selection: { anchor: 5 } });
    expect(tableEnter(view)).toBe(false);
  });
});
