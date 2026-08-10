/**
 * Токены приложения обязаны совпадать с эталоном дизайна.
 *
 * README пакета дизайна: «Приоритет документов при конфликте: zapiski.css
 * (значения) > REBUILD.md > DS-ALIGNMENT.md > BEHAVIOR.md > SCREENS.md >
 * DESIGN_TOKENS.md». Значит, спор о любом цвете решается одним файлом — и
 * проверять это надо не глазами по макету, а сравнением вычисленных значений.
 *
 * Проверяется ВЫЧИСЛЕННОЕ значение в живом браузере, а не текст CSS: между
 * файлом и экраном стоят каскад, порядок импортов и промежуточные переменные,
 * и расхождение появляется именно там. Прежняя редакция токенов выводила
 * `--bg: var(--background)` из чужого файла — значение приходило со стороны и
 * менялось вместе с ним.
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
/* Эталон лежит в репозитории: сторож не должен зависеть от каталога, который
   существует только на одной машине. */
const REF = fileURLToPath(new URL('../docs/design/zapiski.css', import.meta.url));

/** Ожидаемые значения прямо из эталона: их же читает и сборка. */
function expected(theme) {
  const src = readFileSync(REF, 'utf8');
  const selector =
    theme === 'simpas'
      ? ':root[data-theme="simpas"], :root:not([data-theme])'
      : `:root[data-theme="${theme}"]`;
  const at = src.indexOf(selector);
  const body = src.slice(at, src.indexOf('}', at));
  const out = {};
  for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim();
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
for (const theme of ['simpas', 'graphite', 'ink']) {
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

// Акцент в тёмных темах — приглушённый, светлый только для текста (REBUILD §1.11).
for (const theme of ['graphite', 'ink']) {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  );
  const ok = normalize(accent) === '#2e6b4a';
  if (!ok) bad += 1;
  console.log(`${theme}: --accent = ${accent} ${ok ? '' : '(эталон #2E6B4A)'}`);
}

await browser.close();
server?.kill();
console.log(bad === 0 ? 'ТОКЕНЫ СОВПАДАЮТ С ЭТАЛОНОМ' : `РАСХОЖДЕНИЙ: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
