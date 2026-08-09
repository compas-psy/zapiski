#!/usr/bin/env node
/**
 * Генерация палитры печати для экспорта HTML/PDF/DOCX.
 *
 * Зачем это существует. Экспортный документ покидает приложение: он не может
 * ссылаться на рантайм-переменные темы, поэтому цвета в нём обязаны быть
 * литеральными. Но литералы, написанные руками, разъезжаются с токенами — так
 * и случилось: подсветка `==текст==` в экспорте была золотистой `#F3E7B8`,
 * хотя DESIGN_TOKENS §2 требует `--accent-soft`.
 *
 * Поэтому палитра не пишется, а выводится из `packages/ui/src/styles/tokens.css`
 * — из темы «Бумага» и акцента «Гранат» (BEHAVIOR §9: экспорт всегда в светлой
 * «Бумаге»; гранат — акцент по умолчанию, SCREENS «Базовая тема макетов»).
 *
 * Запуск: node scripts/gen-print-palette.mjs
 * Проверка синхронности: node scripts/gen-print-palette.mjs --check
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = resolve(ROOT, 'packages/ui/src/styles/tokens.css');
const TARGET = resolve(ROOT, 'packages/core/src/export/print-palette.ts');

/** Какие токены нужны печати и под какими именами они лягут в TS. */
const WANTED = {
  bg: '--bg',
  text: '--text',
  textSecondary: '--text-secondary',
  textTertiary: '--text-tertiary',
  surface: '--surface',
  line: '--line',
  accent: '--accent',
  accentSoft: '--accent-soft',
};

/**
 * Достаёт объявления из блока, чей селектор содержит все указанные подстроки.
 * Разбор намеренно примитивный: tokens.css — плоский файл объявлений, а
 * тащить в сборку полноценный парсер CSS ради восьми значений ни к чему.
 */
function block(css, needles, forbidden = []) {
  const out = {};
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    // В tokens.css селекторы записаны одинарными кавычками; сравниваем
    // без учёта вида кавычек, чтобы генератор не ломался от смены стиля.
    const selector = m[1].replace(/["']/g, '');
    if (!needles.every((n) => selector.includes(n))) continue;
    if (forbidden.some((n) => selector.includes(n))) continue;
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i === -1) continue;
      const prop = decl.slice(0, i).trim();
      const value = decl.slice(i + 1).trim();
      if (prop.startsWith('--')) out[prop] = value;
    }
  }
  return out;
}

// Комментарии убираем до разбора: объявления в tokens.css снабжены поясняющими
// `/* ... */`, а они стоят ПОСЛЕ точки с запятой и иначе приклеиваются к
// следующему объявлению, из-за чего оно молча теряется.
const css = readFileSync(TOKENS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Тема даёт поверхности и текст, акцент — интерактивные цвета.
const paper = block(css, ['[data-theme=paper]']);

// Светлый гранат объявлен безусловным блоком `[data-accent='garnet']`, а тёмный
// вариант — уточнённым через graphite/ink. Поэтому тёмные селекторы явно
// исключаем: иначе они перезаписали бы светлые значения полупрозрачными rgba,
// непригодными для печати.
const garnet = block(css, ['[data-accent=garnet]'], ['graphite', 'ink']);

const resolved = {};
for (const [key, token] of Object.entries(WANTED)) {
  const value = paper[token] ?? garnet[token];
  if (!value) {
    console.error(`gen-print-palette: в tokens.css не найден ${token}`);
    process.exit(1);
  }
  if (!/^#[0-9A-Fa-f]{6}$/.test(value)) {
    console.error(
      `gen-print-palette: ${token} = "${value}" — печати нужен литеральный ` +
        `#rrggbb, а не производное значение. Экспортный документ не может ` +
        `вычислять color-mix().`,
    );
    process.exit(1);
  }
  resolved[key] = value.toUpperCase();
}

const body = `/**
 * СГЕНЕРИРОВАННЫЙ ФАЙЛ — не редактировать руками.
 * Источник: packages/ui/src/styles/tokens.css (тема «Бумага», акцент «Гранат»).
 * Обновить: node scripts/gen-print-palette.mjs
 *
 * Палитра для экспорта в HTML/PDF/DOCX. Экспортный документ покидает
 * приложение и не может ссылаться на рантайм-токены темы, поэтому цвета здесь
 * литеральные. Чтобы они не разъезжались с дизайн-системой, файл выводится из
 * токенов, а тест export-palette.test.ts падает, если его забыли пересобрать.
 *
 * BEHAVIOR §9: экспорт всегда в светлой теме «Бумага», колонка 640,
 * без интерфейсных элементов.
 */

export const PRINT_PALETTE = {
${Object.entries(resolved)
  .map(([k, v]) => `  ${k}: '${v}',`)
  .join('\n')}
} as const;

/**
 * Семейства шрифтов для экспорта. Продуктовый шрифт указан первым: если он
 * установлен в системе, документ выглядит как в приложении; иначе работает
 * запасной стек. Встроить .woff2 в экспорт нельзя — файл должен оставаться
 * самодостаточным и лёгким.
 */
export const PRINT_FONTS = {
  serif: '"Source Serif 4", Georgia, "Iowan Old Style", serif',
  sans: '"Golos Text", "Segoe UI", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
} as const;
`;

if (process.argv.includes('--check')) {
  const current = readFileSync(TARGET, 'utf8');
  if (current !== body) {
    console.error(
      'gen-print-palette: print-palette.ts разошёлся с tokens.css.\n' +
        'Выполните: node scripts/gen-print-palette.mjs',
    );
    process.exit(1);
  }
  console.log('gen-print-palette: палитра печати синхронна с токенами.');
} else {
  writeFileSync(TARGET, body);
  console.log(`gen-print-palette: записан ${TARGET}`);
  for (const [k, v] of Object.entries(resolved)) console.log(`  ${k} = ${v}`);
}
