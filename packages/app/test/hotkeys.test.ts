/**
 * Приёмочный критерий §13.8: «Все хоткеи из §7 работают и отражены в палитре
 * команд».
 *
 * Список сочетаний тест берёт ИЗ САМОГО ТЗ — парсит таблицу §7 в
 * `docs/spec/BEHAVIOR.md`. Это принципиально: если переписать список сюда
 * руками, он разойдётся с документом при первой же правке спецификации, и
 * сторож будет охранять мой пересказ вместо требования.
 *
 * Проверяется, что сочетание объявлено в одном из двух реестров:
 *   • `editorCommands` (`@zapiski/editor`) — команды текста;
 *   • `SHELL_HOTKEYS` (`CommandPalette.tsx`) — команды оболочки.
 * Палитра строит свой список из этих же двух источников, без копий, поэтому
 * «объявлено» и «отражено в палитре» здесь — одно и то же.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editorCommands } from '@zapiski/editor';
import { describe, expect, it } from 'vitest';
import { displayHotkey, SHELL_HOTKEYS } from '../src/screens/CommandPalette.js';

const SPEC = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'spec',
  'BEHAVIOR.md',
);

/** Приводим запись сочетания к одному виду: `ctrl+shift+s`. */
function normalize(combo: string): string {
  return combo.trim().replace(/\\\\/g, '\\').replace(/\s+/g, '').toLowerCase();
}

/**
 * Раскрытие сокращений, которыми таблица пользуется ради краткости:
 *   `Ctrl+1…6`  → шесть сочетаний;
 *   `Alt+↑/↓`   → `Alt+↑` и `Alt+↓` (модификатор общий, слэш только у клавиши);
 *   `Ctrl+K / Ctrl+P` → два независимых сочетания.
 */
function expand(cell: string): string[] {
  /*
   * Порядок важен: сперва «или», потом диапазоны.
   *
   * В ячейке может стоять и то и другое разом — «Ctrl+1…6 / Ctrl+Shift+1…6»:
   * первое сочетание привычное, второе живёт ради браузера, который первое
   * забирает себе. Пока диапазон разбирался до слэша, такая ячейка не
   * разбиралась вовсе и сторож ронял всю таблицу.
   */
  const parts = cell
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  const first = parts[0] ?? '';
  const prefix = first.slice(0, first.lastIndexOf('+') + 1);

  const out: string[] = [];
  for (const [index, part] of parts.entries()) {
    /* Если у продолжения нет своего модификатора — он общий с первым. */
    const whole = index === 0 || part.includes('+') ? part : prefix + part;
    const range = /^(.*?)\+(\d)…(\d)$/.exec(whole);
    if (!range) {
      out.push(whole);
      continue;
    }
    const [, head, from, to] = range;
    for (let n = Number(from); n <= Number(to); n += 1) out.push(`${head}+${n}`);
  }
  return out;
}

/**
 * Сочетания из таблицы §7. Строки вида `| Ctrl+K / Ctrl+P | Палитра команд |`;
 * слэш означает «или», такие записи разбиваются на отдельные сочетания.
 */
function specHotkeys(): Array<{ combo: string; what: string }> {
  const text = readFileSync(SPEC, 'utf8');
  const from = text.indexOf('## 7.');
  const to = text.indexOf('### Палитра команд', from);
  const out: Array<{ combo: string; what: string }> = [];
  for (const line of text.slice(from, to).split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const [, combo, what] = cells;
    /* Шапка таблицы и разделитель — не сочетания. */
    if (!combo || !what || combo === 'Хоткей' || combo === 'Сочетание') continue;
    if (/^-+$/.test(combo)) continue;
    /* Глобальный хоткей записан прозой: «Глобальный (настраиваемый, по
       умолч. Ctrl+Alt+N)». Достаём из неё само сочетание. */
    const inline = /Ctrl\+[^)\s]+/.exec(combo);
    const source = combo.includes('Глобальный') ? (inline?.[0] ?? '') : combo;
    for (const value of expand(source)) out.push({ combo: value, what });
  }
  return out;
}

/** Всё, что объявлено в двух реестрах приложения. */
function declared(): Set<string> {
  const set = new Set<string>();
  for (const command of editorCommands) set.add(normalize(displayHotkey(command.key)));
  /* Реестр оболочки пишет альтернативы так же, как таблица: `Ctrl+K / Ctrl+P`.
     Раскрываем тем же кодом, что и спецификацию, — иначе сравнивались бы
     разные записи одного и того же. */
  for (const combo of Object.values(SHELL_HOTKEYS)) {
    for (const value of expand(combo)) set.add(normalize(value));
  }
  /* Esc обрабатывается каждым оверлеем у себя (BEHAVIOR §0: «Esc — закрыть»),
     общего реестра у него нет и быть не должно: закрывать надо ВЕРХНИЙ слой. */
  set.add('esc');
  return set;
}

/**
 * Сочетания, которых в таблице §7 нет, но которые допустимы.
 *
 * `Ctrl+Shift+V` описан в BEHAVIOR §2.1 прозой: «Ctrl+Shift+V — вставить без
 * форматирования». В таблицу его не внесли, но требование есть.
 *
 * `Ctrl+Shift+X` — зачёркивание. В ТЗ его нет НИГДЕ: §5.1 README перечисляет
 * зачёркнутый среди элементов разметки, но сочетания не называет. Это
 * добавление сверх спецификации. Оставлено сознательно: команда видна в
 * палитре наравне с остальными, то есть не является скрытым поведением, а
 * тулбар без неё заставлял бы набирать `~~` руками. Если заказчик решит
 * иначе — строка удаляется вместе с командой из `editorCommands`.
 *
 * `Ctrl+Shift+U` — подчёркивание. Той же природы, что и предыдущее: заказчик
 * попросил кнопку («нет кнопок зачёркнутый, подчёркнутый и италик»), а
 * сочетания в ТЗ нет. Привычное по Word `Ctrl+U` в этом продукте занято
 * подсветкой — BEHAVIOR §7 решал так, когда подчёркивания у нас не было
 * вовсе. Менять чужое сочетание молча нельзя: у человека уже могла сложиться
 * привычка. Поэтому подчёркивание получило своё, а перестановка `Ctrl+U` →
 * подчёркивание (и подсветка на `Ctrl+Shift+H`) ждёт слова заказчика.
 */
const BEYOND_TABLE = new Set(['ctrl+shift+v', 'ctrl+shift+x', 'ctrl+shift+u']);

describe('§13.8 — хоткеи из ТЗ объявлены и попадают в палитру', () => {
  it('таблица §7 читается из спецификации, а не переписана в тест', () => {
    const rows = specHotkeys();
    // Если разбор сломается, тест обязан упасть, а не молча пройти на пустом.
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.map((r) => r.combo)).toContain('Ctrl+B');
  });

  it('каждое сочетание из §7 объявлено в реестрах', () => {
    const known = declared();
    const missing = specHotkeys().filter((row) => !known.has(normalize(row.combo)));
    expect(
      missing.map((row) => `${row.combo} — ${row.what}`),
      'сочетания из ТЗ, которых нет ни в editorCommands, ни в SHELL_HOTKEYS',
    ).toEqual([]);
  });

  it('в реестрах нет сочетаний, которых нет в ТЗ', () => {
    /* Обратная сторона того же критерия: лишний хоткей — это поведение,
       которого не обещали, и его не будет ни в одной подсказке. */
    const inSpec = new Set(specHotkeys().map((row) => normalize(row.combo)));
    const extra = [...declared()].filter(
      (combo) => combo !== 'esc' && !inSpec.has(combo) && !BEYOND_TABLE.has(combo),
    );
    expect(extra, 'сочетания в коде, которых нет в таблице §7').toEqual([]);
  });
});
