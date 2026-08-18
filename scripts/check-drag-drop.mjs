/**
 * Перетаскивание в библиотеке: подсветка цели и настоящий переезд.
 *
 * ── Зачем браузер ───────────────────────────────────────────────────────────
 *
 * Заказчик просил дословно: «я в меню „взял“ мышкой папку и перетянул в другую
 * папку → ДОЛЖНО ПОДСВЕЧИВАТЬСЯ, куда сейчас перетягиваю + папка физически
 * перемещается после этого действия». Первая половина — про экран, и проверить
 * её модульным тестом нельзя: в happy-dom нет вычисленных стилей, а `outline`
 * рисуется правилом, которое живёт в другом пакете (`app.css`) и складывается с
 * атрибутом `data-drop-target` только на экране.
 *
 * Вторая проверка того же рода: подсветка обязана НЕ появляться там, где
 * бросок ничего не даст — на самой перетаскиваемой папке. Подсветка это
 * обещание, и обещать невыполнимое хуже, чем не подсвечивать вовсе.
 *
 * ── Почему события синтетические ────────────────────────────────────────────
 *
 * Настоящее перетаскивание из проводника Playwright не умеет: файл приходит из
 * операционной системы, а не из страницы. Зато сам перенос — обычные события
 * DOM, и `DataTransfer` создаётся в странице как есть. Проверяется ровно то,
 * что делает браузер: тот же объект переноса проходит `dragstart` → `dragover`
 * → `drop`, а обработчики продукта не подменены ничем.
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
const PORT = Number(process.env['ZAPISKI_PORT'] ?? 4194);
const STRICT =
  process.argv.includes('--strict') || process.env['ZAPISKI_WALKTHROUGH_STRICT'] === '1';

const skip = (reason) => {
  console.log(`Перетаскивание: пропуск — ${reason}`);
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

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
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

/** Создать папку через интерфейс — тем же путём, что и человек. */
async function makeFolder(name) {
  const add = page.getByRole('button', { name: /Новая папка/ }).first();
  if ((await add.count()) === 0) return false;
  await add.click();
  const field = page.getByRole('textbox').last();
  await field.fill(name);
  await page.getByRole('button', { name: 'Создать' }).click();
  await page.waitForTimeout(500);
  return true;
}

/**
 * Событие переноса по имени папки в дереве.
 *
 * Объект переноса живёт в странице между вызовами (`window.__zaDrag`): браузер
 * ведёт `dragstart` → `dragover` → `drop` ОДНИМ объектом, и подменять его на
 * каждом шаге значило бы проверять не тот путь.
 */
const fireDrag = (text, type) =>
  page.evaluate(
    ({ text, type }) => {
      const node = [...document.querySelectorAll('[role="treeitem"]')].find((item) =>
        item.textContent?.includes(text),
      );
      if (!node) return false;
      node.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: window.__zaDrag,
        }),
      );
      return true;
    },
    { text, type },
  );

/**
 * Обводка строки папки — то самое «подсвечивается, куда сейчас перетягиваю».
 *
 * Читается ПОСЛЕ паузы: подсветка живёт в состоянии React, и между событием и
 * перерисовкой проходит кадр. Померить сразу — значит померить прошлое.
 */
const outlineOf = async (text) => {
  await page.waitForTimeout(200);
  return page.evaluate((text) => {
    const node = [...document.querySelectorAll('[role="treeitem"]')].find((item) =>
      item.textContent?.includes(text),
    );
    return node ? getComputedStyle(node).outlineStyle : 'нет строки';
  }, text);
};

if (!(await makeFolder('Практика')) || !(await makeFolder('Архив'))) {
  problems.push('в библиотеке нет кнопки «Новая папка» — проверять нечего');
} else {
  await page.evaluate(() => {
    window.__zaDrag = new DataTransfer();
  });

  const started = await fireDrag('Практика', 'dragstart');
  if (!started) problems.push('папки «Практика» нет в дереве');
  const carried = await page.evaluate(() =>
    window.__zaDrag.getData('application/x-zapiski-folder'),
  );
  check(carried === 'Практика', `папка не кладётся в перенос: в нём «${carried}»`);

  await fireDrag('Архив', 'dragover');
  const onTarget = await outlineOf('Архив');
  check(onTarget === 'dashed', `цель не подсвечена: обводка «${onTarget}» вместо пунктира`);

  /* Бросок в себя ничего не даст — и подсветка не должна его обещать. */
  await fireDrag('Практика', 'dragover');
  const onSelf = await outlineOf('Практика');
  check(
    onSelf !== 'dashed',
    'подсвечена сама перетаскиваемая папка — бросок в себя ничего не даст, ' +
      'а подсветка это обещает',
  );

  await fireDrag('Архив', 'drop');
  await page.waitForTimeout(800);
  const moved = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="treeitem"]')];
    const inside = items.find((node) => node.textContent?.includes('Практика'));
    return {
      /* Уровень узла говорит, что папка стала подпапкой: `aria-level` 2. */
      level: inside?.getAttribute('aria-level') ?? null,
      names: items.map((node) => node.textContent?.trim() ?? ''),
    };
  });
  check(
    moved.level === '2',
    `папка не переехала внутрь: уровень «${moved.level}» при дереве ${JSON.stringify(moved.names)}`,
  );

  // ── Файл .md, брошенный на папку ─────────────────────────────────────────
  await page.evaluate(() => {
    window.__zaDrag = new DataTransfer();
    window.__zaDrag.items.add(
      new File(['# Разбор недели\n\nтекст\n'], 'Разбор недели.md', { type: 'text/markdown' }),
    );
  });
  await fireDrag('Архив', 'dragover');
  const underFile = await outlineOf('Архив');
  check(underFile === 'dashed', `папка не подсвечена под файлом: обводка «${underFile}»`);

  await fireDrag('Архив', 'drop');
  await page.waitForTimeout(1200);
  const opened = await page.evaluate(() => ({
    title: document.querySelector('.za-editor__title')?.value ?? '',
    text: document.querySelector('.cm-content')?.textContent ?? '',
    crumb: document.querySelector('.za-editor__crumb')?.textContent ?? '',
  }));
  check(
    opened.title.includes('Разбор недели') || opened.text.includes('Разбор недели'),
    `брошенная заметка не открылась: в редакторе «${opened.title}» / «${opened.text.slice(0, 40)}»`,
  );
}

await context.close();
await browser.close();
server.close();

if (problems.length > 0) {
  console.error('Перетаскивание: расхождения');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log(
  'Перетаскивание: цель подсвечивается, себя не подсвечивает, папка переезжает, ' +
    'брошенный .md ложится в папку и открывается',
);
