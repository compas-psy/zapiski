/**
 * Размеры элементов против эталона дизайна — замером в живом браузере.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ `check-design-tokens.mjs`. Тот сверяет ЗНАЧЕНИЯ переменных.
 * Но переменная может быть правильной, а к элементу приложена не та: кнопка
 * брала `--r-lg` (16) вместо радиуса 14, который REBUILD §3 называет прямо —
 * «все кнопки одного уровня одинаковой высоты (44) и радиуса (14)». Токены при
 * этом совпадали с эталоном полностью.
 *
 * Поэтому здесь меряется ОТРИСОВАННЫЙ элемент: сколько пикселей занял, какой
 * радиус получил. Между значением токена и пикселем на экране стоят каскад,
 * наследование и три десятка правил — расходится именно там.
 *
 * ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ. Высоты поля (эталон 46) и пункта навигации
 * (эталон 40) не проверяются: у нас обе 44. Для пункта это требование
 * доступности README §6 «touch-target ≥44 dp», которое сильнее совпадения с
 * макетом; для поля SCREENS §5 сам называет высоту пилюли поиска 44, то есть
 * пакет расходится сам с собой. Оба отклонения названы вслух, а не спрятаны.
 *
 * Запуск:
 *   pnpm --filter "@zapiski/web..." build
 *   node scripts/check-measurements.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const CHROME =
  process.env.ZAPISKI_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (!existsSync(CHROME)) {
  console.log(`размеры: ПРОПУЩЕНО — нет браузера по пути ${CHROME}`);
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.log('размеры: ПРОПУЩЕНО — нет playwright-core');
  process.exit(0);
}

const PORT = process.env.ZAPISKI_PORT ?? '4203';
const URL_BASE = `http://127.0.0.1:${PORT}/`;

const alive = async () => {
  try {
    await fetch(URL_BASE, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
};
let server = null;
if (!(await alive())) {
  server = spawn('npx', ['--yes', 'serve', '-s', 'apps/web/dist', '-l', PORT], {
    stdio: 'ignore',
  });
  for (let i = 0; i < 40 && !(await alive()); i += 1) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!(await alive())) {
    server.kill();
    console.log('размеры: ПРОПУЩЕНО — не удалось поднять статику');
    process.exit(0);
  }
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, locale: 'ru-RU' });
await page.goto(URL_BASE, { waitUntil: 'networkidle' });

const click = async (re) => {
  const button = page.getByRole('button', { name: re }).first();
  if ((await button.count()) === 0) return false;
  await button.click({ force: true, timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  return true;
};
/* Кнопки собираются НА КАЖДОМ шаге пути, а не на одном экране: проверка
   «все кнопки одного уровня одной формы» на выборке из одной кнопки —
   тавтология, которая всегда зелёная. */
const seen = [];
const collect = async () => {
  seen.push(
    ...(await page.evaluate(() =>
      [...document.querySelectorAll('.z-btn:not(.z-btn--text)')].map((el) => ({
        height: Math.round(el.getBoundingClientRect().height),
        radius: Math.round(Number.parseFloat(getComputedStyle(el).borderTopLeftRadius)),
      })),
    )),
  );
};

await collect();
await click(/Начать|Start/);
await collect();
await click(/Дальше|Next/);
await page.waitForTimeout(900);
await collect();

/* Диалог: на нём меряются поле и модалка. */
await click(/Новая папка|New folder/);
await page.waitForTimeout(500);

const problems = [];
const check = (name, got, want) => {
  if (Math.abs(got - want) <= 0.5) return;
  problems.push(`${name}: ${Math.round(got * 10) / 10}, эталон ${want}`);
};

const measured = await page.evaluate(() => {
  const read = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      height: rect.height,
      radius: Number.parseFloat(style.borderTopLeftRadius),
    };
  };
  return {
    /* Обычная кнопка: не текстовая и не иконочная — у них свои размеры. */
    button: read('.z-btn:not(.z-btn--text):not(.z-icon-btn)'),
    field: read('.z-field__control'),
    modal: read('.z-modal'),
    nav: read('.za-nav__item'),
    /* Все кнопки одного уровня — одной высоты и радиуса (REBUILD §3). */
    buttons: [...document.querySelectorAll('.z-btn:not(.z-btn--text)')].map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        height: Math.round(rect.height),
        radius: Math.round(Number.parseFloat(getComputedStyle(el).borderTopLeftRadius)),
      };
    }),
  };
});

if (!measured.button) problems.push('на экране не нашлось ни одной обычной кнопки');
else {
  check('кнопка · высота', measured.button.height, 44);
  check('кнопка · радиус', measured.button.radius, 14);
}
if (measured.field) check('поле · радиус', measured.field.radius, 12);
if (measured.modal) check('модалка · радиус', measured.modal.radius, 24);
if (measured.nav) check('пункт навигации · радиус', measured.nav.radius, 10);

/* Разнобой между кнопками одного уровня — отдельный пункт чек-листа. */
const allButtons = [...seen, ...measured.buttons];
const shapes = new Set(allButtons.map((b) => `${b.height}/${b.radius}`));
if (shapes.size > 1) {
  problems.push(`кнопки одного уровня разной формы: ${[...shapes].join(' · ')}`);
}

await browser.close();
server?.kill();

if (problems.length === 0) {
  console.log(`размеры: совпадают с эталоном (кнопок проверено ${allButtons.length})`);
  process.exit(0);
}
console.error('размеры: РАСХОЖДЕНИЯ');
for (const problem of problems) console.error(`  · ${problem}`);
process.exit(1);
