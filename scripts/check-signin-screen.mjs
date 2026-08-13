/**
 * Экран входа в настоящем браузере: логотип Яндекса виден, тарифов нет.
 *
 * ── Зачем отдельный прогон ──────────────────────────────────────────────────
 *
 * Оба дефекта проходят мимо модульных тестов по одной причине: в happy-dom
 * картинки не загружаются, а вёрстка не считается. Тест видит `<img src="…">`
 * и считает, что иконка есть. Человек видит пустое место на главной кнопке
 * входа — ровно это и увидел заказчик.
 *
 * Здесь проверяется то, что нельзя проверить в DOM:
 *   · картинка ДЕЙСТВИТЕЛЬНО загрузилась (`naturalWidth > 0`) и занимает на
 *     экране непустой прямоугольник;
 *   · ни один запрос страницы не отдал 404 — битая ссылка на ассет ловится
 *     сразу, а не глазами;
 *   · в настройках нет разговора о тарифах, пока оплата выключена.
 *
 * Пропуск здесь — это провал: `--strict` обязателен в CI, иначе прогон
 * выдаёт зелёный свет, ничего не проверив.
 */
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveDist } from './static-server.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = path.join(ROOT, 'apps/web/dist');
const CHROME = process.env['ZAPISKI_CHROME'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
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
await access(CHROME).catch(() => skip(`нет браузера по пути ${CHROME}`));
await access(path.join(DIST, 'index.html')).catch(() =>
  skip('нет собранной статики (pnpm --filter "@zapiski/web..." build)'),
);

const server = await serveDist(DIST, PORT).catch((error) => skip(error.message));
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

/* Битая ссылка на ассет — это 404 в сети, и ловить её надо здесь, а не
   глазами по пустому месту. */
const missing = [];
page.on('response', (response) => {
  if (response.status() === 404) missing.push(response.url());
});

await page.goto(server.url, { waitUntil: 'networkidle' });

const clickByName = async (pattern) => {
  await page.getByRole('button', { name: pattern }).first().click();
  await page.waitForTimeout(400);
};

/* Онбординг: два шага до библиотеки. */
await clickByName(/Начать|Start/);
await clickByName(/Дальше|Next/);
await page.waitForTimeout(1000);

/* Настройки → Аккаунт → Войти. Тот же путь, которым идёт человек. */
await page.getByRole('button', { name: /Настройки|Settings/ }).first().click();
await page.waitForTimeout(500);

const sections = await page.$$eval('.za-tab, .za-nav__item, button, a', (nodes) =>
  nodes.map((node) => node.textContent?.trim() ?? ''),
);
check(
  !sections.some((text) => text === 'ЗАПИСКИ+' || text === 'Zapiski+'),
  'в настройках виден раздел тарифов, хотя оплата выключена',
);

await page.getByRole('button', { name: /^Аккаунт$|^Account$/ }).first().click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: /Войти|Sign in/ }).first().click();
await page.waitForTimeout(800);

const logo = await page.evaluate(() => {
  const node = document.querySelector('img.za-yandex-logo');
  if (!node) return null;
  const box = node.getBoundingClientRect();
  return {
    src: node.getAttribute('src') ?? '',
    natural: node.naturalWidth,
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
});

check(logo !== null, 'на кнопке входа нет элемента логотипа');
if (logo !== null) {
  check(logo.natural > 0, `логотип Яндекса не загрузился (naturalWidth=${logo.natural}, src=${logo.src.slice(0, 60)})`);
  check(logo.width >= 12 && logo.height >= 12, `логотип занимает ${logo.width}×${logo.height} — его не видно`);
}

/* Разговора о тарифах на экране входа тоже быть не должно. */
const text = await page.evaluate(() => document.body.innerText);
check(!/₽|подписк|тариф/i.test(text), 'на экране входа упоминаются деньги, хотя всё бесплатно');

check(missing.length === 0, `страница запросила несуществующие файлы: ${missing.join(', ')}`);

await page.screenshot({ path: path.join(ROOT, 'apps/web/dist/.signin-check.png') });
await browser.close();
server.close();

if (problems.length > 0) {
  console.log('Экран входа: расхождения');
  console.log(problems.map((item) => `  · ${item}`).join('\n'));
  process.exit(1);
}
console.log(
  `Экран входа: логотип Яндекса виден (${logo.width}×${logo.height}, исходник ${logo.natural}px), тарифов нет, 404 нет.`,
);
