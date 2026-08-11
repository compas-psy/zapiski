#!/usr/bin/env node
/**
 * Генерация палитры печати для экспорта HTML/PDF/DOCX.
 *
 * Зачем это существует. Экспортный документ покидает приложение: он не может
 * ссылаться на рантайм-переменные темы, поэтому цвета в нём обязаны быть
 * литеральными. Но литералы, написанные руками, разъезжаются с токенами — так
 * и случилось: подсветка `==текст==` в экспорте была золотистой `#F3E7B8`,
 * хотя спецификация требует `--accent-soft`.
 *
 * Поэтому палитра не пишется, а выводится из токенов — из светлой темы
 * «Бумага» и базового акцента «Гранат»: BEHAVIOR §9 требует экспортировать
 * всегда в светлой теме, tz/ZAPISKI_TZ_1_Design.md §1 задаёт, какая она.
 *
 * Источник — `tokens.generated.css`, собранный из `design/tokens.json`. Там же
 * лежат и литералы: слоя чужой дизайн-системы под ними больше нет, поэтому
 * разворачивать `var(--…)` приходится только внутри наших собственных
 * алиасов.
 *
 * Запуск: node scripts/gen-print-palette.mjs
 * Проверка синхронности: node scripts/gen-print-palette.mjs --check
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STYLES = resolve(ROOT, 'packages/ui/src/styles');
const TOKENS = resolve(STYLES, 'tokens.generated.css');
/** Производные (алиасы вроде `--code-bg: var(--surface)`) — в соседнем файле. */
const DERIVED = resolve(STYLES, 'tokens.css');
const TARGET = resolve(ROOT, 'packages/core/src/export/print-palette.ts');

/** Тема и акцент, в которых печатает экспорт (BEHAVIOR §9, tz/1_Design §1). */
const PRINT_THEME = 'paper';
const PRINT_ACCENT = 'garnet';

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
 * Разбор намеренно примитивный: файлы токенов — плоские наборы объявлений, а
 * тащить в сборку полноценный парсер CSS ради восьми значений ни к чему.
 */
function block(css, needles, forbidden = []) {
  const out = {};
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    // Селекторы записаны одинарными кавычками; сравниваем без учёта вида
    // кавычек, чтобы генератор не ломался от смены стиля.
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

// Комментарии убираем до разбора: объявления снабжены поясняющими `/* ... */`,
// а они стоят ПОСЛЕ точки с запятой и иначе приклеиваются к следующему
// объявлению, из-за чего оно молча теряется.
const strip = (path) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const tokensCss = strip(TOKENS) + '\n' + strip(DERIVED);

/** Не зависящее от темы — типографика, отступы, знак сервиса. */
const system = block(tokensCss, [':root'], ['data-theme', 'data-accent', 'data-density', 'data-typeface']);
/** Тема даёт поверхности и текст, акцент — интерактивные цвета. */
const theme = block(tokensCss, [`[data-theme=${PRINT_THEME}]`]);
// Светлый акцент объявлен безусловным блоком `[data-accent='garnet']`, а тёмный
// вариант — уточнённым через graphite/ink. Тёмные селекторы явно исключаем:
// иначе они перезаписали бы светлые значения полупрозрачными rgba,
// непригодными для печати.
const accent = block(tokensCss, [`[data-accent=${PRINT_ACCENT}]`], ['graphite', 'ink']);

const scope = { ...system, ...theme, ...accent };

/** Разворачивает цепочку `var(--a)` → `var(--b)` → `#rrggbb`. */
function literal(token, depth = 0) {
  if (depth > 12) {
    console.error(`gen-print-palette: циклическая ссылка в ${token}`);
    process.exit(1);
  }
  const raw = scope[token];
  if (raw === undefined) return undefined;
  const link = /^var\((--[\w-]+)\)$/.exec(raw.trim());
  return link ? literal(link[1], depth + 1) : raw.trim();
}

const resolved = {};
for (const [key, token] of Object.entries(WANTED)) {
  const value = literal(token);
  if (!value) {
    console.error(`gen-print-palette: не найден ${token} (тема ${PRINT_THEME}, акцент ${PRINT_ACCENT})`);
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
 * Источник: packages/ui/src/styles/tokens.generated.css (из design/tokens.json),
 * тема «Бумага», акцент «Гранат».
 * Обновить: node scripts/gen-print-palette.mjs
 *
 * Палитра для экспорта в HTML/PDF/DOCX. Экспортный документ покидает
 * приложение и не может ссылаться на рантайм-токены темы, поэтому цвета здесь
 * литеральные. Чтобы они не разъезжались с дизайн-системой, файл выводится из
 * токенов, а тест export-palette.test.ts падает, если его забыли пересобрать.
 *
 * BEHAVIOR §9: экспорт всегда в светлой теме, колонка 640,
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
      'gen-print-palette: print-palette.ts разошёлся с токенами.\n' +
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
