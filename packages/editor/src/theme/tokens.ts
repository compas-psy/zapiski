/**
 * Имена CSS-переменных, которые редактор читает.
 *
 * Правило репозитория (ARCHITECTURE §3.4, DESIGN_TOKENS §4): в компонентах нет
 * ни одного hex — только `var(--*)`. Значения переменных определяет
 * `packages/ui`; редактор их только потребляет и для каждой держит
 * безопасный fallback на уже существующий токен, чтобы текст оставался
 * читаемым даже до того, как палитра подсветки кода будет добавлена.
 */

/** Токены поверхности и текста (DESIGN_TOKENS §1) — обязаны быть у `ui`. */
export const REQUIRED_SURFACE_TOKENS = [
  '--bg',
  '--surface',
  '--surface-alt',
  '--line',
  '--line-soft',
  '--text',
  '--text-secondary',
  '--text-tertiary',
  '--text-disabled',
  '--accent',
  '--accent-soft',
  '--accent-on-soft',
] as const;

/**
 * Пастельная палитра подсветки кода (DESIGN_TOKENS §1, «Подсветка кода»).
 * Переключается вместе с темой, потому что это обычные CSS-переменные.
 */
export const REQUIRED_CODE_TOKENS = [
  '--code-keyword',
  '--code-string',
  '--code-number',
  '--code-comment',
  '--code-function',
] as const;

/** Семейства шрифтов (DESIGN_TOKENS §2). */
export const REQUIRED_FONT_TOKENS = ['--font-sans', '--font-serif', '--font-mono'] as const;

/** `var(--code-keyword, …)` и т.п. — с деградацией на существующие токены. */
export const codeColor = {
  keyword: 'var(--code-keyword, var(--accent))',
  string: 'var(--code-string, var(--text-secondary))',
  number: 'var(--code-number, var(--text-secondary))',
  comment: 'var(--code-comment, var(--text-tertiary))',
  function: 'var(--code-function, var(--accent-on-soft, var(--accent)))',
} as const;

export const fontFamily = {
  sans: 'var(--font-sans, "Golos Text", system-ui, sans-serif)',
  serif: 'var(--font-serif, "Source Serif 4", Georgia, serif)',
  mono: 'var(--font-mono, "JetBrains Mono", ui-monospace, monospace)',
} as const;
