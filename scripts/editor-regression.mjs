/**
 * Настоящий клавиатурный regression редактора (MVP P0 §13).
 *
 * Модульные тесты (`packages/editor/test/{input,commands,block-transitions}.test.ts`)
 * зовут `listNewline`/`setHeading` напрямую — доказывают правильность самой
 * команды, но не дорогу от нажатия клавиши до неё. Сам этот класс дефектов
 * когда-то уже был найден именно так: скрипт генерации скриншотов столкнулся
 * с тем, что переход «список → следующий блок» в настоящем браузере вёл себя
 * не так, как в синтетических тестах, и потребовал лишний Enter. Здесь то же
 * самое — но с утверждениями, а не обходным путём.
 *
 * Печатает `page.keyboard.type(...)` и `page.keyboard.press('Enter')` —
 * никаких прямых вызовов внутренних команд редактора. Прямой доступ к
 * `EditorView` (через `.cmTile.view`, тот же приём, что и в
 * `check-hotkeys.mjs`) используется ТОЛЬКО для чтения фактического
 * markdown-текста: декорации live-preview прячут служебные символы, и без
 * этого прогон не может доказать, что в файле лежит на самом деле.
 *
 * Запуск:
 *   pnpm --filter "@zapiski/web..." build
 *   node scripts/editor-regression.mjs [--strict]
 */
import { fileURLToPath } from 'node:url';

import { serveDist } from './static-server.mjs';
import { browserEnv, findChrome } from './find-chrome.mjs';
import { seedWebSession } from './web-session.mjs';

const DIST = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
const PORT = process.env.ZAPISKI_PORT ?? '4199';

const STRICT = process.argv.includes('--strict') || process.env.ZAPISKI_EDITOR_REGRESSION_STRICT === '1';

function skip(reason) {
  if (STRICT) {
    console.error(`editor-regression: ПРОВАЛЕН (строгий режим) — ${reason}`);
    process.exit(1);
  }
  console.log(`editor-regression: ПРОПУЩЕН — ${reason}`);
  process.exit(0);
}

const CHROME = findChrome();
if (CHROME === null) {
  skip('браузер не найден — поставьте Chromium или задайте ZAPISKI_CHROME');
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  skip('нет playwright-core (npm i -D playwright-core)');
}

const server = await serveDist(DIST, Number(PORT)).catch((error) => {
  skip(error.message);
  return null;
});
const URL_BASE = `${server.url}notes/`;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'], env: browserEnv() });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' });
await seedWebSession(page);

const problems = [];
page.on('pageerror', (error) => problems.push(`ошибка страницы: ${error.message}`));

const check = (condition, description, detail) => {
  if (condition) return;
  problems.push(detail === undefined ? description : `${description} — ${detail}`);
};

/** Фактический markdown-текст документа — не то, что видно на экране. */
const readDoc = () =>
  page.evaluate(() => document.querySelector('.cm-content').cmTile.view.state.doc.toString());

/** Видимые сейчас заголовки live-preview (BEHAVIOR: cm-z-h1…cm-z-h6). */
const visibleHeadings = () =>
  page.$$eval('[class*="cm-z-h"]', (nodes) => nodes.map((n) => n.textContent?.trim() ?? ''));

try {
  await page.goto(URL_BASE, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Начать|Start/ }).first().click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /Дальше|Next/ }).first().click();
  await page.waitForTimeout(1000);

  const editorReady = (await page.locator('.cm-content').count()) > 0;
  check(editorReady, 'после онбординга не открылся редактор');
  if (!editorReady) throw new Error('нет редактора — дальше проверять нечего');

  const editor = page.locator('.cm-content');
  await editor.click();
  // Чистим то, что онбординг мог оставить в свежей заметке.
  await page.evaluate(() => {
    const view = document.querySelector('.cm-content')?.cmTile?.view;
    view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
  });
  await editor.click();

  // ── 1. Bullet: список → Enter × 2 → paragraph ──────────────────────────────
  await page.keyboard.type('- Один', { delay: 15 });
  await page.keyboard.press('Enter'); // продолжение списка
  await page.keyboard.press('Enter'); // выход из пустого элемента
  await page.keyboard.type('После списка', { delay: 15 });
  let doc = await readDoc();
  check(
    doc.includes('- Один\n\nПосле списка'),
    'bullet: список → Enter × 2 → paragraph не создал top-level абзац',
    JSON.stringify(doc),
  );
  check(!doc.includes('- После списка'), 'bullet: новый абзац остался пунктом списка', JSON.stringify(doc));

  // ── 2. Ordered: та же последовательность ────────────────────────────────────
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('1. Первый', { delay: 15 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('После нумерованного', { delay: 15 });
  doc = await readDoc();
  check(
    doc.includes('1. Первый\n\nПосле нумерованного'),
    'ordered: список → Enter × 2 → paragraph не создал top-level абзац',
    JSON.stringify(doc),
  );

  // ── 3. Task: та же последовательность ───────────────────────────────────────
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- [ ] Задача', { delay: 15 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('После задачи', { delay: 15 });
  doc = await readDoc();
  check(
    doc.includes('- [ ] Задача\n\nПосле задачи'),
    'task: список → Enter × 2 → paragraph не создал top-level абзац',
    JSON.stringify(doc),
  );

  // ── 4. Setext: ловушка и восстановление командой «Обычный текст» ───────────
  //
  // Реальный ввод дефиса ЗАЩИЩЁН уже существующим setext-guard.ts: печатая «-»
  // как первый символ строки сразу под абзацем, человек получает автоматически
  // вставленную пустую строку (BEHAVIOR MVP §1.1) — это не баг, а работающая
  // защита от предыдущей жалобы. Значит, char-by-char вводом сюда специально
  // не попасть: это как раз доказательство того, что защита жива. Реальный же
  // путь получить существующий Setext — импорт/вставка готового markdown, где
  // текст приходит ОДНИМ куском, а не посимвольно. `insertText` (стандартный
  // API `page.keyboard`, тот же класс события, что у автодополнения/paste)
  // воспроизводит именно этот путь, не вызывая внутренних команд редактора.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Заголовок', { delay: 15 });
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('-----');
  await page.waitForTimeout(200);
  doc = await readDoc();
  check(doc.includes('Заголовок\n-----'), 'setext: не удалось воспроизвести ситуацию', JSON.stringify(doc));

  let headings = await visibleHeadings();
  check(
    headings.some((h) => h === 'Заголовок'),
    'setext: заголовок не отрисовался визуально — сценарий не воспроизведён',
    JSON.stringify(headings),
  );

  // Курсор — на строке содержимого; «Обычный текст» через Ctrl+Shift+0
  // (Ctrl+0 в окне БРАУЗЕРА перехватывается сбросом масштаба и до страницы не
  // доходит через раз — тот же факт, что уже задокументирован в
  // check-hotkeys.mjs; второе сочетание доживает до страницы всегда).
  const headingLine = page.locator('.cm-line', { hasText: 'Заголовок' }).first();
  await headingLine.click();
  await page.keyboard.press('Control+Shift+0');
  await page.waitForTimeout(200);

  doc = await readDoc();
  check(
    !doc.includes('-----'),
    'setext: «Обычный текст» не снял подчёркивание',
    JSON.stringify(doc),
  );
  check(doc.includes('Заголовок'), 'setext: «Обычный текст» стёр сам текст, а не только заголовок', JSON.stringify(doc));

  headings = await visibleHeadings();
  check(
    !headings.some((h) => h === 'Заголовок'),
    'setext: после «Обычный текст» заголовок остался виден визуально',
    JSON.stringify(headings),
  );

  // ── 5. Итоговый источник — общий факт-чек ───────────────────────────────────
  doc = await readDoc();
  console.log('editor-regression: итоговый markdown —');
  console.log(
    doc
      .split('\n')
      .map((line) => `  │ ${line}`)
      .join('\n'),
  );
} finally {
  await browser.close();
  server.close();
}

if (problems.length > 0) {
  console.error('editor-regression: ПРОВАЛЕН');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}
console.log(
  'editor-regression: пройден — bullet/ordered/task list-exit создают top-level paragraph, ' +
    'Setext-заголовок снимается «Обычным текстом» настоящей клавиатурой',
);
