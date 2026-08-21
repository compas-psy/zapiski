/**
 * Таблица из чужого `.md` открывается таблицей, а не лесенкой.
 *
 * ── Зачем браузер ───────────────────────────────────────────────────────────
 *
 * Заказчик: «я скопировал .md файл с хорошей разметкой в ЗАПИСКИ. Посмотри на
 * скрине, как коряво открылась таблица». Разметка в исходнике безупречная —
 * невыровненная, как её пишут все, кроме нас: `|---|---:|---|`, ячейки не
 * добиты пробелами, в ячейке целое предложение.
 *
 * Модульные тесты (`packages/editor/test/table-view.test.ts`) видят, что в
 * документе появилась `<table>` с нужным числом ячеек. Но «таблица есть в
 * дереве» и «колонки стоят ровно» — разные утверждения, и различает их ТОЛЬКО
 * раскладка: в happy-dom нет ни ширин, ни переносов, ни правой кромки колонки.
 * Ровно этот зазор и дал скриншот заказчика: разметка разбиралась правильно, а
 * на экране расползалась.
 *
 * Поэтому здесь меряются прямоугольники:
 *
 *   · ячейки одной колонки стоят на одной вертикали и одной ширины;
 *   · таблица не вылезает за колонку текста ни на одном вьюпорте;
 *   · длинное предложение переносится ВНУТРИ ячейки, а не растягивает строку;
 *   · тычок в ячейку открывает её же в исходнике — иначе таблицу не поправить.
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
const PORT = Number(process.env['ZAPISKI_PORT'] ?? 4193);
const STRICT =
  process.argv.includes('--strict') || process.env['ZAPISKI_WALKTHROUGH_STRICT'] === '1';

const skip = (reason) => {
  console.log(`Показ таблицы: пропуск — ${reason}`);
  process.exit(STRICT ? 1 : 0);
};

/*
 * Таблица ровно того вида, что пришла от заказчика: разделитель без пробелов,
 * ячейки не добиты, в одной — целое предложение. Ни строчки про людей и их
 * дела: сторожа проверяют показ, а не содержание (ТЗ §7).
 */
const NOTE = [
  '# Проверка показа',
  '',
  '| Параметр | Статус | Рабочие варианты |',
  '|---|---|---:|',
  '| Срок ответа | **Не указано** | от суток до недели, зависит от нагрузки и числа обращений в очереди |',
  '| Формат отчёта | Черновик | таблица или список — на выбор |',
  '',
  'Хвост после таблицы.',
].join('\n');

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

/** Прямоугольники ячеек по колонкам — то, что видит человек. */
const gridOf = (page) =>
  page.evaluate(() => {
    const box = document.querySelector('.cm-z-tableview');
    if (box === null) return null;
    const rows = [...box.querySelectorAll('tr')].map((row) =>
      [...row.children].map((cell) => {
        const rect = cell.getBoundingClientRect();
        return {
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          scrollWidth: cell.scrollWidth,
          clientWidth: cell.clientWidth,
        };
      }),
    );
    const rect = box.getBoundingClientRect();
    const content = document.querySelector('.cm-content');
    const column = content ? content.getBoundingClientRect() : null;
    return {
      rows,
      box: { left: Math.round(rect.left), right: Math.round(rect.right) },
      column: column ? { left: Math.round(column.left), right: Math.round(column.right) } : null,
      lineHeight: Math.round(
        Number.parseFloat(getComputedStyle(document.querySelector('.cm-line')).lineHeight) || 0,
      ),
    };
  });

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

  /*
   * Текст вставляется целиком одним вводом, а курсор остаётся в хвостовом
   * абзаце. Это не удобство, а условие проверки: выравнивание таблицы
   * (`table-format.ts`) срабатывает, когда курсор ИЗ ТАБЛИЦЫ уходит, — а нам
   * нужен исходник ровно такой, каким его приносит чужой файл.
   */
  await content.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(NOTE);
  await page.waitForTimeout(700);

  const source = await page.evaluate(() => {
    const view = document.querySelector('.cm-content');
    return view ? view.textContent : '';
  });

  const grid = await gridOf(page);
  if (grid === null) {
    problems.push(
      `${where}: таблица не нарисована — на месте разметки остались палки ` +
        `(в тексте ${source.includes('|---|') ? 'исходник таблицы есть' : 'исходника таблицы нет'})`,
    );
    await context.close();
    continue;
  }

  // ── Колонки стоят ровно ───────────────────────────────────────────────────
  const columns = Math.max(...grid.rows.map((row) => row.length));
  for (let column = 0; column < columns; column += 1) {
    const cells = grid.rows.map((row) => row[column]).filter(Boolean);
    const lefts = cells.map((cell) => cell.left);
    const widths = cells.map((cell) => cell.width);
    const spreadLeft = Math.max(...lefts) - Math.min(...lefts);
    const spreadWidth = Math.max(...widths) - Math.min(...widths);
    check(
      spreadLeft <= 1,
      `${where}: колонка ${column + 1} разъехалась по вертикали — левые кромки ` +
        `${lefts.join(', ')}`,
    );
    check(
      spreadWidth <= 1,
      `${where}: ячейки колонки ${column + 1} разной ширины — ${widths.join(', ')}`,
    );
  }

  // ── Не вылезает за колонку текста ─────────────────────────────────────────
  if (grid.column !== null) {
    check(
      grid.box.right <= grid.column.right + 2,
      `${where}: таблица вылезла за колонку текста (${grid.box.right} против ` +
        `${grid.column.right})`,
    );
  }

  // ── Длинное предложение переносится внутри ячейки ─────────────────────────
  const longCell = grid.rows[1]?.[2];
  if (longCell === undefined) {
    problems.push(`${where}: во второй строке таблицы нет третьей ячейки`);
  } else {
    check(
      longCell.scrollWidth <= longCell.clientWidth + 1,
      `${where}: длинный текст не переносится и торчит из ячейки ` +
        `(${longCell.scrollWidth} при ширине ${longCell.clientWidth})`,
    );
    check(
      grid.lineHeight === 0 || longCell.height > grid.lineHeight,
      `${where}: ячейка с предложением высотой в одну строку (${longCell.height} при ` +
        `строке ${grid.lineHeight}) — значит текст не перенёсся, а обрезан`,
    );
  }

  // ── Тычок в ячейку открывает её в исходнике ───────────────────────────────
  await page.locator('.cm-z-tableview td').nth(1).click();
  await page.waitForTimeout(400);
  const afterClick = await page.evaluate(() => ({
    widget: document.querySelector('.cm-z-tableview') !== null,
    text: document.querySelector('.cm-content')?.textContent ?? '',
  }));
  check(
    !afterClick.widget,
    `${where}: тычок в ячейку не открыл таблицу на правку — виджет остался на месте`,
  );
  check(
    afterClick.text.includes('Не указано'),
    `${where}: после тычка текст таблицы пропал из документа`,
  );

  // ── Мастер таблицы: он есть только если его ВИДНО ─────────────────────────
  //
  // Заказчик: «проверь мастер таблиц — у меня его нигде нет, он нигде не
  // появляется». Модульные тесты его находили: в дереве он был. На экране
  // никто не смотрел — ровно та же беда, что была со Справкой, и ровно
  // поэтому проверка здесь, в живом браузере.
  //
  // Каретка после тычка выше стоит внутри таблицы, а значит кнопка «Таблица»
  // в панели обязана открывать редактор, а не вставлять вторую таблицу.
  /* Каретка внутри таблицы — значит подпись обязана быть «Изменить таблицу».
     Кнопка, называющаяся одинаково в двух разных состояниях, и есть причина,
     по которой мастер «нигде не появляется». */
  const tableButton = page.locator('[aria-label="Изменить таблицу"]').first();
  const buttonVisible = await tableButton.isVisible().catch(() => false);
  check(
    buttonVisible,
    `${where}: кнопки «Изменить таблицу» нет на экране — либо её нет, либо она ` +
      'не поменяла подпись, встав внутрь таблицы, и мастер не найти',
  );

  if (buttonVisible) {
    const box = await tableButton.boundingBox();
    check(
      box !== null && box.width > 0 && box.height > 0,
      `${where}: кнопка «Изменить таблицу» есть в разметке, но нулевого размера`,
    );
    const view = page.viewportSize();
    check(
      box === null || view === null || (box.x >= 0 && box.x + box.width <= view.width + 1),
      `${where}: кнопка «Изменить таблицу» вылезла за край экрана — до неё не дотянуться`,
    );

    await tableButton.click();
    await page.waitForTimeout(400);

    const dialog = page.locator('.zp-table').first();
    const dialogVisible = await dialog.isVisible().catch(() => false);
    check(dialogVisible, `${where}: мастер таблицы не открылся по нажатию кнопки`);

    if (dialogVisible) {
      const dialogBox = await dialog.boundingBox();
      check(
        dialogBox !== null && dialogBox.width > 0 && dialogBox.height > 0,
        `${where}: мастер таблицы в разметке есть, а на экране нулевой`,
      );
      const view2 = page.viewportSize();
      if (dialogBox !== null && view2 !== null) {
        check(
          dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= view2.height + 1,
          `${where}: мастер таблицы не помещается по высоте: y=${Math.round(dialogBox.y)}, ` +
            `высота ${Math.round(dialogBox.height)} при экране ${view2.height}`,
        );
        check(
          dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= view2.width + 1,
          `${where}: мастер таблицы вылез за край экрана по горизонтали`,
        );
      }
      /* Ручки строк и столбцов — то, ради чего мастер и заводился (§4). */
      const adds = await page.locator('.zp-table__add').count();
      check(adds >= 2, `${where}: в мастере нет ручек добавления строки и столбца (${adds})`);
    }
  }

  await context.close();
}

await browser.close();
server.close();

if (problems.length > 0) {
  console.error('Показ таблицы: расхождения');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log(
  'Показ таблицы: колонки стоят ровно, текст переносится внутри ячейки, ' +
    `тычок открывает исходник (${VIEWPORTS.map((v) => v.name).join(', ')})`,
);
