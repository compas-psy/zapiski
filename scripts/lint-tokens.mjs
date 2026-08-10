#!/usr/bin/env node
/**
 * lint-tokens — «ни одного hex вне токен-файла».
 *
 * Требование ТЗ §6 и DoD, зафиксировано в ARCHITECTURE.md §3.4 и
 * docs/spec/DESIGN_TOKENS.md §4. Проверяет исходники продуктовых пакетов:
 *
 *     packages/<pkg>/src/**    apps/<app>/src/**
 *
 * Падает, если находит литерал цвета: #rgb, #rgba, #rrggbb, #rrggbbaa,
 * rgb(, rgba(, hsl(, hsla(. Исключения — TOKEN_FILES (наш файл токенов и
 * сгенерированная палитра экспорта) и TOKEN_DIRECTORIES (снимок дизайн-системы
 * СИМПАС и знак сервиса: чужие файлы, править которые запрещено). Обоснование
 * каждого исключения — рядом с ним.
 *
 * Запуск:  node scripts/lint-tokens.mjs [--root <путь>] [--quiet]
 * Выход:   0 — чисто, 1 — есть нарушения, 2 — ошибка запуска.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

/** Единственное место в репозитории, где цветовые литералы разрешены. */
const TOKEN_FILES = [
  'packages/ui/src/styles/tokens.css',

  // Токены из пакета дизайна, перенесённые ДОСЛОВНО. Исключение осознанное:
  // это и есть файл токенов — по README пакета `zapiski.css` приоритетнее
  // любого текста спецификации по любому цвету и радиусу. Правки в нём
  // запрещены, а расхождение с эталоном ловит `scripts/check-design-tokens.mjs`,
  // сравнивая ВЫЧИСЛЕННЫЕ значения в браузере со значениями из
  // `docs/design/zapiski.css`.
  'packages/ui/src/styles/tokens-reference.css',

  // Палитра экспорта. Исключение осознанное и безопасное: файл СГЕНЕРИРОВАН из
  // tokens.css (`node scripts/gen-print-palette.mjs`), руками не правится, а
  // тест `packages/core/test/export-palette.test.ts` падает, если он разошёлся
  // с источником. Литеральные цвета здесь неизбежны: экспортный документ
  // покидает приложение и не может ссылаться на рантайм-переменные темы.
  'packages/core/src/export/print-palette.ts',
];

/**
 * Каталоги, целиком выведенные из-под правила, — вместе с обоснованием.
 * Такое исключение уместно ровно тогда, когда файлы НЕ НАШИ и правка их
 * запрещена: чинить нарушение всё равно нельзя, а точечный перечень файлов
 * пришлось бы обновлять при каждом обновлении снимка.
 */
const TOKEN_DIRECTORIES = [
  // Снимок дизайн-системы СИМПАС (DS-ALIGNMENT.md §2). Побайтовая копия чужих
  // файлов: `vendor/` — не форк и не место для правок, при открытии пакета
  // `@simpas/design-system` каталог удаляется целиком. Литералы здесь и обязаны
  // быть — это и есть источник значений, на который ссылается tokens.css.
  // Знак сервиса `zapiski.svg` лежит рядом по той же причине: терракота
  // `#C8604A` внутри него — цвет идентичности, менять контур и цвет запрещено
  // (DS-ALIGNMENT §9), а в интерфейсные токены она не попадает.
  'packages/ui/src/styles/simpas/',
  'packages/ui/src/assets/services/',
];

/** Что вообще имеет смысл читать как текст. */
const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.svg',
  '.vue',
  '.json',
]);

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);

/**
 * #rgb / #rgba / #rrggbb / #rrggbbaa — но не хвост более длинной «словной»
 * последовательности (чтобы `#facade` не притворялся цветом наполовину).
 */
const HEX_PATTERN = /(?<![\w&])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])/g;
const FUNCTION_PATTERN = /(?<![\w-])(?:rgba?|hsla?)\s*\(/g;

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) {
        console.error('lint-tokens: --root требует путь');
        process.exit(2);
      }
      options.root = resolve(value);
      index += 1;
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else {
      console.error(`lint-tokens: неизвестный аргумент ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function* walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** packages/<pkg>/src и apps/<app>/src */
function collectSourceRoots(root) {
  const roots = [];
  for (const group of ['packages', 'apps']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = join(base, entry.name, 'src');
      if (existsSync(src) && statSync(src).isDirectory()) roots.push(src);
    }
  }
  return roots;
}

function positionOf(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return { line, column };
}

function findViolations(text) {
  const found = [];
  for (const pattern of [HEX_PATTERN, FUNCTION_PATTERN]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      found.push({ index: match.index, value: match[0] });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

function main() {
  const { root, quiet } = parseArgs(process.argv.slice(2));
  const allowed = new Set(TOKEN_FILES.map((file) => resolve(root, file)));
  const allowedDirectories = TOKEN_DIRECTORIES.map((dir) => resolve(root, dir));

  for (const file of allowed) {
    if (!existsSync(file)) {
      console.error(
        `lint-tokens: токен-файл ${relative(root, file)} не найден — исключение указывает в пустоту`,
      );
      process.exit(2);
    }
  }
  for (const directory of allowedDirectories) {
    if (!existsSync(directory)) {
      console.error(
        `lint-tokens: каталог-исключение ${relative(root, directory)} не найден — правило указывает в пустоту`,
      );
      process.exit(2);
    }
  }

  const sourceRoots = collectSourceRoots(root);
  if (sourceRoots.length === 0) {
    console.error('lint-tokens: не найдено ни одного packages/*/src или apps/*/src');
    process.exit(2);
  }

  const violations = [];
  let scanned = 0;

  for (const sourceRoot of sourceRoots) {
    for (const file of walk(sourceRoot)) {
      if (allowed.has(file)) continue;
      if (allowedDirectories.some((directory) => file.startsWith(directory + sep))) continue;
      const dot = file.lastIndexOf('.');
      const extension = dot === -1 ? '' : file.slice(dot);
      if (!SCANNED_EXTENSIONS.has(extension)) continue;
      scanned += 1;
      const text = readFileSync(file, 'utf8');
      for (const { index, value } of findViolations(text)) {
        const { line, column } = positionOf(text, index);
        violations.push({ file: relative(root, file).split(sep).join('/'), line, column, value });
      }
    }
  }

  if (violations.length > 0) {
    console.error('lint-tokens: цветовые литералы вне токен-файла');
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line}:${violation.column}  ${violation.value}`);
    }
    console.error('');
    console.error(
      `Найдено нарушений: ${violations.length}. Используйте var(--*) из ${TOKEN_FILES.join(', ')}\n` +
        `или переменные дизайн-системы из ${TOKEN_DIRECTORIES.join(', ')}.`,
    );
    console.error('Правило: ARCHITECTURE.md §3.4, docs/spec/DESIGN_TOKENS.md §4.');
    console.error(
      'Если файл обязан содержать цвет (например, самодостаточный экспортный документ),\n' +
        'исключение добавляется осознанно в TOKEN_FILES этого скрипта — с обоснованием в ревью.',
    );
    process.exit(1);
  }

  if (!quiet) {
    console.log(`lint-tokens: чисто — проверено файлов: ${scanned}, нарушений нет.`);
  }
  process.exit(0);
}

main();
