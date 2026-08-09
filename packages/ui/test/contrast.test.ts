/**
 * Контраст палитры СИМПАСА в наших темах.
 *
 * Проверяется четыре группы пар — состав пересмотрен под DS-ALIGNMENT §4 и §11,
 * а не перенесён со старой палитры:
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
 *      --on-accent на --accent-fill. Появилась из-за «Золота»: фирменное
 *      #CC9E50 заливает, но подписывается тёмным форест-ink, а не белым.
 *
 *   D. Нетекстовые элементы (порог 3:1, WCAG 1.4.11) — индикаторы статуса на
 *      своих подложках и акцент как заливка/граница.
 *
 * Значения читаются из НАСТОЯЩИХ файлов: снимок дизайн-системы
 * (`src/styles/simpas/vendor/tokens/*.css`) + наш `src/styles/tokens.css`.
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

const THEMES = ['simpas', 'graphite', 'ink'] as const;
const ACCENTS = ['pine', 'forest', 'gold', 'dusk', 'granite', 'clay'] as const;
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
 * Источник правды для packages/ui/CONTRAST.md. Список перечитан заново
 * 2026-08-09 под палитру СИМПАСА — старый (пустой, от палитры «Бумаги») не
 * переносился: у новой палитры отклонения другие и их причины другие.
 *
 * Все четыре — значения САМОЙ дизайн-системы, менять их односторонне нельзя
 * (DS-ALIGNMENT §3 и §5 задают их дословно). Подгонять числа запрещено; они
 * вынесены владельцу системы вместе с правкой про золото.
 */
const KNOWN_DEVIATIONS: Record<string, number> = {
  /* «Лес» #3B8F5A на кремовом. Тот же зелёный, что --success-500 и знак ШАГОВ. */
  'simpas/forest/accent/bg': 3.74,
  'simpas/forest/on-accent/accent-fill': 3.99,
  /* «Глина» #A47864 (= --svc-svoi-bg) на кремовом. */
  'simpas/clay/accent/bg': 3.61,
  'simpas/clay/on-accent/accent-fill': 3.85,
  /* §5 предписывает осветлять «Хвою» в тёмных темах ровно до --forest-500. */
  'graphite/pine/accent/bg': 4.44,
  /* Фирменное золото как индикатор на своей же подложке. Обе величины —
     из снимка (--gold-500 / --amber-soft), это заливка бейджа, не текст. */
  'simpas/pine/warning/warning-soft': 2.22,
  'simpas/forest/warning/warning-soft': 2.22,
  'simpas/gold/warning/warning-soft': 2.22,
  'simpas/dusk/warning/warning-soft': 2.22,
  'simpas/granite/warning/warning-soft': 2.22,
  'simpas/clay/warning/warning-soft': 2.22,
};

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

describe('контраст 18 сочетаний тема × акцент', () => {
  it('покрывает ровно 18 сочетаний', () => {
    expect(combinations).toHaveLength(18);
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
    simpas: { '--text-tertiary': 3.37, '--text-disabled': 2.17, '--text-ghost': 1.56 },
    graphite: { '--text-tertiary': 4.51, '--text-disabled': 2.81, '--text-ghost': 1.84 },
    ink: { '--text-tertiary': 4.71, '--text-disabled': 2.91, '--text-ghost': 1.89 },
  };

  it.each(THEMES)('%s: третичный, неактивный и призрачный не сдвинулись', (theme) => {
    const tokens = computeTokens(rules, { theme, accent: 'pine' });
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

  it('«Чернила» — истинный чёрный', () => {
    const tokens = computeTokens(rules, { theme: 'ink', accent: 'pine' });
    expect(resolveVar(tokens, '--bg').toUpperCase()).toBe('#000000');
  });

  it('«Хвоя» по умолчанию — форест дизайн-системы', () => {
    const tokens = computeTokens(rules, { theme: 'simpas', accent: 'pine' });
    expect(resolveVar(tokens, '--accent').toUpperCase()).toBe('#1D4735');
    expect(resolveVar(tokens, '--bg').toUpperCase()).toBe('#F7F8F4');
  });

  it('золото заливает фирменным тоном, а подписывается тёмным', () => {
    const tokens = computeTokens(rules, { theme: 'simpas', accent: 'gold' });
    /* Фирменное золото — только заливка (§3, сноска ¹). */
    expect(resolveVar(tokens, '--accent-fill').toUpperCase()).toBe('#CC9E50');
    /* Как текст оно не используется: текстовая роль затемнена. */
    expect(resolveVar(tokens, '--accent').toUpperCase()).toBe('#8F6B26');
    expect(resolveVar(tokens, '--on-accent').toUpperCase()).toBe('#143D2F');
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
    expect(table).toHaveLength(18);
    /* Печатается только при ZAPISKI_CONTRAST_TABLE=1; полный отчёт — в CONTRAST.md. */
    if (process.env['ZAPISKI_CONTRAST_TABLE']) console.table(table);
  });
});
