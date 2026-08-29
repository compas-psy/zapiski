/**
 * Скриншоты для карточки в сторе (RuStore, и не только).
 *
 * Не тест — падений и `check()` тут нет: цель не проверить продукт, а
 * получить реальные снимки экрана телефона с живым, наполненным содержимым,
 * а не с пустым онбордингом. Переиспользует ту же инфраструктуру, что и
 * scripts/walkthrough.mjs (serveDist/findChrome/seedWebSession) — путь через
 * настоящий браузер уже отлажен там, копировать вручную незачем.
 *
 * Запуск:
 *   pnpm --filter "@zapiski/web..." build
 *   node scripts/store-screenshots.mjs [каталог-назначения]
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { serveDist } from './static-server.mjs';
import { browserEnv, findChrome } from './find-chrome.mjs';
import { seedWebSession } from './web-session.mjs';

const DIST = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
const OUT = process.argv[2] ?? fileURLToPath(new URL('../store-screenshots', import.meta.url));
mkdirSync(OUT, { recursive: true });

const CHROME = findChrome();
if (!CHROME) {
  console.error('store-screenshots: браузер не найден — см. find-chrome.mjs');
  process.exit(1);
}

const PORT = process.env.ZAPISKI_PORT ?? '4174';
const served = await serveDist(DIST, PORT);
const URL_BASE = `${served.url}notes/`;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'], env: browserEnv() });
/* 390×844 — экран телефона, тот же вьюпорт, что и в walkthrough.mjs.
   deviceScaleFactor 2 — чтобы скрин не выглядел мыльным на экране Retina/
   Full HD+, куда его будет масштабировать RuStore Консоль. */
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  locale: 'ru-RU',
  hasTouch: true,
});
await seedWebSession(page);
await page.goto(URL_BASE, { waitUntil: 'networkidle' });

const shot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  · ${name}.png`);
};

// ── 1. Первый экран онбординга — уже написан как продающий текст ───────────
await shot('01-onboarding');

const clickByName = async (pattern) => {
  const button = page.getByRole('button', { name: pattern }).first();
  await button.click();
  await page.waitForTimeout(400);
};
await clickByName(/Начать|Start/);
await clickByName(/Дальше|Next/);
await page.waitForTimeout(1000);

// ── 2. Первая заметка: показать разметку по-настоящему, не заглушкой ───────
//
// Редактор — «умный»: Enter внутри списка сам продолжает маркер следующей
// строки. Один большой keyboard.type() с зашитыми «- »/«1. » внутри строки
// сталкивается с этим продолжением и даёт мусор вида «- 1. Текст» или
// заголовок, утянутый в список. Поэтому здесь — блоками, через `typeBlock`:
// на переходе «список → что угодно другое» лишний Enter гасит автопродолжение
// до печати следующего блока, как это делает настоящий человек, а не один
// синтетический поток символов без пауз.
const typeBlock = async (block) => {
  if (block.kind === 'list') {
    for (const [index, item] of block.items.entries()) {
      await page.keyboard.type(index === 0 ? `- ${item}` : item, { delay: 15 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(120);
    }
    // Пустой продолженный маркер — Enter по нему гасит список (как у человека).
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    return;
  }
  const text = block.kind === 'heading' ? `${'#'.repeat(block.level)} ${block.text}` : block.text;
  await page.keyboard.type(text, { delay: 15 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
};

const title = page.locator('.za-editor__title');
if ((await title.count()) > 0) {
  await title.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type('Идеи для нового проекта', { delay: 15 });
}
await page.locator('.cm-content').click();
for (const block of [
  { kind: 'heading', level: 2, text: 'Что уже понятно' },
  { kind: 'para', text: 'Аудитория — **те, кто устал** от заметок, разбросанных по трём приложениям.' },
  { kind: 'para', text: 'Голос продукта: *спокойный*, без лишнего шума.' },
  { kind: 'heading', level: 2, text: 'Дальше по шагам' },
  {
    kind: 'list',
    items: [
      'Набросать структуру разделов',
      'Показать черновик двум-трём людям',
      'Собрать первые отклики',
    ],
  },
]) {
  await typeBlock(block);
}
await page.waitForTimeout(1200);
await shot('02-note-formatted');

// ── 3. Панель форматирования — открытое меню «Aa» ──────────────────────────
const styleButton = page.locator('button[aria-label="Стиль абзаца"]').first();
if ((await styleButton.count()) > 0) {
  await styleButton.click();
  await page.waitForTimeout(500);
  await shot('03-format-menu');
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(300);
}

// ── 4. Библиотека: несколько заметок и папка, а не пустой список ───────────
const back = page.getByRole('button', { name: /Назад|Back/ }).first();
if ((await back.count()) > 0) await back.click().catch(() => undefined);
await page.waitForTimeout(600);

const openLibrary = page.getByRole('button', { name: /Библиотека|Library/ }).first();
if ((await openLibrary.count()) > 0) await openLibrary.click().catch(() => undefined);
await page.waitForTimeout(300);

const newFolder = page.getByRole('button', { name: /Новая папка|New folder/ }).first();
if ((await newFolder.count()) > 0) {
  await newFolder.click();
  await page.waitForTimeout(300);
  await page.getByLabel(/Название папки|Folder name/).fill('Работа');
  await page.getByRole('dialog').getByRole('button', { name: /^Создать$|^Create$/ }).click();
  await page.waitForTimeout(800);
}

const addNote = async (title, blocks) => {
  const newNote = page.getByRole('button', { name: /Новая заметка|New note/ }).first();
  if ((await newNote.count()) === 0) return;
  await newNote.click();
  await page.waitForTimeout(500);
  const t = page.locator('.za-editor__title');
  if ((await t.count()) > 0) {
    await t.click();
    /* Новая заметка получает автоимя «Без названия N» уже в поле — без
       очистки печатаемый заголовок просто дописывался к нему («Без названия
       2Рецепт: ...»), потому что печать стартовала раньше или позже
       асинхронной простановки автоимени. Ctrl+A убирает гонку целиком. */
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type(title, { delay: 12 });
  }
  await page.locator('.cm-content').click();
  for (const block of blocks) await typeBlock(block);
  await page.waitForTimeout(1000);
  const back = page.getByRole('button', { name: /Назад|Back/ }).first();
  if ((await back.count()) > 0) await back.click().catch(() => undefined);
  await page.waitForTimeout(500);
};

await addNote('Список покупок', [
  { kind: 'list', items: ['Кофе', 'Хлеб', 'Позвонить в пекарню'] },
]);
await addNote('Рецепт: тыквенный суп', [
  { kind: 'heading', level: 2, text: 'Ингредиенты' },
  { kind: 'list', items: ['Тыква — 500 г', 'Имбирь', 'Кокосовое молоко'] },
  { kind: 'heading', level: 2, text: 'Шаги' },
  { kind: 'list', items: ['Обжарить лук', 'Добавить тыкву и имбирь', 'Влить бульон и варить 20 минут'] },
]);

await page.waitForTimeout(500);
await shot('04-library-populated');

await browser.close();
served.close();
console.log(`Готово: ${OUT}`);
