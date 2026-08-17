/**
 * Картинки в заметке стоят рядом, пока помещаются по ширине, и переносятся,
 * когда не помещаются.
 *
 * ── Зачем браузер ───────────────────────────────────────────────────────────
 *
 * Заказчик: «если добавлять картинки в ЗАПИСКУ, то они размещаются только друг
 * под другом». Причин было ДВЕ, и починка одной ничего не меняла:
 *
 *  1. разметка: команда вставки открывала новую строку, а строка в CodeMirror —
 *     отдельный блок, и рядом такие блоки не встанут никаким CSS;
 *  2. оформление: обёртка картинки была `display: block; width: 100%` — блок на
 *     всю ширину колонки, сколько бы места ни оставалось справа.
 *
 * Первую сторожат модульные тесты (`packages/editor/test/images-row.test.ts`):
 * они видят документ. Вторую видит только раскладка — в happy-dom нет ни
 * ширин, ни переносов, и «в ряд» от «столбиком» там неотличимо. Ровно на этом
 * прогон и поймал меня: тесты были зелёные, а картинки стояли столбиком, потому
 * что я мерил старую сборку.
 *
 * Поэтому здесь настоящий браузер и настоящая вставка — через тот же
 * `<input type="file">`, которым пользуется человек. Иначе картинка не станет
 * виджетом: виджет строится только для вложений, а не для любого адреса.
 *
 * Пропуск — провал: `--strict` обязателен в CI.
 */
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { browserEnv, findChrome } from './find-chrome.mjs';
import { serveDist } from './static-server.mjs';
import { seedWebSession } from './web-session.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = path.join(ROOT, 'apps/web/dist');
const CHROME = findChrome();
const PORT = Number(process.env['ZAPISKI_PORT'] ?? 4189);
const STRICT =
  process.argv.includes('--strict') || process.env['ZAPISKI_WALKTHROUGH_STRICT'] === '1';

/**
 * PNG заданной ширины, собранный на месте.
 *
 * Готовая крошка 2×2 годится только для «стоят рядом»: она и правда узкая. Для
 * «переносятся» нужна картинка ШИРЕ половины колонки, а задать ширину подписью
 * в этом прогоне нельзя — путь вложения придумывает приложение, и вслепую его
 * в разметке не напишешь. Поэтому ширину даёт сам файл.
 */
function png(width, height = 8) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // фильтр «нет»
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = 90;
      raw[row + 2 + x * 3] = 110;
      raw[row + 3 + x * 3] = 140;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** CRC32 из спецификации PNG: таблица считается один раз. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const skip = (reason) => {
  console.log(`Ряд картинок: пропуск — ${reason}`);
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

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

/** Прямоугольники обёрток картинок — то, что видит человек. */
const boxesOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.cm-z-image-wrap')].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
      };
    }),
  );

const VIEWPORTS = [
  { name: 'телефон', width: 390, height: 844 },
  { name: 'десктоп', width: 1440, height: 900 },
];

for (const viewport of VIEWPORTS) {
  const where = viewport.name;
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    locale: 'ru-RU',
  });
  const page = await context.newPage();

  await seedWebSession(page);
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  for (let step = 0; step < 6; step += 1) {
    const button = page.getByRole('button', { name: /Начать|Дальше|Пропустить/ }).first();
    if ((await button.count()) === 0) break;
    await button.click().catch(() => undefined);
    await page.waitForTimeout(300);
  }

  const content = page.locator('.cm-content').first();
  if ((await content.count()) === 0) {
    problems.push(`${where}: редактор не открылся — проверять нечего`);
    await context.close();
    continue;
  }
  await content.click();
  await page.keyboard.type('Две картинки');

  const input = page.locator('input[type=file]').first();
  if ((await input.count()) === 0) {
    problems.push(`${where}: в заметке нет поля выбора файла — вложить картинку нечем`);
    await context.close();
    continue;
  }

  // ── Помещаются: стоят рядом ───────────────────────────────────────────────
  const NARROW = png(24);
  for (const name of ['a.png', 'b.png']) {
    await input.setInputFiles({ name, mimeType: 'image/png', buffer: NARROW });
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(600);

  const narrow = await boxesOf(page);
  check(narrow.length === 2, `${where}: картинок в заметке ${narrow.length}, а вложили 2`);
  if (narrow.length === 2) {
    check(
      Math.abs(narrow[0].top - narrow[1].top) <= 2,
      `${where}: узкие картинки встали столбиком (top ${narrow[0].top} и ${narrow[1].top}), ` +
        'хотя по ширине помещались рядом',
    );
    check(
      narrow[1].left > narrow[0].left,
      `${where}: вторая картинка не правее первой (left ${narrow[0].left} и ${narrow[1].left})`,
    );
  }

  // ── Не помещаются: переносятся, а не вылезают за колонку ──────────────────
  /*
   * Новая заметка и две картинки, каждая шире половины колонки. Ширину даёт сам
   * файл: путь вложения придумывает приложение, и написать разметку с ним
   * вслепую нельзя.
   */
  const WIDE = png(1400);
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  for (const name of ['wide-1.png', 'wide-2.png']) {
    await input.setInputFiles({ name, mimeType: 'image/png', buffer: WIDE });
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(800);

  const all = await boxesOf(page);
  const wideBoxes = all.slice(-2);
  check(all.length === 4, `${where}: картинок в заметке ${all.length}, а вложили 4`);
  if (wideBoxes.length === 2) {
    check(
      Math.abs(wideBoxes[0].top - wideBoxes[1].top) > 2,
      `${where}: широкие картинки остались в одном ряду (top ${wideBoxes[0].top} и ` +
        `${wideBoxes[1].top}) — значит перенос по ширине не работает`,
    );
  }
  const columnRight = await page.evaluate(() => {
    const line = document.querySelector('.cm-content');
    return line ? Math.round(line.getBoundingClientRect().right) : 0;
  });
  for (const box of all) {
    check(
      box.right <= columnRight + 2,
      `${where}: картинка вылезла за колонку (right ${box.right} против ${columnRight})`,
    );
  }

  await context.close();
}

await browser.close();
server.close();

if (problems.length > 0) {
  console.error('Ряд картинок: расхождения');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log(
  'Ряд картинок: узкие стоят рядом, широкие переносятся и не вылезают за колонку ' +
    `(${VIEWPORTS.map((v) => v.name).join(', ')})`,
);
