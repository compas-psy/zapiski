#!/usr/bin/env node
/**
 * design/tokens.json → packages/ui/src/styles/tokens.generated.css
 *
 * Мост «дизайн → код» (tz/ZAPISKI_TZ_3_Agents.md §6): единственный артефакт
 * передачи — `tokens.json`. Код не подбирает цвета и не читает макеты глазами,
 * он импортирует сгенерированный отсюда CSS.
 *
 * Запуск:
 *   node packages/ui/scripts/build-tokens.mjs           # перегенерировать
 *   node packages/ui/scripts/build-tokens.mjs --check   # CI: файл не разошёлся
 *
 * Почему сгенерированный CSS лежит в репозитории, а не собирается на лету:
 * стили пакета подключаются обычным `@import` из `styles/index.css`, а vite в
 * оболочках читает их с диска. Генерация на этапе сборки означала бы плагин в
 * трёх конфигурациях vite и в vitest; проверка `--check` в преflight стоит
 * дешевле и ловит ровно тот же дефект — правку CSS мимо источника.
 *
 * Что генератор НЕ делает: производные значения (hover, кольца фокуса,
 * подсветку) — они в tokens.css через color-mix(), потому что выводятся из
 * акцента арифметикой, а не задаются дизайнером поштучно.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const SOURCE = resolve(REPO_ROOT, 'design/tokens.json');
const TARGET = resolve(REPO_ROOT, 'packages/ui/src/styles/tokens.generated.css');

/** Селекторы тем. Базовая — «Бумага»: она же действует, когда data-theme нет. */
const THEME_SELECTOR = {
  paper: "[data-theme='paper'],\n:root:not([data-theme])",
  graphite: "[data-theme='graphite']",
  ink: "[data-theme='ink']",
};

/** Светлая группа — одна тема; тёмная — две, поэтому статусы и код общие. */
const LIGHT_GROUP = THEME_SELECTOR.paper;
const DARK_GROUP = "[data-theme='graphite'],\n[data-theme='ink']";

/** Акцент по умолчанию: действует и тогда, когда data-accent не выставлен. */
const DEFAULT_ACCENT = 'garnet';

/**
 * Акцент переопределяется на любом поддереве — это нужно кружкам выбора
 * акцента и живому превью в «Внешнем виде». Поэтому у каждого правила два
 * вида селектора: компаунд (акцент на самом корне) и потомок.
 */
function accentLightSelector(name) {
  const own = `[data-accent='${name}']`;
  return name === DEFAULT_ACCENT ? `${own},\n:root:not([data-accent])` : own;
}

function accentDarkSelector(name) {
  const parts = [];
  for (const theme of ['graphite', 'ink']) {
    parts.push(`[data-theme='${theme}'][data-accent='${name}']`);
    parts.push(`[data-theme='${theme}'] [data-accent='${name}']`);
  }
  if (name === DEFAULT_ACCENT) {
    for (const theme of ['graphite', 'ink']) {
      parts.push(`:root[data-theme='${theme}']:not([data-accent])`);
    }
  }
  return parts.join(',\n');
}

const isToken = (node) =>
  node !== null && typeof node === 'object' && Object.hasOwn(node, '$value');

/** Значение токена в том виде, в каком его понимает CSS. */
function cssValue(token) {
  const value = token.$value;
  if (token.$type === 'cubicBezier') return `cubic-bezier(${value.join(', ')})`;
  return String(value);
}

/**
 * Листья группы в порядке объявления. `$`-ключи — метаданные DTCG, не токены.
 * Вложенность глубже одного уровня здесь не нужна и намеренно не поддержана:
 * плоская группа однозначно ложится в один CSS-блок.
 */
function leaves(group) {
  const out = [];
  for (const [key, node] of Object.entries(group ?? {})) {
    if (key.startsWith('$')) continue;
    if (!isToken(node)) throw new Error(`Ожидался токен в ключе «${key}», пришла группа`);
    out.push([key, node]);
  }
  return out;
}

/**
 * Один CSS-блок. `color-scheme` — единственное имя, которое печатается как
 * обычное свойство: это не переменная, а указание браузеру, каким рисовать
 * скроллбар и системные контролы.
 */
function block(selector, group, comment) {
  const lines = [];
  if (comment) lines.push(`/* ${comment} */`);
  lines.push(`${selector} {`);
  for (const [name, token] of leaves(group)) {
    const property = name === 'color-scheme' ? 'color-scheme' : `--${name}`;
    const note = token.$description ? `  /* ${token.$description} */` : '';
    lines.push(`  ${property}: ${cssValue(token)};${note}`);
  }
  lines.push('}');
  return lines.join('\n');
}

function build(tokens) {
  const blocks = [];

  blocks.push(
    block(':root', tokens.typography, 'Типографика — tz/ZAPISKI_TZ_1_Design.md §2'),
    block(':root', tokens.space, 'Отступы'),
    block(':root', tokens.radius, 'Радиусы'),
    block(':root', tokens.size, 'Метрики элементов'),
    block(':root', tokens.motion, 'Motion'),
    block(':root', tokens.layer, 'Слои'),
    block(':root', tokens.color.brand, 'Знак сервиса'),
    /* Кнопки окна одинаковы во всех темах — поэтому :root, а не тема. */
    block(':root', tokens.color.window, 'Кнопки своей строки заголовка'),
  );

  for (const [theme, group] of Object.entries(tokens.color.theme)) {
    if (theme.startsWith('$')) continue;
    blocks.push(block(THEME_SELECTOR[theme], group, `Тема «${theme}»`));
    blocks.push(block(THEME_SELECTOR[theme], tokens.shadow[theme], `Тени темы «${theme}»`));
  }

  blocks.push(
    block(LIGHT_GROUP, tokens.color.status.light, 'Статусы — светлая тема'),
    block(DARK_GROUP, tokens.color.status.dark, 'Статусы — тёмные темы'),
    block(LIGHT_GROUP, tokens.color.code.light, 'Подсветка кода — светлая тема'),
    block(DARK_GROUP, tokens.color.code.dark, 'Подсветка кода — тёмные темы'),
  );

  for (const [name, group] of Object.entries(tokens.color.accent)) {
    if (name.startsWith('$')) continue;
    blocks.push(block(accentLightSelector(name), group.light, `Акцент «${name}» — светлая тема`));
    blocks.push(block(accentDarkSelector(name), group.dark, `Акцент «${name}» — тёмные темы`));
  }

  const header = [
    '/* СГЕНЕРИРОВАНО packages/ui/scripts/build-tokens.mjs — НЕ РЕДАКТИРОВАТЬ.',
    ' *',
    ' * Источник: design/tokens.json. Правка здесь будет затёрта следующей',
    ' * генерацией, а до этого её поймает `build-tokens.mjs --check` в преflight.',
    ' */',
    '',
  ].join('\n');

  return `${header}${blocks.join('\n\n')}\n`;
}

const tokens = JSON.parse(readFileSync(SOURCE, 'utf8'));
const css = build(tokens);
const shown = relative(REPO_ROOT, TARGET);

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(TARGET, 'utf8');
  } catch {
    console.error(`токены: ${shown} не существует — запустите build-tokens.mjs`);
    process.exit(1);
  }
  if (current !== css) {
    console.error(
      `токены: ${shown} разошёлся с design/tokens.json.\n` +
        'Запустите: node packages/ui/scripts/build-tokens.mjs',
    );
    process.exit(1);
  }
  console.log(`токены: ${shown} совпадает с design/tokens.json`);
  process.exit(0);
}

writeFileSync(TARGET, css);
console.log(`токены: ${shown} собран из design/tokens.json`);
