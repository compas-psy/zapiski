/**
 * Ни один экран не шире устройства.
 *
 * ── Зачем ───────────────────────────────────────────────────────────────────
 *
 * Заказчик прислал с телефона: «текст не подстраивается под ширину экрана,
 * меню не влазит», «в Настройках экраны также не адаптируются по ширине».
 * Экран редактора занимал 464 px при устройстве 360: за левой кромкой лежала
 * стрелка «назад», за правой — кнопка сведений, статус-строка начиналась вне
 * экрана. Под тысячу модульных тестов не увидели этого и не могли: в happy-dom
 * нет раскладки, ширины и обрезания — там всё «есть в DOM».
 *
 * Этот прогон меряет то, что видит человек, на ширинах, которые бывают у
 * Android: от 320 (компактные и старые аппараты) до планшета. Правило одно и
 * оно универсальное — ничего не должно торчать за кромкой вьюпорта.
 *
 * ── Что считается нарушением, а что нет ─────────────────────────────────────
 *
 * Обрезание бывает СОЗНАТЕЛЬНЫМ: панель форматирования прокручивается вбок,
 * и её дальние кнопки за краем — задумка, а не дефект. Поэтому элемент
 * нарушает правило, только если НИ ОДИН его предок не является горизонтальным
 * скролл-контейнером с настоящей прокруткой. То есть до элемента нельзя
 * добраться никаким жестом — он просто отрезан.
 *
 * Запуск:
 *   pnpm --filter "@zapiski/web..." build
 *   node scripts/check-viewport-fit.mjs [--strict]
 */
import { fileURLToPath } from 'node:url';

import { serveDist } from './static-server.mjs';
import { findChrome } from './find-chrome.mjs';
import { seedWebSession } from './web-session.mjs';

const PORT = process.env.ZAPISKI_PORT_FIT ?? '4177';
const DIST = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
const STRICT = process.argv.includes('--strict') || process.env.ZAPISKI_WALKTHROUGH_STRICT === '1';

/**
 * Ширины, на которых меряем.
 *
 * 320 — нижняя граница живого Android (Galaxy A-серии в режиме крупного
 * шрифта, старые аппараты); 360 — самая частая; 412 — Pixel; 768 — планшет,
 * где включается двухпанельная раскладка и правила другие.
 */
const VIEWPORTS = [
  { width: 320, height: 640, name: 'узкий телефон' },
  { width: 360, height: 740, name: 'обычный телефон' },
  { width: 412, height: 915, name: 'крупный телефон' },
  { width: 768, height: 1024, name: 'планшет' },
];

function skip(reason) {
  if (STRICT) {
    console.error(`ширина экранов: ПРОВАЛЕНА (строгий режим) — ${reason}`);
    process.exit(1);
  }
  console.log(`ширина экранов: ПРОПУЩЕНА — ${reason}`);
  process.exit(0);
}

const CHROME = findChrome();
if (CHROME === null) skip('браузера нет — поставьте Chromium или задайте ZAPISKI_CHROME');

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  skip('нет playwright-core (npm i -D playwright-core)');
}

const served = await serveDist(DIST, PORT).catch((error) => {
  skip(error.message);
  return null;
});

/**
 * Что торчит за кромкой и не добирается прокруткой.
 *
 * Возвращает до десяти худших нарушителей: их обычно один-два корня, а
 * остальное — их дети, унаследовавшие ширину.
 */
const overflowProbe = () => {
  const viewport = document.documentElement.clientWidth;
  const scrollable = (node) => {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const scrolls = style.overflowX === 'auto' || style.overflowX === 'scroll';
      if (scrolls && parent.scrollWidth > parent.clientWidth + 1) return true;
    }
    return false;
  };
  const out = [];
  for (const element of document.querySelectorAll('body *')) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.opacity === '0') continue;
    /* Слои, которые уезжают за экран нарочно: закрытый ящик стоит слева от
       кромки и ждёт своего часа. Признак — трансформация сдвигом. */
    if (style.transform !== 'none' && style.transform.includes('matrix')) {
      const shifted = style.transform.split(',').slice(4).some((part) => Math.abs(parseFloat(part)) > 1);
      if (shifted) continue;
    }
    const over = Math.round(Math.max(box.right - viewport, -box.left));
    if (over <= 1) continue;
    if (scrollable(element)) continue;
    out.push({
      tag: element.tagName.toLowerCase(),
      cls: (element.getAttribute('class') ?? '').slice(0, 48),
      over,
      width: Math.round(box.width),
      text: (element.textContent ?? '').trim().slice(0, 28),
      /* Кнопка за кромкой — это не «некрасиво», это «нельзя нажать». */
      interactive: ['button', 'a', 'input', 'select', 'textarea'].includes(
        element.tagName.toLowerCase(),
      ),
    });
  }
  out.sort((left, right) => right.over - left.over);
  return {
    viewport,
    page: document.scrollingElement.scrollWidth,
    worst: out.slice(0, 10),
  };
};

const problems = [];
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: viewport.width < 700,
    locale: 'ru-RU',
  });
  const page = await context.newPage();
  await seedWebSession(page);
  await page.goto(served.url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  const where = `${viewport.name} ${viewport.width}`;
  const measure = async (screenName) => {
    const report = await page.evaluate(overflowProbe);
    if (report.page > report.viewport + 1) {
      problems.push(`${where}: «${screenName}» едет вбок — страница ${report.page} при экране ${report.viewport}`);
    }
    for (const item of report.worst) {
      const what = item.cls || item.tag;
      const detail = item.text ? ` («${item.text}»)` : '';
      problems.push(
        `${where}: «${screenName}» — ${item.interactive ? 'до элемента нельзя дотянуться' : 'за кромкой'} ${what}${detail}, торчит на ${item.over}px`,
      );
    }
  };

  const clickByName = async (pattern) => {
    const button = page.getByRole('button', { name: pattern }).first();
    if ((await button.count()) === 0) return false;
    await button.click().catch(() => {});
    await page.waitForTimeout(450);
    return true;
  };

  await measure('онбординг');
  await clickByName(/Начать|Start/);
  await clickByName(/Дальше|Next/);
  await page.waitForTimeout(1200);

  /* После онбординга открыт редактор с первой заметкой. */
  if ((await page.locator('.cm-content').count()) === 0) {
    problems.push(`${where}: после онбординга не открылся редактор — мерить нечего`);
    await context.close();
    continue;
  }
  await measure('редактор');

  /* Панель форматирования с раскрытым меню: оно рисуется порталом в body и
     обязано помещаться на экране так же, как всё остальное. */
  const style = page.locator('.zp-panel__btn').first();
  if (await style.count()) {
    await style.click().catch(() => {});
    await page.waitForTimeout(350);
    await measure('редактор с меню панели');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
  }

  /* Настройки — все разделы подряд: каждый со своими контролами. */
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })),
  );
  await page.waitForTimeout(600);

  /*
    Два правила поверх общего — их общее «за кромкой» НЕ ловит, потому что
    формально обрезание там сознательное, за горизонтальной прокруткой.
    Но именно этот вид обрезания заказчик и назвал «не адаптируется по
    ширине»: на тач-устройстве полосы прокрутки нет, и спрятанное за жестом
    неотличимо от несуществующего.

      1. Навигация разделов показывает ВСЕ разделы. Их было восемь на 1077 px,
         на телефоне видно два с половиной — «Безопасность», «Аккаунт» и «О
         приложении» выглядели отсутствующими.
      2. Сегментированный переключатель не режется собственной рамкой: вариант
         «Чернила» обрезался кромкой, и выбрать его было нечем.
  */
  const cropped = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const out = { nav: [], segments: [] };
    for (const item of document.querySelectorAll('.za-settings__nav-item')) {
      const box = item.getBoundingClientRect();
      if (box.right > viewport + 1 || box.left < -1) out.nav.push(item.textContent?.trim() ?? '?');
    }
    for (const group of document.querySelectorAll('.z-segmented')) {
      const bounds = group.getBoundingClientRect();
      for (const option of group.querySelectorAll('.z-segmented__option')) {
        const box = option.getBoundingClientRect();
        if (box.right > bounds.right + 1 || box.left < bounds.left - 1) {
          out.segments.push(option.textContent?.trim() ?? '?');
        }
      }
    }
    return out;
  });
  for (const name of cropped.nav) {
    problems.push(`${where}: раздел настроек «${name}» спрятан за кромкой — на телефоне его как будто нет`);
  }
  for (const name of cropped.segments) {
    problems.push(`${where}: вариант «${name}» обрезан рамкой переключателя — выбрать его нечем`);
  }
  const sections = await page.locator('.za-settings__nav-item').all();
  if (sections.length === 0) problems.push(`${where}: настройки не открылись`);
  for (const section of sections) {
    const name = (await section.textContent())?.trim() ?? '?';
    await section.click().catch(() => {});
    await page.waitForTimeout(350);
    await measure(`настройки · ${name}`);
  }

  await context.close();
}

await browser.close();
served.close();

if (problems.length > 0) {
  console.error('ширина экранов: ПРОВАЛЕНА');
  for (const problem of problems.slice(0, 40)) console.error(`  · ${problem}`);
  if (problems.length > 40) console.error(`  · … и ещё ${problems.length - 40}`);
  process.exit(1);
}

console.log(`ширина экранов: в порядке (${VIEWPORTS.map((v) => v.width).join(', ')})`);
