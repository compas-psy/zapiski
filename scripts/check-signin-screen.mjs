/**
 * Ворота веба в настоящем браузере: вход первым экраном, логотип виден,
 * тарифов нет.
 *
 * ── Что здесь проверяется и почему именно браузером ─────────────────────────
 *
 *  1. **Ворота.** В вебе без аккаунта приложение дальше не пускает: заметки
 *     живут в конкретном браузере, и человек, зашедший с другого устройства,
 *     иначе видит пустой список и считает, что данные пропали. Проверяется
 *     то, что видит человек: первый же экран — вход, и на нём написано ЗАЧЕМ.
 *  2. **Логотип Яндекса.** Кнопка ссылалась на файл, которого нет ни в одной
 *     сборке. В happy-dom картинки не загружаются вовсе, поэтому пустое место
 *     на главной кнопке входа прошло мимо всех модульных тестов и досталось
 *     заказчику. Здесь смотрится `naturalWidth` — то есть картинка правда
 *     приехала.
 *  3. **Тарифы.** Пока оплата выключена, разговора о деньгах нет ни на входе,
 *     ни в настройках.
 *
 * Пропуск здесь — провал: `--strict` обязателен в CI, иначе прогон выдаёт
 * зелёный свет, ничего не проверив.
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
const PORT = Number(process.env['ZAPISKI_PORT'] ?? 4183);
const STRICT = process.argv.includes('--strict') || process.env['ZAPISKI_WALKTHROUGH_STRICT'] === '1';

const skip = (reason) => {
  console.log(`Экран входа: пропуск — ${reason}`);
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
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'], env: browserEnv() });

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

// ── 1. Без аккаунта: первый экран — вход ────────────────────────────────────

const guest = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });

/* Битая ссылка на ассет — это 404 в сети, и ловить её надо здесь, а не
   глазами по пустому месту. */
const missing = [];
guest.on('response', (response) => {
  if (response.status() === 404) missing.push(response.url());
});

await guest.goto(server.url, { waitUntil: 'networkidle' });
await guest.waitForTimeout(600);

const gate = await guest.evaluate(() => {
  const node = document.querySelector('img.za-yandex-logo');
  const box = node?.getBoundingClientRect();
  /* Кнопки, которыми человек может войти: любая живая кнопка на воротах.
     Проверяем ЧИСЛО, а не подпись: подпись меняется вместе с поставщиком, а
     «войти нечем» — дефект при любом поставщике. */
  const doors = [...document.querySelectorAll('button')].filter(
    (button) => !button.disabled && (button.textContent ?? '').trim() !== '',
  );
  return {
    text: document.body.innerText,
    /* Кнопка «назад» на воротах — обман: возвращаться некуда. */
    back: document.querySelectorAll('.za-header button').length,
    doors: doors.length,
    logo:
      node === null
        ? null
        : {
            src: node.getAttribute('src') ?? '',
            natural: node.naturalWidth,
            width: Math.round(box.width),
            height: Math.round(box.height),
          },
  };
});

check(/Аккаунт нужен|Sign in|Войти/i.test(gate.text), 'первым экраном показался не вход');
check(
  /в этом браузере|in that browser/i.test(gate.text),
  'ворота не объясняют, зачем аккаунт — вход без причины читается как сбор адресов',
);
check(gate.back === 0, 'на воротах есть кнопка «назад», ведущая в никуда');
/*
 * Дверь обязана быть хоть одна.
 *
 * Раньше здесь проверялось наличие логотипа Яндекса — и это было правильной
 * проверкой, пока кнопка Яндекса была на экране всегда. После перехода на
 * единый вход СИМПАС её может не быть вовсе, и требование логотипа стало бы
 * требованием держать чужую кнопку ради самой проверки.
 *
 * Заменено на то, что важно и не зависит от поставщика: с ворот должен быть
 * хотя бы один живой способ войти. «Войти нечем» — дефект при любом
 * поставщике, а логотип — только при том, у которого он есть.
 */
check(gate.doors > 0, 'на воротах нет ни одной кнопки входа — войти нечем');

/* Логотип проверяется, ТОЛЬКО если кнопка Яндекса на экране: у неё он
   когда-то не загружался, и это тот самый дефект, ради которого проверка
   заведена. Нет кнопки — нет и требования. */
if (gate.logo !== null) {
  check(
    gate.logo.natural > 0,
    `логотип Яндекса не загрузился (naturalWidth=${gate.logo.natural}, src=${gate.logo.src.slice(0, 60)})`,
  );
  check(
    gate.logo.width >= 12 && gate.logo.height >= 12,
    `логотип занимает ${gate.logo.width}×${gate.logo.height} — его не видно`,
  );
}
check(!/₽|подписк|тариф/i.test(gate.text), 'на экране входа упоминаются деньги, хотя всё бесплатно');

await guest.screenshot({ path: path.join(DIST, '.signin-gate.png') });

// ── 2. С аккаунтом: продукт открывается, тарифов в настройках нет ───────────

const member = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
await seedWebSession(member);
await member.goto(server.url, { waitUntil: 'networkidle' });

const clickByName = async (page, pattern) => {
  await page.getByRole('button', { name: pattern }).first().click();
  await page.waitForTimeout(400);
};

await clickByName(member, /Начать|Start/);
await clickByName(member, /Дальше|Next/);
await member.waitForTimeout(900);

check(
  (await member.locator('.cm-content').count()) > 0,
  'с аккаунтом приложение не открылось — ворота не выпустили',
);

await clickByName(member, /Настройки|Settings/);
const sections = await member.$$eval('.za-tab, .za-nav__item, button, a', (nodes) =>
  nodes.map((node) => node.textContent?.trim() ?? ''),
);
check(
  !sections.some((text) => text === 'ЗАПИСКИ+' || text === 'Zapiski+'),
  'в настройках виден раздел тарифов, хотя оплата выключена',
);

check(missing.length === 0, `страница запросила несуществующие файлы: ${missing.join(', ')}`);

await browser.close();
server.close();

if (problems.length > 0) {
  console.log('Экран входа: расхождения');
  console.log(problems.map((item) => `  · ${item}`).join('\n'));
  process.exit(1);
}
const logoNote =
  gate.logo === null
    ? 'кнопки Яндекса нет — единый вход'
    : `логотип Яндекса виден (${gate.logo.width}×${gate.logo.height})`;
console.log(
  `Экран входа: ворота на месте и объясняют причину, дверей входа ${gate.doors}, ${logoNote}, с аккаунтом продукт открывается, тарифов нет.`,
);
