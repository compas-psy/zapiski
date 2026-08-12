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
import { describe, expect, it } from 'vitest';

import {
  alignColumn,
  insertColumn,
  insertRow,
  removeColumn,
  removeRow,
  renderTable,
  tableAt,
  toggleHeader,
} from '../src/commands/table.js';

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
