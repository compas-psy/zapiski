/**
 * Токены приложения обязаны совпадать с источником дизайна.
 *
 * Источник один — `design/tokens.json` (tz/ZAPISKI_TZ_3_Agents.md §6: «Код не
 * читает макеты глазами и не подбирает цвета: он импортирует токены»). Спор о
 * любом цвете решается этим файлом.
 *
 * Проверяется ВЫЧИСЛЕННОЕ значение в живом браузере, а не текст CSS: между
 * файлом и экраном стоят каскад, порядок импортов и промежуточные переменные,
 * и расхождение появляется именно там. Сравнение текста с текстом такой дефект
 * пропускает — этим уже наступали.
 *
 * Запуск:
 *   pnpm --filter "@zapiski/web..." build
 *   node scripts/check-design-tokens.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHROME =
  process.env.ZAPISKI_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * Пропуск печатается вслух и возвращает 0.
 *
 * Сторож не должен ронять прогон там, где его нельзя выполнить: на раннере без
 * браузера это была бы поломка на пустом месте. Но молчаливый пропуск читается
 * как «проверено» — поэтому он всегда назван причиной.
 */
function skip(reason) {
  console.log(`токены: ПРОПУЩЕНО — ${reason}`);
  process.exit(0);
}

if (!existsSync(CHROME)) skip(`нет браузера по пути ${CHROME}`);

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  skip('нет playwright-core');
}
const PORT = process.env.ZAPISKI_PORT ?? '4200';
const URL_BASE = `http://127.0.0.1:${PORT}/`;
const REF = fileURLToPath(new URL('../design/tokens.json', import.meta.url));
const TOKENS = JSON.parse(readFileSync(REF, 'utf8'));

/** Ожидаемые значения прямо из источника: из него же собран и CSS сборки. */
function expected(theme) {
  const group = TOKENS.color.theme[theme];
  const status = TOKENS.color.status[theme === 'paper' ? 'light' : 'dark'];
  const out = {};
  for (const [name, token] of Object.entries({ ...group, ...status })) {
    if (name.startsWith('$') || name === 'color-scheme') continue;
    out[`--${name}`] = String(token.$value);
  }
  return out;
}

const alive = async () => {
  try { await fetch(URL_BASE, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
};
let server = null;
if (!(await alive())) {
  server = spawn('npx', ['--yes', 'serve', '-s', 'apps/web/dist', '-l', PORT], { stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await alive()); i += 1) await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'ru-RU' });
await page.goto(URL_BASE, { waitUntil: 'networkidle' });

/**
 * Браузер отдаёт `#fff` там, где в эталоне `#FFFFFF`, и убирает пробелы в
 * `rgba(...)`. Это одно и то же значение, и ругаться на него значит приучить
 * не верить сторожу.
 */
function normalize(value) {
  const v = value.trim().toLowerCase().replace(/\s+/g, '');
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return v;
}

const NAMES = [
  '--bg', '--surface', '--surface-alt', '--surface-sunken', '--line', '--line-soft',
  '--text', '--text-secondary', '--text-tertiary', '--text-disabled', '--text-ghost',
  '--on-accent', '--success', '--warning', '--danger', '--info',
];

let bad = 0;
for (const theme of ['paper', 'graphite', 'ink']) {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  const got = await page.evaluate((names) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()]));
  }, NAMES);
  const want = expected(theme);
  const wrong = NAMES.filter((n) => want[n] !== undefined && normalize(got[n]) !== normalize(want[n]));
  console.log(`${theme}: совпало ${NAMES.length - wrong.length}/${NAMES.length}`);
  for (const n of wrong) console.log(`   ${n}: эталон ${want[n]}, применено «${got[n]}»`);
  bad += wrong.length;
}

/* Акцент по умолчанию — гранат: в светлой теме базовый, в тёмных осветлённый
   (tz/ZAPISKI_TZ_1_Design.md §1, Р5). */
const GARNET = TOKENS.color.accent.garnet;
for (const [theme, want] of [
  ['paper', GARNET.light.accent.$value],
  ['graphite', GARNET.dark.accent.$value],
  ['ink', GARNET.dark.accent.$value],
]) {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  );
  const ok = normalize(accent) === normalize(want);
  if (!ok) bad += 1;
  console.log(`${theme}: --accent = ${accent} ${ok ? '' : `(источник ${want})`}`);
}

await browser.close();
server?.kill();
console.log(bad === 0 ? 'ТОКЕНЫ СОВПАДАЮТ С design/tokens.json' : `РАСХОЖДЕНИЙ: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
