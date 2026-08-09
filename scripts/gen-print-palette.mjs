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
 * `simpas` и акцента по умолчанию `pine` («Хвоя»): BEHAVIOR §9 требует
 * экспортировать всегда в светлой теме, DS-ALIGNMENT §2–§3 задают, какая она.
 *
 * ВАЖНО про два файла. С переходом на дизайн-систему СИМПАС
 * `packages/ui/src/styles/tokens.css` стал слоем АЛИАСОВ: `--bg: var(--background)`,
 * `--accent: var(--primary)` и так далее. Литералы живут в снимке системы
 * (`packages/ui/src/styles/simpas/vendor/tokens/colors.css`). Поэтому генератор
 * читает оба файла и разворачивает цепочки `var(--…)` до литерала — иначе он
 * увидит `var(--background)` и решит, что палитра «не литеральная».
 *
 * Запуск: node scripts/gen-print-palette.mjs
 * Проверка синхронности: node scripts/gen-print-palette.mjs --check
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STYLES = resolve(ROOT, 'packages/ui/src/styles');
const TOKENS = resolve(STYLES, 'tokens.css');
/** Снимок дизайн-системы: здесь живут литералы, на которые ссылаются алиасы. */
const SYSTEM = resolve(STYLES, 'simpas/vendor/tokens/colors.css');
const SERVICES = resolve(STYLES, 'simpas/services.css');
const TARGET = resolve(ROOT, 'packages/core/src/export/print-palette.ts');

/** Тема и акцент, в которых печатает экспорт (BEHAVIOR §9, DS-ALIGNMENT §2–§3). */
const PRINT_THEME = 'simpas';
const PRINT_ACCENT = 'pine';

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

const systemCss = strip(SYSTEM) + '\n' + strip(SERVICES);
const tokensCss = strip(TOKENS);

/** Литералы и семантические алиасы самой системы — все в одном `:root`. */
const system = block(systemCss, [':root']);
/** Тема даёт поверхности и текст, акцент — интерактивные цвета. */
const theme = block(tokensCss, [`[data-theme=${PRINT_THEME}]`]);
// Светлый акцент объявлен безусловным блоком `[data-accent='pine']`, а тёмный
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
 * Источник: packages/ui/src/styles/tokens.css + снимок дизайн-системы СИМПАС
 * (styles/simpas/vendor/tokens/colors.css), тема «СИМПАС», акцент «Хвоя».
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
  sans: 'Geist, "Segoe UI", system-ui, sans-serif',
  mono: '"Geist Mono", ui-monospace, SFMono-Regular, monospace',
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
