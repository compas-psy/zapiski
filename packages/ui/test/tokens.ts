/**
 * Мини-движок каскада для tokens.css: разбирает НАСТОЯЩИЙ файл токенов и
 * вычисляет значения переменных для конкретной пары тема × акцент.
 *
 * Тесты обязаны проверять то, что реально уедет в сборку, а не копию значений
 * в TypeScript, — иначе проверка контраста измеряет саму себя.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const TOKENS_PATH = resolve(here, '../src/styles/tokens.css');

export interface Rule {
  selectors: string[];
  declarations: Record<string, string>;
  order: number;
}

/** Атрибуты, которые ThemeProvider ставит на корень. */
export interface RootState {
  theme: string;
  accent: string;
  density?: string;
  typeface?: string;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Блоки @media/@supports для токенов цвета не используются — вырезаем целиком. */
function stripAtBlocks(css: string): string {
  let out = '';
  let index = 0;
  while (index < css.length) {
    const at = css.indexOf('@', index);
    if (at === -1) {
      out += css.slice(index);
      break;
    }
    const brace = css.indexOf('{', at);
    const semi = css.indexOf(';', at);
    if (brace === -1 || (semi !== -1 && semi < brace)) {
      out += css.slice(index, semi === -1 ? css.length : semi + 1);
      index = semi === -1 ? css.length : semi + 1;
      continue;
    }
    out += css.slice(index, at);
    let depth = 0;
    let cursor = brace;
    for (; cursor < css.length; cursor += 1) {
      if (css[cursor] === '{') depth += 1;
      else if (css[cursor] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    index = cursor + 1;
  }
  return out;
}

export function parseRules(css: string): Rule[] {
  const clean = stripAtBlocks(stripComments(css));
  const rules: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  let order = 0;
  while ((match = re.exec(clean)) !== null) {
    const selectors = match[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const declarations: Record<string, string> = {};
    for (const chunk of match[2]!.split(';')) {
      const colon = chunk.indexOf(':');
      if (colon === -1) continue;
      const name = chunk.slice(0, colon).trim();
      const value = chunk.slice(colon + 1).trim();
      if (name) declarations[name] = value;
    }
    rules.push({ selectors, declarations, order: order++ });
  }
  return rules;
}

/**
 * Совпадает ли компаунд-селектор с корневым элементом.
 * Поддерживаются :root, [data-x='v'], [data-x], :not([data-x]).
 * Селекторы с потомком (пробел) корню не адресованы — пропускаем.
 */
function matchSelector(selector: string, state: RootState): number | null {
  if (/\s/.test(selector.replace(/\s*,\s*/g, ','))) return null;
  const attributes: Record<string, string | undefined> = {
    'data-theme': state.theme,
    'data-accent': state.accent,
    'data-density': state.density,
    'data-typeface': state.typeface,
  };

  let specificity = 0;
  let rest = selector;
  while (rest.length > 0) {
    if (rest.startsWith(':root')) {
      specificity += 1;
      rest = rest.slice(':root'.length);
      continue;
    }
    const notMatch = /^:not\(\[([a-z-]+)(?:=(?:'|")([^'"]*)(?:'|"))?\]\)/.exec(rest);
    if (notMatch) {
      const name = notMatch[1]!;
      const expected = notMatch[2];
      const actual = attributes[name];
      const present = expected === undefined ? actual !== undefined : actual === expected;
      if (present) return null;
      specificity += 1;
      rest = rest.slice(notMatch[0].length);
      continue;
    }
    const attrMatch = /^\[([a-z-]+)(?:=(?:'|")([^'"]*)(?:'|"))?\]/.exec(rest);
    if (attrMatch) {
      const name = attrMatch[1]!;
      const expected = attrMatch[2];
      const actual = attributes[name];
      if (expected === undefined ? actual === undefined : actual !== expected) return null;
      specificity += 1;
      rest = rest.slice(attrMatch[0].length);
      continue;
    }
    /* Что-то незнакомое (класс, тег, псевдоэлемент) — к корню не относится. */
    return null;
  }
  return specificity;
}

/** Каскад: сортировка по (специфичность, порядок), последнее выигрывает. */
export function computeTokens(rules: Rule[], state: RootState): Record<string, string> {
  const applied: { specificity: number; order: number; declarations: Record<string, string> }[] = [];
  for (const rule of rules) {
    let best: number | null = null;
    for (const selector of rule.selectors) {
      const specificity = matchSelector(selector, state);
      if (specificity !== null && (best === null || specificity > best)) best = specificity;
    }
    if (best !== null) {
      applied.push({ specificity: best, order: rule.order, declarations: rule.declarations });
    }
  }
  applied.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  const out: Record<string, string> = {};
  for (const item of applied) Object.assign(out, item.declarations);
  return out;
}

/** Разворачивает цепочки var(--a) до литерала. */
export function resolveVar(tokens: Record<string, string>, name: string, depth = 0): string {
  if (depth > 12) throw new Error(`Циклическая ссылка в токене ${name}`);
  const raw = tokens[name];
  if (raw === undefined) throw new Error(`Токен ${name} не найден`);
  const direct = /^var\((--[a-z0-9-]+)\)$/i.exec(raw.trim());
  if (direct) return resolveVar(tokens, direct[1]!, depth + 1);
  return raw.trim();
}

export function loadTokenRules(): Rule[] {
  return parseRules(readFileSync(TOKENS_PATH, 'utf8'));
}

/* ── Цвет ────────────────────────────────────────────────────────────────── */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(value: string): Rgba {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length === 3) digits = digits.split('').map((c) => c + c).join('');
    if (digits.length === 6) digits += 'ff';
    if (digits.length !== 8) throw new Error(`Неизвестный hex: ${value}`);
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: parseInt(digits.slice(6, 8), 16) / 255,
    };
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (fn) {
    const parts = fn[1]!.split(/[,/]/).map((p) => p.trim());
    const [r, g, b, a] = parts;
    return {
      r: Number(r),
      g: Number(g),
      b: Number(b),
      a: a === undefined ? 1 : Number(a),
    };
  }
  throw new Error(`Не умею разбирать цвет: ${value}`);
}

/** Наложение полупрозрачного цвета на непрозрачный фон. */
export function flatten(color: Rgba, background: Rgba): Rgba {
  if (color.a >= 1) return color;
  return {
    r: color.r * color.a + background.r * (1 - color.a),
    g: color.g * color.a + background.g * (1 - color.a),
    b: color.b * color.a + background.b * (1 - color.a),
    a: 1,
  };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function luminance(color: Rgba): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** Коэффициент контраста по WCAG 2.1. */
export function contrast(foreground: Rgba, background: Rgba): number {
  const l1 = luminance(foreground);
  const l2 = luminance(background);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export const round2 = (value: number): number => Math.round(value * 100) / 100;
