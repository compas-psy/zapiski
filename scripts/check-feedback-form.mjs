/**
 * Форма обратной связи в настоящем браузере: дорога к ней и обещание, которое
 * она даёт.
 *
 * ── Зачем браузер, если есть модульные тесты ─────────────────────────────────
 *
 * Модульные тесты монтируют каркас в happy-dom и доходят до формы через
 * `openFeedback`. Этого мало по двум причинам, и обе уже стоили нам круга.
 *
 *  1. **Дорога.** До формы человек добирается кнопкой в «Настройках → О
 *     приложении». Кнопку можно убрать, переименовать или спрятать под
 *     условие — и все модульные тесты останутся зелёными, потому что они не
 *     нажимают её, а вызывают метод. Ровно так однажды пропала Справка:
 *     экран был готов, покрыт тестом и никуда не подключён.
 *  2. **Видимость.** В happy-dom нет раскладки: элемент «есть в дереве» и
 *     «виден на экране» там неразличимы. Блок «Что будет отправлено» — главное
 *     обещание формы («ни строчки из ваших заметок»), и если он уехал за край
 *     или свернулся в ноль, обещание становится ложью, а тест — зелёным.
 *
 * Поэтому здесь: телефон и десктоп, светлая и тёмная тема; путь только
 * нажатиями; проверка прямоугольников, а не наличия.
 *
 * Пропуск — провал: `--strict` обязателен в CI, иначе прогон выдаёт зелёный
 * свет, ничего не проверив.
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
const PORT = Number(process.env['ZAPISKI_PORT'] ?? 4187);
const STRICT =
  process.argv.includes('--strict') || process.env['ZAPISKI_WALKTHROUGH_STRICT'] === '1';

/** Сколько пунктов диагностики обязано быть видно. Столько же в `report.ts`. */
const DIAGNOSTIC_ITEMS = 7;

const skip = (reason) => {
  console.log(`Форма обратной связи: пропуск — ${reason}`);
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

const VIEWPORTS = [
  { name: 'телефон', width: 390, height: 844, hasTouch: true },
  { name: 'десктоп', width: 1440, height: 900, hasTouch: false },
];

for (const viewport of VIEWPORTS) {
  for (const theme of ['light', 'dark']) {
    const where = `${viewport.name}/${theme}`;
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.hasTouch,
      colorScheme: theme,
      locale: 'ru-RU',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    /* Ворота входа проверяет отдельный скрипт; здесь нужен продукт за ними. */
    await seedWebSession(page);
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);

    /* Онбординг проходим так, как проходит человек. */
    for (let step = 0; step < 6; step += 1) {
      const button = page.getByRole('button', { name: /Начать|Дальше|Пропустить/ }).first();
      if ((await button.count()) === 0) break;
      await button.click().catch(() => undefined);
      await page.waitForTimeout(350);
    }

    /* На телефоне онбординг может оставить открытой заметку. */
    for (let step = 0; step < 3; step += 1) {
      if ((await page.getByRole('button', { name: /Открыть библиотеку/ }).count()) > 0) break;
      const back = page.getByRole('button', { name: /^Назад$/ }).first();
      if ((await back.count()) === 0) break;
      await back.click().catch(() => undefined);
      await page.waitForTimeout(300);
    }

    // ── Дорога: только нажатиями ────────────────────────────────────────────
    if ((await page.getByRole('button', { name: /^Настройки$/ }).count()) === 0) {
      const library = page.getByRole('button', { name: /Открыть библиотеку/ }).first();
      if ((await library.count()) > 0) await library.click().catch(() => undefined);
      await page.waitForTimeout(400);
    }
    await page
      .getByRole('button', { name: /^Настройки$/ })
      .first()
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(400);
    await page
      .getByRole('button', { name: /О приложении/ })
      .first()
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(300);

    const open = page.getByRole('button', { name: /Рассказать о проблеме/ }).first();
    check((await open.count()) > 0, `${where}: в «О приложении» нет входа в обратную связь`);
    await open.click().catch(() => undefined);
    await page.waitForTimeout(500);

    const submit = page.getByRole('button', { name: /^Отправить$/ }).first();
    if ((await submit.count()) === 0) {
      problems.push(`${where}: форма не открылась — до неё нет дороги нажатиями`);
      await context.close();
      continue;
    }

    // ── Ни один экран не шире устройства (общее правило продукта) ───────────
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check(overflow <= 1, `${where}: форма шире экрана на ${overflow}px`);

    // ── Обещание формы: блок «Что будет отправлено» виден и со значениями ───
    await page.evaluate(() => {
      const scroller = document.querySelector('.za-scroll');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    await page.waitForTimeout(400);

    const items = await page.evaluate(() =>
      [...document.querySelectorAll('.za-feedback__item')].map((node) => {
        const box = node.getBoundingClientRect();
        return {
          text: (node.textContent ?? '').trim(),
          width: box.width,
          height: box.height,
          value: (node.querySelector('.za-feedback__value')?.textContent ?? '').trim(),
        };
      }),
    );
    check(
      items.length === DIAGNOSTIC_ITEMS,
      `${where}: пунктов диагностики ${items.length}, а обещано ${DIAGNOSTIC_ITEMS}`,
    );
    for (const item of items) {
      check(item.width > 1 && item.height > 1, `${where}: пункт «${item.text}» невидим`);
      /* Значение рядом с названием — иначе согласие даётся вслепую. */
      check(item.value.length > 0, `${where}: у пункта «${item.text}» не показано значение`);
    }

    // ── Снимок экрана: выключен и с предупреждением ─────────────────────────
    const shot = page.getByRole('switch', { name: /Приложить снимок экрана/ }).first();
    check((await shot.count()) > 0, `${where}: тумблера снимка экрана нет`);
    if ((await shot.count()) > 0) {
      check(!(await shot.isChecked()), `${where}: снимок экрана предлагается сам собой`);
    }
    const warning = page.getByText(/На снимке может быть виден текст ваших заметок/).first();
    check((await warning.count()) > 0, `${where}: нет предупреждения про снимок экрана`);

    // ── Кнопка отправки достижима, а не за краем ────────────────────────────
    const box = await submit.boundingBox();
    check(
      box !== null &&
        box.width > 1 &&
        box.height > 1 &&
        box.y >= 0 &&
        box.y + box.height <= viewport.height + 1,
      `${where}: до кнопки «Отправить» нельзя дотянуться`,
    );

    check(errors.length === 0, `${where}: ошибки страницы — ${errors.join('; ')}`);
    await context.close();
  }
}

await browser.close();
server.close();

if (problems.length > 0) {
  console.error('Форма обратной связи: расхождения');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log(
  `Форма обратной связи: дорога нажатиями и блок «Что будет отправлено» ` +
    `в порядке на ${VIEWPORTS.length * 2} сочетаниях экрана и темы`,
);
