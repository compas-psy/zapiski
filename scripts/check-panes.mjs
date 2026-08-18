/**
 * Ширину панелей меняют мышью, и она запоминается.
 *
 * ── Что просил заказчик ─────────────────────────────────────────────────────
 *
 * «Ширина блоков Меню, список заметок, редактор должна быть настраиваема
 * мышкой — навёл на границу, появился соответствующий стандартный курсор и при
 * клике и перетаскивании ширина меняется и запоминается».
 *
 * Здесь проверяется ровно это, и ни одно из трёх утверждений модульным тестом
 * не проверяется вовсе:
 *
 *   · курсор над границей — системный `col-resize`. Это ВЫЧИСЛЕННЫЙ стиль:
 *     правило живёт в `app.css`, а класс ставит компонент, и сходятся они
 *     только на экране;
 *   · перетаскивание меняет ширину панели — то есть настоящую геометрию, а не
 *     число в состоянии;
 *   · после перезагрузки ширина та же — оформление пережило перезапуск.
 *
 * Пропуск — провал: `--strict` обязателен в CI.
 */
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { browserEnv, findChrome } from './find-chrome.mjs';
import { serveDist } from './static-server.mjs';
import { seedWebSession } from './web-session.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = path.join(ROOT, 'apps/web/dist');
const CHROME = findChrome();
const PORT = Number(process.env['ZAPISKI_PORT'] ?? 4192);
const STRICT =
  process.argv.includes('--strict') || process.env['ZAPISKI_WALKTHROUGH_STRICT'] === '1';

const skip = (reason) => {
  console.log(`Ширина панелей: пропуск — ${reason}`);
  process.exit(STRICT ? 1 : 0);
};

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  skip('нет playwright-core');
}
if (CHROME === null) skip('браузер не найден — поставьте Chromium или задайте ZAPISKI_CHROME');
await access(path.join(DIST, 'index.html')).catch(() =>
  skip('нет собранной статики (pnpm --filter "@zapiski/web..." build)'),
);

const server = await serveDist(DIST, PORT).catch((error) => skip(error.message));
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox'],
  env: browserEnv(),
});
/* Трёхпанельная раскладка начинается с 1200 px — берём заведомо широкий экран. */
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'ru-RU',
});
const page = await context.newPage();

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

await seedWebSession(page);
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
for (let step = 0; step < 6; step += 1) {
  const button = page.getByRole('button', { name: /Начать|Дальше|Пропустить/ }).first();
  if ((await button.count()) === 0) break;
  await button.click().catch(() => undefined);
  await page.waitForTimeout(300);
}
await page.waitForTimeout(600);

/** Ширина панели на экране, а не в состоянии. */
const widthOf = (selector) =>
  page.evaluate((selector) => {
    const node = document.querySelector(selector);
    return node ? Math.round(node.getBoundingClientRect().width) : 0;
  }, selector);

/** Потянуть границу панели на `delta` пикселей вправо. */
async function drag(selector, delta) {
  const handle = page.locator(`${selector} .za-resizer`);
  if ((await handle.count()) === 0) return false;
  const box = await handle.boundingBox();
  if (box === null) return false;
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  /* Двумя шагами: одно движение мышь иногда отдаёт как «перепрыгнул», и
     обработчик не успевает увидеть промежуточные значения. */
  await page.mouse.move(x + delta / 2, y, { steps: 4 });
  await page.mouse.move(x + delta, y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  return true;
}

const panes = [
  { name: 'библиотека', selector: '.za-pane--library', delta: 80 },
  { name: 'список заметок', selector: '.za-pane--list', delta: 60 },
];

for (const pane of panes) {
  const handle = page.locator(`${pane.selector} .za-resizer`);
  if ((await handle.count()) === 0) {
    problems.push(`${pane.name}: границы, за которую тянуть, нет вовсе`);
    continue;
  }

  const cursor = await handle.evaluate((node) => getComputedStyle(node).cursor);
  check(
    cursor === 'col-resize',
    `${pane.name}: курсор над границей «${cursor}», а человек ждёт системный col-resize`,
  );

  const before = await widthOf(pane.selector);
  await drag(pane.selector, pane.delta);
  const after = await widthOf(pane.selector);
  check(
    Math.abs(after - before - pane.delta) <= 4,
    `${pane.name}: ширина ${before} → ${after} при перетаскивании на ${pane.delta} px`,
  );
  pane.expected = after;
}

/* Перезагрузка: ширина обязана пережить перезапуск. */
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
for (const pane of panes) {
  if (pane.expected === undefined) continue;
  const now = await widthOf(pane.selector);
  check(
    Math.abs(now - pane.expected) <= 2,
    `${pane.name}: после перезагрузки ширина ${now} вместо ${pane.expected} — не запомнилась`,
  );
}

await context.close();
await browser.close();
server.close();

if (problems.length > 0) {
  console.error('Ширина панелей: расхождения');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log('Ширина панелей: курсор системный, перетаскивание меняет ширину, ширина запоминается');
