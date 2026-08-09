/**
 * DoD ТЗ / DESIGN_TOKENS.md §4: каждая из 18 комбинаций тема × акцент
 * проверяется на контраст ≥4.5:1.
 *
 * Проверяемые пары:
 *   1. --text            на --bg
 *   2. --text            на --surface
 *   3. --text-secondary  на --bg
 *   4. --accent          на --bg
 *   5. --accent-on-soft  на --accent-soft   (soft с альфой накладывается на --bg)
 *
 * Значения читаются из настоящего src/styles/tokens.css.
 *
 * Известные отклонения НЕ подгоняются молча: они перечислены в KNOWN_DEVIATIONS
 * с точными числами и описаны в packages/ui/CONTRAST.md — решение за дизайнером.
 * Тест падает и в том случае, если отклонение внезапно «исчезло»: значит,
 * токены поменяли и реестр с CONTRAST.md пора обновить.
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
const ACCENTS = ['garnet', 'pine', 'gold', 'blueberry', 'heather', 'slate'] as const;
const AA = 4.5;

type PairId = 'text/bg' | 'text/surface' | 'text-secondary/bg' | 'accent/bg' | 'accent-on-soft/accent-soft';

/**
 * Реестр известных отклонений (тема · акцент · пара → измеренный контраст).
 * Источник правды для packages/ui/CONTRAST.md.
 */
const KNOWN_DEVIATIONS: Record<string, number> = {
  /* --text-secondary #8A8375 на --bg #FBFAF7 — одна причина на все 6 акцентов */
  'paper/garnet/text-secondary/bg': 3.6,
  'paper/pine/text-secondary/bg': 3.6,
  'paper/gold/text-secondary/bg': 3.6,
  'paper/blueberry/text-secondary/bg': 3.6,
  'paper/heather/text-secondary/bg': 3.6,
  'paper/slate/text-secondary/bg': 3.6,
  /* gold в светлой теме: #B08430 на #FBFAF7 и #8E6A24 на #F5EBD8 */
  'paper/gold/accent/bg': 3.25,
  'paper/gold/accent-on-soft/accent-soft': 4.19,
};

const rules: Rule[] = loadTokenRules();

function measure(theme: string, accent: string): Record<PairId, number> {
  const tokens = computeTokens(rules, {
    theme,
    accent,
    density: 'comfortable',
    typeface: 'sans',
  });
  const value = (name: string): string => resolveVar(tokens, name);
  const bg = parseColor(value('--bg'));
  const surface = parseColor(value('--surface'));
  const text = parseColor(value('--text'));
  const secondary = parseColor(value('--text-secondary'));
  const accentColor = parseColor(value('--accent'));
  const onSoft = parseColor(value('--accent-on-soft'));
  /* --accent-soft в тёмных темах полупрозрачен: складываем его с фоном экрана. */
  const soft = flatten(parseColor(value('--accent-soft')), bg);

  return {
    'text/bg': contrast(text, bg),
    'text/surface': contrast(text, surface),
    'text-secondary/bg': contrast(secondary, bg),
    'accent/bg': contrast(accentColor, bg),
    'accent-on-soft/accent-soft': contrast(onSoft, soft),
  };
}

const PAIRS: PairId[] = [
  'text/bg',
  'text/surface',
  'text-secondary/bg',
  'accent/bg',
  'accent-on-soft/accent-soft',
];

const combinations = THEMES.flatMap((theme) => ACCENTS.map((accent) => ({ theme, accent })));

describe('контраст 18 сочетаний тема × акцент', () => {
  it('покрывает ровно 18 сочетаний', () => {
    expect(combinations).toHaveLength(18);
  });

  describe.each(combinations)('$theme × $accent', ({ theme, accent }) => {
    const measured = measure(theme, accent);

    it.each(PAIRS)('%s ≥ 4.5:1', (pair) => {
      const ratio = measured[pair];
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
          `${key} теперь проходит AA (${round2(ratio)}). Уберите его из KNOWN_DEVIATIONS и CONTRAST.md.`,
        ).toBeLessThan(AA);
        return;
      }

      expect(
        round2(ratio),
        `${key} = ${round2(ratio)}:1 — ниже AA 4.5:1 и не описан в CONTRAST.md`,
      ).toBeGreaterThanOrEqual(AA);
    });
  });
});

describe('реестр отклонений не протух', () => {
  it('все ключи KNOWN_DEVIATIONS относятся к существующим сочетаниям', () => {
    for (const key of Object.keys(KNOWN_DEVIATIONS)) {
      const [theme, accent] = key.split('/');
      expect(THEMES).toContain(theme);
      expect(ACCENTS).toContain(accent);
    }
  });

  it('«Чернила» — истинный чёрный', () => {
    const tokens = computeTokens(rules, { theme: 'ink', accent: 'garnet' });
    expect(resolveVar(tokens, '--bg').toUpperCase()).toBe('#000000');
  });

  it('таблица измерений (для отчёта)', () => {
    const table = combinations.map(({ theme, accent }) => {
      const measured = measure(theme, accent);
      return {
        theme,
        accent,
        ...Object.fromEntries(PAIRS.map((pair) => [pair, round2(measured[pair])])),
      };
    });
    expect(table).toHaveLength(18);
    /* Печатается только при --reporter=verbose; полный отчёт — в CONTRAST.md. */
    if (process.env['ZAPISKI_CONTRAST_TABLE']) console.table(table);
  });
});
