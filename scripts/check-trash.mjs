/**
 * Корзина читается в узкой колонке.
 *
 * ── Что просил заказчик ─────────────────────────────────────────────────────
 *
 * Снимок экрана и одна фраза: «Корзина выглядит ужасно». На снимке — заголовок
 * шапки, обрезанный до «К…», метастрока, разъехавшаяся на пять строк, и
 * «Восстановить» на полстроки с подсветкой во всю её высоту.
 *
 * ── Почему сторож браузерный, а не модульный ────────────────────────────────
 *
 * Ни одно из трёх утверждений в happy-dom не проверяется вовсе: там нет ширины
 * колонки, нет переноса строк и нет вычисленной геометрии. Разметка была
 * «правильной» всё это время — рушилась именно раскладка, и увидеть её можно
 * только на экране. Поэтому здесь меряются прямоугольники:
 *
 *   · слово «Корзина» в шапке помещается целиком (`scrollWidth` = `clientWidth`);
 *   · метастрока строки — РОВНО одна строка;
 *   · строка корзины не выше двух строк текста;
 *   · «Восстановить» не съедает половину строки и не тянется во всю высоту.
 *
 * Данные для замера настоящие и заведомо длинные: папка с длинным именем и
 * заметка с длинным заголовком, удалённая через то же меню, что у человека.
 * На коротком «Тест.md» проверка была бы зелёной при любой поломке.
 *
 * Меряется на двух ширинах: трёхпанельный десктоп (колонка списка узкая — там
 * заказчик и увидел) и телефон.
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
const PORT = Number(process.env['ZAPISKI_PORT_TRASH'] ?? 4193);
const STRICT =
  process.argv.includes('--strict') || process.env['ZAPISKI_WALKTHROUGH_STRICT'] === '1';

/** Имена подобраны длинными нарочно — см. заголовок файла. */
const FOLDER = 'Проверка ширины колонки';
const TITLE = 'Заметка с очень длинным названием для проверки переноса';

const skip = (reason) => {
  console.log(`Корзина: пропуск — ${reason}`);
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

/**
 * Геометрия корзины так, как её видит глаз.
 *
 * Возвращает не «есть в DOM», а прямоугольники: высоту строк, влезла ли
 * метастрока в одну строку, сколько места отъело действие.
 */
const probe = () => {
  const round = (value) => Math.round(value * 10) / 10;
  const title = document.querySelector('.za-header__title');
  const rows = [...document.querySelectorAll('.za-row')].map((row) => {
    const meta = row.querySelector('.za-row__meta');
    const action = row.querySelector('.za-row__action');
    const box = row.getBoundingClientRect();
    return {
      text: (row.querySelector('.za-row__title')?.textContent ?? '').slice(0, 24),
      height: round(box.height),
      width: round(box.width),
      meta: meta
        ? {
            text: (meta.textContent ?? '').trim().slice(0, 40),
            /* Одна строка или пять: содержимое выше видимой части — перенос. */
            overflowing: meta.scrollHeight > meta.clientHeight + 1,
            lines: Math.round(meta.scrollHeight / parseFloat(getComputedStyle(meta).lineHeight)),
            /*
              Уехало ли что-нибудь за правую кромку.
              Ужиматься разрешено ровно одному — имени папки, и оно ужимается
              внутри себя. Если наружу лезет сама метастрока, значит съедена
              дата: «Проверка ширины колонки · уд…».
            */
            clipped: meta.scrollWidth > meta.clientWidth + 1,
          }
        : null,
      action: action
        ? { width: round(action.getBoundingClientRect().width), height: round(action.getBoundingClientRect().height) }
        : null,
    };
  });
  return {
    title: title
      ? {
          text: (title.textContent ?? '').trim(),
          clipped: title.scrollWidth > title.clientWidth + 1,
        }
      : null,
    /* Очистка обязана быть на экране — и НЕ в шапке: там она и ужимала
       заголовок до одной буквы. */
    purgeInHeader: [...document.querySelectorAll('.za-header button')].some((button) =>
      (button.textContent ?? '').includes('Очистить'),
    ),
    purgeSomewhere: [...document.querySelectorAll('button')].some((button) =>
      (button.textContent ?? '').includes('Очистить'),
    ),
    rows,
  };
};

for (const device of [
  { name: 'десктоп 1440 (колонка списка узкая)', width: 1440, height: 900, touch: false },
  { name: 'телефон 390', width: 390, height: 844, touch: true },
]) {
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    hasTouch: device.touch,
    isMobile: device.touch,
    locale: 'ru-RU',
  });
  const page = await context.newPage();
  const fail = (message) => problems.push(`${device.name}: ${message}`);

  await seedWebSession(page);
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  for (let step = 0; step < 6; step += 1) {
    const button = page.getByRole('button', { name: /Начать|Дальше|Пропустить/ }).first();
    if ((await button.count()) === 0) break;
    await button.click().catch(() => undefined);
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(800);

  /** Библиотека на телефоне — выдвижная, на десктопе стоит колонкой. */
  const openLibrary = async () => {
    const opener = page.getByRole('button', { name: /Открыть библиотеку|Open library/i }).first();
    if ((await opener.count()) > 0) {
      await opener.click().catch(() => undefined);
      await page.waitForTimeout(400);
    }
  };

  /* Из заметки — назад к списку: библиотека открывается только оттуда. */
  const backToList = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const back = page.getByRole('button', { name: /^Назад$|^Back$/ }).first();
      if ((await back.count()) === 0) break;
      await back.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
  };

  // ── Заведомо длинные данные: папка, заметка в ней, удаление ───────────────
  await backToList();
  await openLibrary();
  const newFolder = page.getByRole('button', { name: /Новая папка|New folder/ }).first();
  if ((await newFolder.count()) === 0) {
    fail('в библиотеке нет «Новая папка» — мерить нечего');
    await context.close();
    continue;
  }
  await newFolder.click();
  await page.waitForTimeout(300);
  await page.getByLabel(/Название папки|Folder name/).fill(FOLDER);
  await page.getByRole('dialog').getByRole('button', { name: /^Создать$|^Create$/ }).click();
  /* Создание папки уводит В НЕЁ — дальше «плюс» кладёт заметку именно туда. */
  await page.waitForTimeout(900);

  const newNote = page.getByRole('button', { name: /^Новая заметка$/ }).first();
  if ((await newNote.count()) === 0) {
    fail('кнопки «Новая заметка» нет — заметку в папке создать нечем');
    await context.close();
    continue;
  }
  await newNote.click();
  await page.waitForTimeout(900);

  const titleField = page.getByLabel(/Название заметки/).first();
  if ((await titleField.count()) === 0) {
    fail('поля заголовка нет — длинное имя задать нечем');
    await context.close();
    continue;
  }
  await titleField.fill(TITLE);
  /* Переименование файла по заголовку идёт с задержкой (RENAME_DELAY_MS): без
     ожидания в корзину уехало бы «Без названия». */
  await page.waitForTimeout(2500);
  await backToList();

  const row = page.locator('.za-row').filter({ hasText: TITLE.slice(0, 20) }).first();
  if ((await row.count()) === 0) {
    fail('созданная заметка не появилась в списке');
    await context.close();
    continue;
  }
  await row.click({ button: 'right' });
  await page.waitForTimeout(400);
  const remove = page.getByRole('menuitem', { name: /^Удалить$/ }).first();
  if ((await remove.count()) === 0) {
    fail('в меню заметки нет «Удалить» — корзину нечем наполнить');
    await context.close();
    continue;
  }
  await remove.click();
  await page.waitForTimeout(900);

  // ── Открыть корзину и померить ────────────────────────────────────────────
  await openLibrary();
  const trash = page.locator('.za-nav__item', { hasText: /Корзина/ }).first();
  if ((await trash.count()) === 0) {
    fail('в библиотеке нет пункта «Корзина»');
    await context.close();
    continue;
  }
  await trash.click();
  await page.waitForTimeout(800);

  const report = await page.evaluate(probe);

  if (report.title === null) {
    fail('шапки корзины нет на экране');
  } else {
    if (report.title.clipped) {
      fail(`заголовок шапки обрезан: видно «${report.title.text}»`);
    }
    if (!report.title.text.includes('Корзина')) {
      fail(`в шапке не «Корзина», а «${report.title.text}»`);
    }
  }
  if (!report.purgeSomewhere) fail('«Очистить корзину» пропала с экрана вовсе');
  if (report.purgeInHeader) {
    fail('«Очистить корзину» вернулась в шапку — она снова ужмёт заголовок');
  }
  if (report.rows.length === 0) fail('в корзине нет ни одной строки — измерять нечего');

  for (const item of report.rows) {
    const where = `строка «${item.text}»`;
    /* Заголовок + метастрока — это две строки текста. Всё, что заметно выше,
       означает перенос: ровно та «высокая» строка со снимка. */
    if (item.height > 96) {
      fail(`${where} высотой ${item.height}px — метастрока переносится`);
    }
    if (item.meta === null) {
      fail(`${where}: метастроки нет`);
    } else {
      if (item.meta.overflowing || item.meta.lines > 1) {
        fail(`${where}: метастрока в ${item.meta.lines} строк — «${item.meta.text}»`);
      }
      if (item.meta.clipped) {
        fail(`${where}: метастрока уехала за кромку — дата не видна: «${item.meta.text}»`);
      }
      if (!/удалена/.test(item.meta.text)) {
        fail(`${where}: в метастроке нет даты удаления — «${item.meta.text}»`);
      }
    }
    if (item.action === null) {
      fail(`${where}: «Восстановить» пропала`);
    } else {
      const share = item.action.width / item.width;
      if (share > 0.45) {
        fail(
          `${where}: «Восстановить» занимает ${Math.round(share * 100)}% ширины (${item.action.width} из ${item.width})`,
        );
      }
      if (item.action.height > item.height - 8) {
        fail(
          `${where}: «Восстановить» растянута во всю высоту строки (${item.action.height} при ${item.height})`,
        );
      }
    }
  }

  await context.close();
}

await browser.close();
server.close();

if (problems.length > 0) {
  console.error('Корзина: расхождения');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log('Корзина: заголовок целиком, метастрока в одну строку, действие не съедает строку');
