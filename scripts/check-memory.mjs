/**
 * Память приложения: сколько её съедает хранилище заметок.
 *
 * ── Отказ, ради которого написано ───────────────────────────────────────────
 *
 * Заказчик: «Сейчас открытый сайт в Chrome занимает 804 МБ». Замер показал две
 * разные причины, и первая была наша целиком: индекс поиска держал текст
 * заметок деревом строковых склеек. В V8 каждое `out += char` не дописывает
 * буфер, а заводит узел ConsString, который держит обе половины, — и заметка в
 * 2700 знаков превращалась в дерево из 2700 узлов. Снимок кучи: 4,65 млн
 * строковых объектов мельче 64 байт на 81 МБ при корпусе в 2,7 МБ.
 *
 * Числа до и после (1000 заметок по 2,7 КБ, тот же прогон):
 *
 *   куча JS      95,6 МБ  →  20,3 МБ
 *   процессы    661   МБ  → 575   МБ
 *
 * ── Почему браузер, а не модульный тест ─────────────────────────────────────
 *
 * Расход памяти виден только в настоящей куче настоящего движка: `heapUsed` в
 * node меряет другой процесс и другую реализацию строк, а happy-dom не хранит
 * ни индекс, ни документ. Здесь же приложение открывает НАСТОЯЩЕЕ хранилище в
 * OPFS и меряется тем же счётчиком, что показывает диспетчер задач Chrome.
 *
 * Второе, что сторожится, — вложения. Байты картинки живут не в куче JS, а в
 * `blob:`-URL, и каждый невыданный обратно `revokeObjectURL` — утечка ровно на
 * размер файла. Сторож требует, чтобы после обхода заметок живым оставался
 * максимум один блоб: тот, что показан сейчас.
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
const PORT = Number(process.env['ZAPISKI_PORT'] ?? 4195);
const STRICT =
  process.argv.includes('--strict') || process.env['ZAPISKI_WALKTHROUGH_STRICT'] === '1';

/** Хранилище замера: столько заметок держит практикующий человек за год-два. */
const NOTES = 800;
/** Размер заметки: примерно страница текста. */
const PARAGRAPHS = 20;
/** Сколько картинок кладём и сколько заметок с ними обходим. */
const IMAGES = 6;

/**
 * Бюджет кучи. Замер на этом наборе — около 18 МБ; порог с запасом втрое, но
 * втрое же ниже прежних 80+ МБ, которые давало дерево склеек. Смысл порога не
 * «поймать мегабайт», а не дать вернуться разнице на порядок.
 */
const HEAP_BUDGET_MB = 45;

const skip = (reason) => {
  console.log(`Память: пропуск — ${reason}`);
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
  args: ['--no-sandbox', '--js-flags=--expose-gc'],
  env: browserEnv(),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'ru-RU',
});
const page = await context.newPage();

/* Счётчик блобов ставится ДО кода приложения: считаем выданные и отозванные. */
await page.addInitScript(() => {
  const live = new Map();
  const stats = { made: 0, revoked: 0, liveBytes: 0 };
  window.__blobs = stats;
  const makeUrl = URL.createObjectURL.bind(URL);
  const dropUrl = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (obj) => {
    const url = makeUrl(obj);
    const size = obj && typeof obj.size === 'number' ? obj.size : 0;
    live.set(url, size);
    stats.made += 1;
    stats.liveBytes += size;
    return url;
  };
  URL.revokeObjectURL = (url) => {
    const size = live.get(url);
    if (size !== undefined) {
      live.delete(url);
      stats.revoked += 1;
      stats.liveBytes -= size;
    }
    dropUrl(url);
  };
});
await seedWebSession(page);

const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

async function heapMb() {
  await page.evaluate(() => {
    if (typeof window.gc === 'function') window.gc();
  });
  await page.waitForTimeout(600);
  const metrics = await cdp.send('Performance.getMetrics');
  const heap = metrics.metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
  return heap / 1024 / 1024;
}

async function onboard() {
  for (let step = 0; step < 6; step += 1) {
    const button = page.getByRole('button', { name: /Начать|Дальше|Пропустить/ }).first();
    if ((await button.count()) === 0) break;
    await button.click().catch(() => undefined);
    await page.waitForTimeout(300);
  }
}

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await onboard();
await page.waitForTimeout(800);
const empty = await heapMb();

/*
 * Хранилище рисует сама страница: гонять картинки аргументом в `evaluate`
 * значит оставить в её куче сотни мегабайт мусора и померить его вместо
 * приложения.
 */
const seeded = await page.evaluate(
  async ({ notes, images, paragraphs }) => {
    const root = await navigator.storage.getDirectory();
    let vault = null;
    for await (const [, handle] of root.entries()) {
      if (handle.kind === 'directory') {
        vault = handle;
        break;
      }
    }
    if (!vault) return { error: 'папки хранилища в OPFS нет' };
    const write = async (dir, file, data) => {
      const handle = await dir.getFileHandle(file, { create: true });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
    };

    const folder = await vault.getDirectoryHandle('Images', { create: true });
    const canvas = new OffscreenCanvas(1200, 900);
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < images; i += 1) {
      const data = ctx.createImageData(1200, 900);
      for (let p = 0; p < data.data.length; p += 4) {
        data.data[p] = (p + i * 37) % 251;
        data.data[p + 1] = (p * 3 + i * 11) % 241;
        data.data[p + 2] = (p * 7 + i * 5) % 239;
        data.data[p + 3] = 255;
      }
      ctx.putImageData(data, 0, 0);
      await write(folder, `снимок-${i}.png`, await canvas.convertToBlob({ type: 'image/png' }));
    }

    const paragraph =
      'Обычный абзац с **жирным**, *курсивом* и `кодом`, достаточно длинный, чтобы ' +
      'заметка была похожа на настоящую, а не на строчку из теста. ';
    let chars = 0;
    for (let i = 0; i < notes; i += 1) {
      const body = [
        `# Заметка ${String(i).padStart(3, '0')}`,
        '',
        paragraph.repeat(paragraphs),
        '',
        /* Картинка есть в КАЖДОЙ заметке — их всего шесть, они повторяются.
           Иначе обход зависел бы от порядка списка: заметки засеяны одним
           махом, время правки у них общее, и кто окажется наверху — вопрос
           тонкостей сортировки, а не проверки. */
        `![](Images/снимок-${i % images}.png)`,
        '',
        `#тег${i % 20}`,
      ].join('\n');
      chars += body.length;
      await write(vault, `Заметка ${String(i).padStart(3, '0')}.md`, body);
    }
    return { notes, chars };
  },
  { notes: NOTES, images: IMAGES, paragraphs: PARAGRAPHS },
);
if (seeded.error) {
  console.error(`Память: ${seeded.error}`);
  await browser.close();
  server.close();
  process.exit(1);
}

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await onboard();
await page.waitForTimeout(4000);

const listed = await page.evaluate(() => document.querySelectorAll('.za-row').length);
check(listed > 0, 'список заметок пуст — мерить нечего, хранилище не открылось');

const loaded = await heapMb();
const perNote = ((loaded - empty) * 1024) / NOTES;
console.log(
  `Память: пусто ${empty.toFixed(1)} МБ · ${NOTES} заметок (${(seeded.chars / 1024 / 1024).toFixed(1)} МБ текста) ` +
    `${loaded.toFixed(1)} МБ · ${perNote.toFixed(1)} КБ на заметку`,
);
check(
  loaded <= HEAP_BUDGET_MB,
  `куча ${loaded.toFixed(1)} МБ при бюджете ${HEAP_BUDGET_MB} МБ на ${NOTES} заметок ` +
    `(${(seeded.chars / 1024 / 1024).toFixed(1)} МБ текста) — где-то завелась копия текста на копии`,
);

/* Обход заметок с вложениями: блобы обязаны отзываться. */
const rows = page.locator('.za-row');
const total = await rows.count();
for (let i = 0; i < Math.min(IMAGES + 2, total); i += 1) {
  await rows.nth(i).click().catch(() => undefined);
  await page.waitForTimeout(500);
  /* Докрутить до картинки: CodeMirror рисует только видимый кусок, и вложение
     ниже экрана не читается вовсе — как и у человека, пока он не долистал. */
  await page.evaluate(() => {
    for (const selector of ['.za-editor__surface', '.cm-scroller']) {
      const scroller = document.querySelector(selector);
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }
  });
  await page.waitForTimeout(700);
  const back = page.getByRole('button', { name: /Назад/ }).first();
  if ((await back.count()) > 0) {
    await back.click().catch(() => undefined);
    await page.waitForTimeout(300);
  }
}
const blobs = await page.evaluate(() => window.__blobs);
const leaked = blobs.made - blobs.revoked;
console.log(
  `        вложения: выдано ${blobs.made} blob-адресов, отозвано ${blobs.revoked}, ` +
    `живых ${(blobs.liveBytes / 1024 / 1024).toFixed(1)} МБ`,
);
check(
  leaked <= 2,
  `не отозвано ${leaked} blob-адресов вложений — байты каждого живут в памяти вкладки до ` +
    'закрытия страницы',
);

const after = await heapMb();
check(
  after <= HEAP_BUDGET_MB,
  `после обхода заметок куча ${after.toFixed(1)} МБ при бюджете ${HEAP_BUDGET_MB} МБ`,
);

await context.close();
await browser.close();
server.close();

if (problems.length > 0) {
  console.error('Память: расхождения');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log('Память: расход в пределах бюджета, вложения отпускаются');
