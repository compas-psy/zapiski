/**
 * Курсив, подчёркнутый и зачёркнутый доступны пальцем.
 *
 * ── Что просил заказчик ─────────────────────────────────────────────────────
 *
 * «У нас с тобой сильный проёб в меню форматирования — нет кнопок зачёркнутый,
 * подчёркнутый и италик (причём в hot keys есть, но это Android не помогает)».
 * И следом описал поведение по шагам, показав Telegram: «выделил фрагмент →
 * в меню форматирования средний блок подменяется тем центральным, который на
 * скрине → применяю форматирование и общий средний блок возвращается».
 *
 * ── Почему прогон браузерный, а не модульный ────────────────────────────────
 *
 * Модульные тесты панели были зелёными всё это время — и были правы: команды
 * существовали, меню открывалось, разметка ложилась. Не существовало ПУТИ к
 * ним пальцем: курсив и зачёркивание жили под ДОЛГИМ нажатием на «B», а
 * сочетания клавиш на телефоне бесполезны по устройству. Это ровно тот класс
 * дефекта, который видно только на экране: «в DOM есть — на экране нет» и
 * «в DOM есть — рукой не достать».
 *
 * Поэтому здесь всё меряется на телефонном вьюпорте с тачем и настоящими
 * касаниями: кнопка обязана быть видимой целиком, не перекрытой и срабатывать
 * с ОДНОГО касания.
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
const PORT = Number(process.env['ZAPISKI_PORT_INLINE'] ?? 4194);
const STRICT =
  process.argv.includes('--strict') || process.env['ZAPISKI_WALKTHROUGH_STRICT'] === '1';

const skip = (reason) => {
  console.log(`Начертания: пропуск — ${reason}`);
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

for (const device of [
  { name: 'телефон 390', width: 390, height: 844, touch: true },
  { name: 'десктоп 1440', width: 1440, height: 900, touch: false },
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
  await page.waitForTimeout(1000);

  if ((await page.locator('.cm-content').count()) === 0) {
    fail('после онбординга не открылся редактор — форматировать нечего');
    await context.close();
    continue;
  }

  /**
   * Набрать строку и выделить её целиком.
   *
   * Второй раз в текст НЕ кликаем: клик по середине области попадает в пустое
   * место под текстом, и «выделить строку» там выделяет пустоту. Каретка после
   * применённой команды и так стоит в нужной строке.
   */
  const selectLine = async (text) => {
    if (text !== null) {
      await page.locator('.cm-content').click();
      await page.waitForTimeout(200);
      await page.keyboard.type(text);
      await page.waitForTimeout(400);
    }
    await page.keyboard.press('Home');
    await page.keyboard.down('Shift');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(400);
  };

  /** Кнопка панели по подписи — и заодно её геометрия. */
  const buttonInfo = async (label) =>
    page.evaluate((label) => {
      const node = document.querySelector(`.zp-panel button[aria-label="${label}"]`);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      const centre = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        width: Math.round(box.width),
        height: Math.round(box.height),
        inside:
          box.x >= -1 &&
          box.y >= -1 &&
          box.right <= document.documentElement.clientWidth + 1 &&
          box.bottom <= document.documentElement.clientHeight + 1,
        /* Не перекрыта ли: попадание в центр обязано прийти в саму кнопку. */
        reachable: node.contains(centre) || node === centre,
      };
    }, label);

  await selectLine('подчеркну это');

  for (const label of ['Жирный', 'Курсив', 'Подчёркнутый', 'Зачёркнутый']) {
    const info = await buttonInfo(label);
    if (info === null) {
      fail(`на выделении нет кнопки «${label}» — до неё по-прежнему не добраться`);
      continue;
    }
    if (info.width === 0 || info.height === 0) fail(`кнопка «${label}» нулевого размера`);
    if (!info.inside) fail(`кнопка «${label}» вне экрана: ${info.width}×${info.height}`);
    if (!info.reachable) fail(`кнопка «${label}» перекрыта — нажатие уйдёт мимо`);
  }

  /*
   * Три начертания ПОДРЯД, не снимая выделения, — тот самый сценарий, на
   * котором всё ломалось.
   *
   * Заказчик: «нажимаешь I — она исчезает и проявляется полная панель, где
   * нажатие происходит уже не на I, а на B или Aa. В итоге моргание и бесит —
   * фиг выберешь то, что хочешь нажать». Причина механическая: подмена набора
   * двигает соседние кнопки ПОД ПАЛЬЦЕМ. Поэтому здесь меряется не только
   * «разметка легла», но и ГЕОМЕТРИЯ: прямоугольник кнопки обязан остаться
   * тем же самым после нажатия соседней.
   */
  const boxOf = async (label) =>
    page.evaluate((label) => {
      const node = document.querySelector(`.zp-panel button[aria-label="${label}"]`);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width) };
    }, label);

  const before = {
    italic: await boxOf('Курсив'),
    underline: await boxOf('Подчёркнутый'),
    strike: await boxOf('Зачёркнутый'),
  };

  const tap = async (label) => {
    const node = page.locator(`.zp-panel button[aria-label="${label}"]`);
    if ((await node.count()) === 0) {
      fail(`кнопка «${label}» исчезла — нажимать нечего`);
      return false;
    }
    if (device.touch) await node.tap();
    else await node.click();
    await page.waitForTimeout(400);
    return true;
  };

  for (const [label, mark] of [
    ['Зачёркнутый', '.cm-z-strike'],
    ['Курсив', '.cm-z-em'],
    ['Подчёркнутый', '.cm-z-u'],
  ]) {
    if (!(await tap(label))) break;
    if ((await page.locator(mark).count()) === 0) {
      fail(`после нажатия «${label}» разметки на экране нет`);
    }
    /* Панель обязана остаться той же: выделение не снимали. */
    const now = {
      italic: await boxOf('Курсив'),
      underline: await boxOf('Подчёркнутый'),
      strike: await boxOf('Зачёркнутый'),
    };
    for (const key of ['italic', 'underline', 'strike']) {
      if (now[key] === null) {
        fail(`после нажатия «${label}» кнопка ${key} пропала — блок подменился под пальцем`);
        continue;
      }
      const was = before[key];
      if (was && (Math.abs(was.x - now[key].x) > 2 || Math.abs(was.y - now[key].y) > 2)) {
        fail(
          `после нажатия «${label}» кнопка ${key} переехала: была ${was.x}×${was.y}, стала ${now[key].x}×${now[key].y} — палец промахнётся`,
        );
      }
    }
  }

  /* Снятие выделения — и только оно — возвращает обычный набор. */
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);
  if ((await page.locator('.zp-panel button[aria-label="Стиль абзаца"]').count()) === 0) {
    fail('после снятия выделения обычный набор не вернулся');
  }
  if ((await page.locator('.zp-panel button[aria-label="Курсив"]').count()) > 0) {
    fail('без выделения кнопки начертаний остались на панели');
  }

  await context.close();
}

await browser.close();
server.close();

if (problems.length > 0) {
  console.error('Начертания: расхождения');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log('Начертания: B · I · U · S видны на выделении и срабатывают одним касанием');
