/**
 * Контраст палитры «Бумага · Гранат» во всех трёх темах.
 *
 * tz/ZAPISKI_TZ_1_Design.md §2 требует это прямым текстом: «Обязательная
 * проверка контраста: Гранат на „Бумаге“ и на „Чернилах“ — 4.5:1 для текста и
 * 3:1 для интерактивных границ», и §5 распространяет требование на все темы.
 * Проверяется четыре группы пар:
 *
 *   A. DoD ТЗ (порог 4.5:1, обычный текст)
 *      1. --text            на --bg
 *      2. --text            на --surface
 *      3. --text-secondary  на --bg
 *      4. --accent          на --bg
 *      5. --accent-on-soft  на --accent-soft
 *
 *   B. Текст статуса на своей подложке (порог 4.5:1) — §4 развёл «цвет
 *      статуса» и «текст статуса», значит пары `*-text` / `*-soft` обязаны
 *      проверяться отдельно: это ценник на paywall и текст ошибки.
 *
 *   C. Подпись на заливке главного действия (порог 4.5:1):
 *      --on-accent на --accent-fill. Заливка отделена от акцента-текста:
 *      однажды затемнённый ради 4.5:1 акцент не обязан утаскивать за собой
 *      кнопку.
 *
 *   D. Нетекстовые элементы (порог 3:1, WCAG 1.4.11) — индикаторы статуса на
 *      своих подложках и акцент как заливка/граница.
 *
 * Значения читаются из НАСТОЯЩИХ файлов: `src/styles/tokens.generated.css`
 * (собран из `design/tokens.json`) + производные из `src/styles/tokens.css`.
 *
 * Известные отклонения НЕ подгоняются молча: они перечислены в
 * KNOWN_DEVIATIONS с точными числами и разобраны в packages/ui/CONTRAST.md.
 * Тест падает и в том случае, если отклонение внезапно «исчезло»: значит,
 * значения поменяли и реестр пора перечитать.
 */
import { describe, expect, it } from 'vitest';
import {
  computeTokens,
  contrast,
  flatten,
  loadTokenRules,
  parseColor,
  resolveVar,
  round2,
  type Rule,
} from './tokens';

const THEMES = ['paper', 'graphite', 'ink'] as const;
const ACCENTS = ['garnet', 'blueberry', 'slate'] as const;
const AA = 4.5;
/** WCAG 1.4.11 — графические объекты и границы контролов. */
const NON_TEXT = 3;

/** Пары «текст на фоне», порог 4.5. */
const TEXT_PAIRS = [
  ['text/bg', '--text', '--bg'],
  ['text/surface', '--text', '--surface'],
  ['text-secondary/bg', '--text-secondary', '--bg'],
  ['accent/bg', '--accent', '--bg'],
  ['accent-on-soft/accent-soft', '--accent-on-soft', '--accent-soft'],
  ['success-text/success-soft', '--success-text', '--success-soft'],
  ['warning-text/warning-soft', '--warning-text', '--warning-soft'],
  ['danger-text/danger-soft', '--danger-text', '--danger-soft'],
  ['info-text/info-soft', '--info-text', '--info-soft'],
  ['on-accent/accent-fill', '--on-accent', '--accent-fill'],
] as const;

/** Пары «нетекстовый элемент на фоне», порог 3. */
const NON_TEXT_PAIRS = [
  ['success/success-soft', '--success', '--success-soft'],
  ['warning/warning-soft', '--warning', '--warning-soft'],
  ['danger/danger-soft', '--danger', '--danger-soft'],
  ['info/info-soft', '--info', '--info-soft'],
  ['accent-fill/bg', '--accent-fill', '--bg'],
] as const;

type PairId = (typeof TEXT_PAIRS)[number][0] | (typeof NON_TEXT_PAIRS)[number][0];

/**
 * Реестр принятых отклонений: тема · акцент · пара → измеренный контраст.
 * Источник правды для packages/ui/CONTRAST.md.
 */
const KNOWN_DEVIATIONS: Record<string, number> = {};

/* Реестр пуст, и это не «ещё не заполнили», а результат: на палитре
   «Бумага · Гранат» все девять сочетаний проходят оба порога. Прежние четыре
   отклонения были свойствами чужой палитры — форест и фирменное золото на
   кремовом, — и ушли вместе с ней. Если отклонение появится, оно пишется сюда
   числом и разбирается в packages/ui/CONTRAST.md; подгонять значения под
   порог, не назвав причину, нельзя. */

const rules: Rule[] = loadTokenRules();

function measure(theme: string, accent: string): Record<string, number> {
  const tokens = computeTokens(rules, {
    theme,
    accent,
    density: 'comfortable',
    typeface: 'sans',
  });
  const value = (name: string): string => resolveVar(tokens, name);
  const bg = parseColor(value('--bg'));
  /* Полупрозрачные soft-подложки тёмных тем складываем с фоном экрана. */
  const on = (name: string) => flatten(parseColor(value(name)), bg);

  const out: Record<string, number> = {};
  for (const [id, fg, back] of [...TEXT_PAIRS, ...NON_TEXT_PAIRS]) {
    out[id] = contrast(parseColor(value(fg)), on(back));
  }
  return out;
}

const combinations = THEMES.flatMap((theme) => ACCENTS.map((accent) => ({ theme, accent })));

function check(
  theme: string,
  accent: string,
  pair: PairId,
  ratio: number,
  threshold: number,
): void {
  const key = `${theme}/${accent}/${pair}`;
  const known = KNOWN_DEVIATIONS[key];

  if (known !== undefined) {
    /* Отклонение зафиксировано в CONTRAST.md — сверяем, что оно то же самое. */
    expect(
      round2(ratio),
      `Зафиксированное отклонение ${key} изменилось: было ${known}, стало ${round2(ratio)}. ` +
        'Обновите packages/ui/CONTRAST.md и KNOWN_DEVIATIONS.',
    ).toBeCloseTo(known, 1);
    expect(
      ratio,
      `${key} теперь проходит порог (${round2(ratio)}). Уберите его из KNOWN_DEVIATIONS и CONTRAST.md.`,
    ).toBeLessThan(threshold);
    return;
  }

  expect(
    round2(ratio),
    `${key} = ${round2(ratio)}:1 — ниже порога ${threshold}:1 и не описан в CONTRAST.md`,
  ).toBeGreaterThanOrEqual(threshold);
}

describe('контраст 9 сочетаний тема × акцент', () => {
  it('покрывает ровно 9 сочетаний', () => {
    expect(combinations).toHaveLength(9);
  });

  describe.each(combinations)('$theme × $accent', ({ theme, accent }) => {
    const measured = measure(theme, accent);

    it.each(TEXT_PAIRS.map(([id]) => id))('%s ≥ 4.5:1 (текст)', (pair) => {
      check(theme, accent, pair, measured[pair]!, AA);
    });

    it.each(NON_TEXT_PAIRS.map(([id]) => id))('%s ≥ 3:1 (нетекстовое)', (pair) => {
      check(theme, accent, pair, measured[pair]!, NON_TEXT);
    });
  });
});

describe('шкала текста — сторожевые значения', () => {
  /**
   * `--text-tertiary` / `--text-disabled` / `--text-ghost` порогом 4.5 не
   * гейтятся (метаданные, дублированные контекстом · неактивные контролы,
   * выведенные WCAG 1.4.3 · декор), но их значения сторожатся от случайной
   * правки. Числа — в CONTRAST.md.
   */
  const EXPECTED: Record<string, Record<string, number>> = {
    paper: { '--text-tertiary': 2.09, '--text-disabled': 1.71, '--text-ghost': 1.42 },
    graphite: { '--text-tertiary': 2.85, '--text-disabled': 1.99, '--text-ghost': 1.41 },
    ink: { '--text-tertiary': 3.21, '--text-disabled': 2.2, '--text-ghost': 1.57 },
  };

  it.each(THEMES)('%s: третичный, неактивный и призрачный не сдвинулись', (theme) => {
    const tokens = computeTokens(rules, { theme, accent: 'garnet' });
    const bg = parseColor(resolveVar(tokens, '--bg'));
    for (const [token, expected] of Object.entries(EXPECTED[theme]!)) {
      const ratio = round2(contrast(parseColor(resolveVar(tokens, token)), bg));
      expect(ratio, `${theme} ${token} = ${ratio}, ожидалось ${expected}`).toBeCloseTo(expected, 1);
    }
  });
});

describe('реестр отклонений не протух', () => {
  it('все ключи KNOWN_DEVIATIONS относятся к существующим сочетаниям', () => {
    const pairIds = new Set<string>([
      ...TEXT_PAIRS.map(([id]) => id),
      ...NON_TEXT_PAIRS.map(([id]) => id),
    ]);
    for (const key of Object.keys(KNOWN_DEVIATIONS)) {
      const [theme, accent, ...rest] = key.split('/');
      expect(THEMES).toContain(theme);
      expect(ACCENTS).toContain(accent);
      expect(pairIds).toContain(rest.join('/'));
    }
  });

  it('«Чернила» — OLED-чёрный из ТЗ', () => {
    const tokens = computeTokens(rules, { theme: 'ink', accent: 'garnet' });
    expect(resolveVar(tokens, '--bg').toUpperCase()).toBe('#000008');
  });

  it('«Бумага · Гранат» — ровно те значения, что в §2 мастер-ТЗ', () => {
    /* Без этой проверки все пороги выше можно было бы удовлетворить любой
       другой палитрой: контраст не знает, какого цвета продукт. */
    const tokens = computeTokens(rules, { theme: 'paper', accent: 'garnet' });
    expect(resolveVar(tokens, '--bg').toUpperCase()).toBe('#FBFAF7');
    expect(resolveVar(tokens, '--surface').toUpperCase()).toBe('#F3F1EA');
    expect(resolveVar(tokens, '--text').toUpperCase()).toBe('#38342E');
    expect(resolveVar(tokens, '--text-secondary').toUpperCase()).toBe('#726C60');
    expect(resolveVar(tokens, '--line').toUpperCase()).toBe('#EAE6DB');
    expect(resolveVar(tokens, '--accent').toUpperCase()).toBe('#B5503C');
  });

  it('акцент по умолчанию — гранат, даже когда data-accent не выставлен', () => {
    /* Первый кадр до гидратации рисуется без атрибутов: если бы правило
       `:root:not([data-accent])` потерялось, продукт стартовал бы бесцветным. */
    const tokens = computeTokens(rules, { theme: 'paper', accent: undefined as never });
    expect(resolveVar(tokens, '--accent').toUpperCase()).toBe('#B5503C');
  });

  it('гранат в тёмных темах осветляется, а не остаётся заливкой с «Бумаги»', () => {
    for (const theme of ['graphite', 'ink']) {
      const tokens = computeTokens(rules, { theme, accent: 'garnet' });
      expect(resolveVar(tokens, '--accent').toUpperCase()).toBe('#D0765B');
    }
  });

  it('таблица измерений (для отчёта)', () => {
    const table = combinations.map(({ theme, accent }) => {
      const measured = measure(theme, accent);
      return {
        theme,
        accent,
        ...Object.fromEntries(Object.entries(measured).map(([id, v]) => [id, round2(v)])),
      };
    });
    expect(table).toHaveLength(9);
    /* Печатается только при ZAPISKI_CONTRAST_TABLE=1; полный отчёт — в CONTRAST.md. */
    if (process.env['ZAPISKI_CONTRAST_TABLE']) console.table(table);
  });
});
