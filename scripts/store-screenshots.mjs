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

// ── 0. Обложка: терракота на весь экран, знак и слоган — только для стора ──
//
// Внутри продукта крупная заливка акцентом запрещена нарочно (комментарий в
// OnboardingScreen.tsx: «REBUILD §1.1: терракота допустима только как знак
// сервиса ≤24 px. Крупная заливка ею читается как ошибка или кнопка»). Здесь
// это ограничение снято сознательно: карточка стора — не экран продукта, а
// витрина, и полноэкранный брендовый цвет — обычная практика для первого
// скриншота. Цвет и шрифт не захардкожены на глаз: берём их вычисленными у
// настоящей кнопки «Начать» и настоящего заголовка на этой же странице —
// так обложка гарантированно совпадает с тем, что фактически красит бренд
// сегодня, а не с догадкой по токенам полугодовой давности.
const heroStyle = await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) =>
    /Начать/.test(b.textContent ?? ''),
  );
  const heading = document.querySelector('.za-h1');
  const buttonStyle = button ? getComputedStyle(button) : null;
  const headingStyle = heading ? getComputedStyle(heading) : null;
  return {
    background: buttonStyle?.backgroundColor ?? '#B5503C',
    fontFamily: headingStyle?.fontFamily ?? 'system-ui, sans-serif',
    fontWeight: headingStyle?.fontWeight ?? '650',
  };
});
// Сама марка — тот же путь, что в apps/web/public/promo/assets/zapiski-mark.svg,
// без подложки-квадрата: на заливке в цвет бренда квадрат того же оттенка
// не даёт контраста, а один глиф читается как знак, а не кнопка.
const MARK_PATH =
  'M271.601 95.5359C271.601 98.2689 259.391 156.577 256.531 167.5C249.23 195.393 238.289 218.802 227.876 228.815C221.636 234.814 219.516 234.178 214.819 224.91C205.691 206.897 201.739 175.513 205.247 148.917C207.074 135.071 213.077 115.363 219.069 103.538C222.349 97.066 222.482 96.2808 220.184 96.9449C218.749 97.3584 214.861 98.4778 211.543 99.4316C206.342 100.926 205.122 102.078 202.678 107.806C188.698 140.592 187.277 185.489 199.107 220.701C201.436 227.633 202.76 233.307 202.05 233.307C200.056 233.307 182.944 216.427 176.619 208.223C163.315 190.962 154.034 171.456 148.64 149.412L145.45 136.38L140.092 141.432C137.146 144.211 134.75 147.705 134.766 149.196C134.783 150.687 136.666 157.418 138.95 164.153C141.235 170.889 142.864 176.646 142.573 176.948C142.118 177.419 127.506 174.172 120.036 171.939C118.272 171.412 116.755 172.829 114.634 176.988L111.683 182.77L119.149 184.987C123.255 186.207 127.166 187.204 127.841 187.204C128.515 187.204 134.247 189.203 140.581 191.645C151.893 196.007 152.227 196.281 159.524 207.132C173.574 228.025 189.114 243.119 207.928 254.145C221.9 262.334 227.085 272.22 213.613 264.985C198.594 256.918 186.387 254.19 165.71 254.272C151.912 254.328 144.707 255.037 138.337 256.966C129.372 259.683 106.336 270.371 105.085 272.394C104.693 273.028 105.693 276.136 107.307 279.299L110.241 285.051L118.527 280.151C123.084 277.455 131.998 273.506 138.337 271.376C148.071 268.104 152.326 267.502 165.71 267.502C179.011 267.502 183.347 268.108 192.697 271.275C198.823 273.351 206.838 276.917 210.504 279.2L217.173 283.351L211.612 284.384C200.987 286.359 187.136 294.987 177.937 305.362C173.193 310.714 169.312 315.739 169.312 316.528C169.312 317.319 171.639 319.741 174.484 321.911L179.655 325.854L184.209 320.28C198.777 302.444 212.38 296.377 226.079 301.61C233.604 304.484 233.999 305.498 235.128 324.932C236.459 347.819 230.096 378.931 221.048 393.77C217.089 400.262 217.529 402.796 222.797 403.849C225.274 404.344 228.178 404.749 229.252 404.749C233.451 404.749 242.623 379.598 246.325 357.927C251.082 330.084 248.322 304.186 237.063 271.03L229.997 250.222L237.867 243.03C257.838 224.776 269.38 190.747 280.994 115.89C282.223 107.966 283.542 100.024 283.926 98.2416C284.567 95.255 284.109 95 278.111 95C274.531 95 271.601 95.2406 271.601 95.5359ZM233.97 107.152C225.525 112.892 222.496 124.626 226.788 134.979C231.571 146.513 247.109 134.708 247.109 119.541C247.109 112.533 243.712 103.644 241.034 103.644C239.989 103.644 236.81 105.223 233.97 107.152ZM316.838 111.928C317.339 114.108 318.152 122.441 318.643 130.448C320.692 163.857 310.685 196.961 288.204 231.146C264.737 266.83 255.753 294.551 255.753 331.274C255.753 355.735 258.506 370.114 267.705 393.709L272.108 405L278.697 404.02C282.322 403.48 285.463 402.871 285.676 402.665C285.891 402.459 283.795 397.494 281.017 391.633C274.03 376.885 269.994 360.511 269.16 343.52C268.458 329.209 268.484 329.067 273.047 322.265C283.95 306.013 307.906 290.103 327.949 285.806C340.298 283.158 354.595 283.24 366.863 286.03C372.424 287.295 377.178 288.106 377.427 287.831C377.678 287.557 378.329 284.621 378.877 281.308C379.868 275.303 379.853 275.277 374.359 273.593C364.478 270.564 335.328 270.132 323.33 272.836C309.482 275.957 291.921 284.536 280.605 293.709C275.653 297.723 271.601 300.506 271.601 299.893C271.601 296.452 279.883 274.189 284.81 264.384C295.847 242.422 313.133 222.052 332.322 208.387C344.619 199.632 366.049 189.512 378.931 186.379C384.478 185.03 389.614 183.385 390.345 182.724C391.14 182.005 390.572 179.475 388.936 176.435C386.396 171.721 385.825 171.417 381.123 172.267C366.459 174.921 347.028 183.012 329.437 193.79C323.956 197.147 323.262 197.292 323.958 194.94C330.082 174.224 332.681 154.025 331.707 134.731C331.264 125.953 330.513 117.799 330.039 116.61C329.248 114.624 319.119 107.966 316.888 107.966C316.36 107.966 316.337 109.748 316.838 111.928ZM288.965 123.454C286.895 130.909 287.095 133.703 290.191 140.519C292.959 146.614 300.661 152.628 305.699 152.628C310.176 152.628 311.94 149.65 311.94 142.091C311.94 132.491 307.413 124.67 299.694 120.933C291.602 117.015 290.694 117.228 288.965 123.454ZM168.759 139.726C163.266 146.254 161.475 153.566 163.512 161.134C165.163 167.264 170.55 174.238 173.634 174.238C176.684 174.238 182.098 167.293 183.707 161.317C185.654 154.087 184.553 148.13 179.914 140.781C175.755 134.193 173.587 133.988 168.759 139.726ZM353.1 141.281C348.496 144.901 343.714 154.38 343.666 159.977C343.62 165.365 346.36 172.43 348.869 173.393C351.547 174.42 357.761 171.276 361.875 166.811C369.472 158.566 368.739 139.453 360.789 138.512C358.687 138.264 355.457 139.427 353.1 141.281ZM280.35 175.153C274.113 183.081 277.667 200.643 286.612 206.098C292.414 209.636 292.478 209.622 295.974 203.963C301.668 194.751 299.299 180.985 290.884 174.365C285.876 170.426 283.954 170.57 280.35 175.153ZM226.157 176.885C219.425 181.048 216.454 186.67 216.284 195.569C216.088 205.823 218.278 207.432 227.583 203.879C237.105 200.241 241.66 193.084 241.067 182.689C240.627 174.984 240.609 174.957 235.584 174.567C232.555 174.33 228.789 175.257 226.157 176.885ZM364.143 205.209C361.555 206.334 359.038 208.295 358.55 209.567C355.879 216.527 367.209 224.663 379.571 224.663C385.472 224.663 387.648 223.913 391.349 220.607C395.298 217.079 395.671 216.149 394.226 213.45C393.312 211.742 389.764 208.705 386.342 206.698C379.299 202.571 371.427 202.044 364.143 205.209ZM126.109 207.815C123.089 208.849 120.868 210.662 120.542 212.36C119.773 216.374 124.106 223.72 128.923 226.564C136.842 231.242 156.346 228.362 156.346 222.514C156.346 219.271 147.523 210.034 142.368 207.88C136.77 205.542 132.802 205.526 126.109 207.815ZM324.759 230.814C318.632 234.907 314.827 242.31 314.824 250.138C314.821 254.623 315.465 256.361 317.342 256.937C322.183 258.421 331.089 255.169 336.212 250.046C340.654 245.603 341.357 243.904 341.91 236.262L342.54 227.544H336.097C331.797 227.544 328.026 228.632 324.759 230.814ZM140.663 282.001C138.003 283.427 134.233 287.295 132.284 290.596L128.74 296.598L133.539 299.524C143.475 305.582 157.416 302.101 163.557 292.028C167.392 285.739 167.189 284.196 162.181 281.607C156.463 278.65 146.572 278.831 140.663 282.001ZM343.895 292.573C339.437 293.858 339.18 294.261 340.106 298.566C342.705 310.637 350.124 316.867 361.898 316.867C365.813 316.867 370.174 316.02 371.588 314.985C374.014 313.212 374.026 312.778 371.789 307.422C368.595 299.779 362.895 294.1 356.683 292.374C350.753 290.727 350.275 290.734 343.895 292.573Z';

await page.evaluate(
  ({ background, fontFamily, fontWeight, markPath }) => {
    const overlay = document.createElement('div');
    overlay.id = '__store_hero__';
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      background,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '32px',
      padding: '0 48px',
      zIndex: '99999',
      textAlign: 'center',
    });
    overlay.innerHTML =
      `<svg viewBox="0 0 500 500" width="148" height="148" xmlns="http://www.w3.org/2000/svg">` +
      `<path d="${markPath}" fill="#FBF3E3" fill-rule="evenodd" clip-rule="evenodd"></path></svg>` +
      `<p style="margin:0;color:#FBF3E3;font-family:${fontFamily};font-weight:${fontWeight};` +
      `font-size:28px;line-height:1.3;letter-spacing:-0.01em;max-width:280px;">` +
      `Тихая комната для мыслей</p>`;
    document.body.appendChild(overlay);
  },
  { ...heroStyle, markPath: MARK_PATH },
);
await shot('00-hero');
await page.evaluate(() => document.getElementById('__store_hero__')?.remove());

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
