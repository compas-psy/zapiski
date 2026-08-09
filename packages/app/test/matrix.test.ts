/**
 * Матрица «экран × состояние» — BEHAVIOR §12 и приёмочный критерий №10.
 *
 * Тест читает саму спецификацию: таблица §12 разбирается из
 * `docs/spec/BEHAVIOR.md` и сравнивается с `MATRIX`. Если ТЗ поменяется,
 * упадёт этот тест, а не приёмка.
 */
import { describe, expect, it } from 'vitest';
import SPEC from '../../../docs/spec/BEHAVIOR.md?raw';
import { MATRIX, type MatrixScreen } from '../src/state/store.js';
import type { ScreenState } from '../src/contract.js';

/** Порядок строк таблицы §12 = порядок ключей `MATRIX`. */
const ROW_ORDER: MatrixScreen[] = [
  'list',
  'folder',
  'note',
  'search',
  'library',
  'archive',
  'trash',
  'settingsSync',
  'backlinks',
];

const COLUMNS: Array<Exclude<ScreenState, 'normal'>> = [
  'empty',
  'loading',
  'offline',
  'error',
  'locked',
];

function parseSpecMatrix(): Array<boolean[]> {
  const section = SPEC.slice(SPEC.indexOf('## 12.'));
  const rows = section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    /* Отбрасываем шапку и разделитель. */
    .filter((cells) => cells.length === 6 && !cells[0]?.startsWith('---') && cells[0] !== 'Экран');
  /* Прочерк «—» = ячейки нет; любой другой текст = ячейка заполнена. */
  return rows.map((cells) => cells.slice(1).map((cell) => cell !== '—' && cell !== ''));
}

describe('матрица BEHAVIOR §12', () => {
  const spec = parseSpecMatrix();

  it('в спецификации ровно девять экранов', () => {
    expect(spec).toHaveLength(ROW_ORDER.length);
    expect(Object.keys(MATRIX)).toEqual(ROW_ORDER);
  });

  it('совпадает с таблицей ТЗ ячейка в ячейку', () => {
    ROW_ORDER.forEach((screen, index) => {
      const specRow = spec[index];
      expect(specRow, `нет строки для ${screen}`).toBeDefined();
      COLUMNS.forEach((state, column) => {
        expect(
          MATRIX[screen][state],
          `${screen} × ${state} расходится с BEHAVIOR §12`,
        ).toBe(specRow?.[column]);
      });
    });
  });

  it('backlinks: заполнено только «пустое» — панель просто скрыта', () => {
    expect(MATRIX.backlinks).toEqual({
      empty: true,
      loading: false,
      offline: false,
      error: false,
      locked: false,
    });
  });
});
