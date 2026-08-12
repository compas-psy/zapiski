/**
 * Сквозной прогон живого приложения в настоящем браузере.
 *
 * ЗАЧЕМ ОН НУЖЕН, если тестов уже под тысячу. Потому что они проверяли куски,
 * а не путь. Пользователь на первой же заметке получил три дефекта подряд, и
 * ни один автотест их не увидел:
 *
 *   1. при наборе текста заметки размножались — экран держал старый путь
 *      после переименования файла по заголовку;
 *   2. после переименования редактор пересоздавался, фокус уходил в `body`,
 *      и всё напечатанное дальше пропадало молча;
 *   3. на первом экране жирный термин слипался с пояснением, потому что оба
 *      лежали в строчных элементах.
 *
 * Все три видны здесь за двадцать секунд и невидимы в модульном тесте: они
 * живут в стыке «состояние → React → DOM → фокус», который модульный тест не
 * пересекает.
 *
 * Запуск:
 *   pnpm --filter "@zapiski/web..." build
 *   npx serve -s apps/web/dist -l 4173 &
 *   node scripts/walkthrough.mjs
 *
 * Если браузера или playwright-core нет — прогон помечается пропущенным и
 * возвращает 0: он не должен ронять CI там, где его нельзя выполнить. Но
 * молчать о пропуске тоже нельзя, поэтому пропуск печатается явно.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Типы, которые нужны собранному PWA. Остальное отдаём как поток байтов. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * Статика собранного PWA. Любой неизвестный путь отдаёт `index.html`:
 * приложение одностраничное, и маршруты разбирает оно само.
 */
function spawnStatic(root, port) {
  const http = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    let file = join(root, path === '/' ? 'index.html' : path.slice(1));
    if (!existsSync(file) || file.endsWith('/')) file = join(root, 'index.html');
    try {
      response.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  http.listen(Number(port), '127.0.0.1');
  return { kill: () => http.close() };
}

const PORT = process.env.ZAPISKI_PORT ?? '4173';
const URL_BASE = process.env.ZAPISKI_URL ?? `http://127.0.0.1:${PORT}/`;
const DIST = fileURLToPath(new URL('../apps/web/dist', import.meta.url));

/**
 * Где искать браузер.
 *
 * Жёсткий путь тут был бы ошибкой: у разработчика, в песочнице и на раннере CI
 * браузер лежит в трёх разных местах, а со `--strict` ненайденный браузер
 * роняет выкладку. Поэтому список кандидатов, а `ZAPISKI_CHROME` — последнее
 * слово, если ни один не подошёл.
 */
function findChrome() {
  /* Заданный вручную путь тоже проверяется: иначе опечатка в переменной даёт
     не понятное сообщение, а стек из глубины Playwright. */
  if (process.env.ZAPISKI_CHROME) {
    return existsSync(process.env.ZAPISKI_CHROME) ? process.env.ZAPISKI_CHROME : null;
  }

  /* Браузеры Playwright: версия в имени каталога меняется от обновления к
     обновлению, поэтому каталог перебирается, а не прописывается. */
  const pool = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (existsSync(pool)) {
    for (const entry of readdirSync(pool).sort().reverse()) {
      for (const tail of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const candidate = join(pool, entry, tail);
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  /* Системные сборки — то, что есть на раннерах GitHub. */
  for (const candidate of [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const CHROME = findChrome();

/**
 * Строгий режим: пропуск считается падением.
 *
 * Так и надо в CI. Прогон умеет «пропуститься» при любой нехватке — нет
 * браузера, нет статики, не поднялся сервер, — и раньше возвращал при этом
 * НОЛЬ. В CI это выдавало бы зелёный свет, ничего не проверив: худший вид
 * сторожа, потому что он приучает себе верить.
 */
const STRICT = process.argv.includes('--strict') || process.env.ZAPISKI_WALKTHROUGH_STRICT === '1';

function skip(reason) {
  if (STRICT) {
    console.error(`walkthrough: ПРОВАЛЕН (строгий режим) — ${reason}`);
    process.exit(1);
  }
  console.log(`walkthrough: ПРОПУЩЕН — ${reason}`);
  process.exit(0);
}

if (CHROME === null) {
  skip('браузер не найден — поставьте Chromium или задайте ZAPISKI_CHROME');
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  skip('нет playwright-core (npm i -D playwright-core)');
}

/**
 * Статика поднимается сама, если по адресу никто не отвечает.
 *
 * Иначе прогон падает по забытому серверу, а не по продукту, — и это худший
 * вид ложной тревоги: он приучает не верить сторожу.
 */
let server = null;
async function alive() {
  try {
    await fetch(URL_BASE, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}
if (!(await alive())) {
  if (!existsSync(DIST)) skip(`нет собранной статики ${DIST} (pnpm --filter "@zapiski/web..." build)`);
  /* Свой сервер на `node:http`, а не `npx serve`: `npx` тянет пакет из сети, и
     без сети прогон снова молча пропускался бы — притом именно там, где он
     нужнее всего. */
  server = spawnStatic(DIST, PORT);
  for (let attempt = 0; attempt < 40 && !(await alive()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!(await alive())) {
    server.kill();
    skip('не удалось поднять статику');
  }
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });

const problems = [];
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

const check = (condition, description, detail) => {
  if (condition) return;
  problems.push(detail === undefined ? description : `${description} — ${detail}`);
};

await page.goto(URL_BASE, { waitUntil: 'networkidle' });

// ── Онбординг: три шага и курсор в первой заметке ──────────────────────────
const clickByName = async (pattern) => {
  const button = page.getByRole('button', { name: pattern }).first();
  await button.click();
  await page.waitForTimeout(400);
};

// Обещания первого экрана не должны слипаться: заголовок и пояснение —
// разные строки, а не «Заметки — обычные файлыЛюбой редактор их откроет».
const bullets = await page.$$eval('.za-bullet', (nodes) =>
  nodes.map((node) => {
    const title = node.querySelector('.za-card__title');
    const text = node.querySelector('.za-card__text');
    if (!title || !text) return null;
    return Math.round(text.getBoundingClientRect().top - title.getBoundingClientRect().top);
  }),
);
for (const [index, gap] of bullets.entries()) {
  check(gap !== null && gap > 4, `обещание ${index + 1} на первом экране слиплось`, `сдвиг ${gap}px`);
}

await clickByName(/Начать|Start/);
await clickByName(/Дальше|Next/);
await page.waitForTimeout(1200);

const editorReady = (await page.locator('.cm-content').count()) > 0;
check(editorReady, 'после онбординга не открылся редактор');
if (!editorReady) {
  console.log(problems.map((p) => `  · ${p}`).join('\n'));
  await browser.close();
  server?.kill();
  process.exit(1);
}

// ── Набор текста: заметка одна, фокус на месте, текст копится ──────────────
//
// Название набирается в СВОЁ поле, а не первой строкой текста: с ITERATION-1 §1
// заголовок — отдельный ввод, и у новой заметки фокус стоит в нём. Прогон был
// написан до этой правки и с тех пор не запускался ни разу — он честно
// сообщал, что «фокус ушёл из редактора», хотя ушёл он туда, куда и должен.
const state = async () => ({
  text: await page.$eval('.cm-content', (n) => n.innerText),
  rows: await page.locator('.za-row').count(),
  focused: await page.evaluate(() => document.activeElement?.className ?? ''),
});

const title = page.locator('.za-editor__title');
check((await title.count()) > 0, 'поля названия заметки нет (ITERATION-1 §1)');
if (await title.count()) {
  await title.click();
  await page.keyboard.type('Привет!', { delay: 20 });
  await page.waitForTimeout(1400);
}

// Дальше — тело заметки: Enter из названия уводит курсор в начало текста (§1).
await page.locator('.cm-content').click();
const chunks = [
  'Я хотел бы ветром стать и над землей лететь',
  '\nА кто ты?',
];
for (const [index, chunk] of chunks.entries()) {
  await page.keyboard.type(chunk, { delay: 20 });
  // debounce автосохранения 500 мс + тик переименований 1000 мс
  await page.waitForTimeout(1400);
  const now = await state();
  check(
    now.focused.includes('cm-content'),
    `после части ${index + 1} фокус ушёл из редактора`,
    `фокус на «${now.focused || 'body'}»`,
  );
  check(now.rows === 1, `после части ${index + 1} заметок стало ${now.rows}, а должна быть одна`);
  check(
    now.text.includes(chunk.trim()),
    `после части ${index + 1} набранное пропало из редактора`,
    `в редакторе «${now.text.slice(0, 60)}»`,
  );
}

// Файл на диске один, и заголовок стал именем файла (BEHAVIOR §2.2).
const titles = await page.$$eval('.za-row__title', (nodes) => nodes.map((n) => n.textContent));
check(titles.length === 1, `в списке ${titles.length} заметок вместо одной`, titles.join(' · '));
check(titles[0] === 'Привет!', 'заголовок в списке не тот', String(titles[0]));

// ── Папки: создать первую и увидеть её в дереве ────────────────────────────
//
// Пользователь сформулировал это одной строкой: «Папки нельзя создать».
// Возможность была в ядре, а из интерфейса недостижима — меню папки
// открывается долгим нажатием НА ПАПКУ, которых ещё нет. Проверяем именно
// достижимость, а не метод контроллера.
const openLibrary = page.getByRole('button', { name: /Библиотека|Library/ }).first();
if ((await openLibrary.count()) > 0) await openLibrary.click().catch(() => undefined);
await page.waitForTimeout(300);

const newFolder = page.getByRole('button', { name: /Новая папка|New folder/ }).first();
const canCreateFolder = (await newFolder.count()) > 0;
check(canCreateFolder, 'кнопки «Новая папка» нет — первую папку создать нечем');
if (canCreateFolder) {
  await newFolder.click();
  await page.waitForTimeout(300);
  /* Именно по подписи поля: у содержимого редактора тоже роль `textbox`,
     и `.first()` попадал в него — папка создавалась с именем по умолчанию. */
  await page.getByLabel(/Название папки|Folder name/).fill('Практика');
  /* Подтверждение диалога называется «Создать», а не «Новая папка»: у диалога
     своя подпись действия с тех пор, как он получил `confirmLabel`. Сторож
     искал последнюю кнопку с именем «Новая папка», такая на экране осталась
     ровно одна — в библиотеке, под скримом, — и прогон утыкался в таймаут,
     сообщая про перехват указателя вместо «подпись кнопки другая». */
  await page.getByRole('dialog').getByRole('button', { name: /^Создать$|^Create$/ }).click();
  await page.waitForTimeout(800);
  const folders = await page.$$eval('.z-tree__label', (nodes) => nodes.map((n) => n.textContent));
  check(
    folders.some((name) => name?.includes('Практика')),
    'созданная папка не появилась в дереве',
    folders.join(' · ') || 'дерево пусто',
  );
}
// ── Меню папки: до него надо ДОТЯНУТЬСЯ ────────────────────────────────────
//
// Кнопка «Новая папка» была единственным, что я починил в прошлый раз, и
// сторож проверял её же. А меню — «Новая подпапка · Переименовать ·
// Переместить · Удалить» — открыть было нечем: `setFolderMenu` вызывался
// только с `null`. Здесь проверяется настоящий жест: правый клик по узлу
// дерева (на desktop это тот же путь, что long-press на телефоне).
if (canCreateFolder) {
  const node = page.getByRole('treeitem', { name: /Практика/ }).first();
  if ((await node.count()) === 0) {
    check(false, 'созданной папки нет в дереве — меню открывать не на чем');
  } else {
    await node.click({ button: 'right' });
    await page.waitForTimeout(400);
    const items = await page.getByRole('menuitem').allTextContents();
    check(items.length > 0, 'меню папки не открылось долгим нажатием');
    for (const label of ['Новая подпапка', 'Переименовать', 'Переместить', 'Удалить папку']) {
      check(
        items.some((text) => text.includes(label)),
        `в меню папки нет пункта «${label}»`,
        items.join(' · ') || 'меню пусто',
      );
    }

    if (items.length > 0) {
      await page.getByRole('menuitem', { name: 'Переименовать' }).click();
      await page.waitForTimeout(300);
      await page.getByLabel(/Название папки|Folder name/).fill('Супервизии');
      await page.getByRole('button', { name: /^Переименовать$/ }).last().click();
      await page.waitForTimeout(900);
      const folders = await page.$$eval('.z-tree__label', (nodes) =>
        nodes.map((n) => n.textContent),
      );
      check(
        folders.some((name) => name?.includes('Супервизии')),
        'папка не переименовалась из меню',
        folders.join(' · ') || 'дерево пусто',
      );
    }
  }
}
// Создание папки уводит В НЕЁ — так и задумано, иначе непонятно, случилось ли
// что-то. Дальше проверять список заметок бессмысленно: он теперь пуст по делу.

// ── Шифрование туда-обратно ────────────────────────────────────────────────
//
// Последний из семи путей, ради которых этот прогон писался, и единственный,
// который нельзя проверить модульным тестом: иерархия ключей (ТЗ §3.3) живёт
// в стыке «лист установки → контроллер → WebCrypto → замок → редактор», и
// сломаться она может в любом из четырёх мест, каждое из которых по
// отдельности зелёное.
//
// Проверяется ровно то, что обещано человеку: пароль спрашивают ОДИН раз.
{
  const newNote = page.getByRole('button', { name: /Новая заметка|New note/ }).first();
  if ((await newNote.count()) > 0) {
    await newNote.click();
    await page.waitForTimeout(600);
    await page.keyboard.type('# Личное\n\nстрока, которой не должно быть в файле', { delay: 10 });
    await page.waitForTimeout(1500);

    /* На десктопе шифрование живёт в контекстном меню строки списка: панель
       «Инфо» его не предлагает, а `NoteMenu` рисуется только на мобильной
       раскладке. Прогон идёт тем же путём, что и человек за большим экраном. */
    await page.getByRole('button', { name: /Назад|Back/ }).first().click().catch(() => undefined);
    await page.waitForTimeout(600);
    const row = page.locator('.za-row').first();
    check((await row.count()) > 0, 'в списке нет строки заметки — шифровать нечего');
    if ((await row.count()) > 0) {
      await row.click({ button: 'right' });
      await page.waitForTimeout(400);
      const encryptItem = page.getByRole('menuitem', { name: /Зашифровать|Encrypt/ }).first();
      check((await encryptItem.count()) > 0, 'в меню заметки нет пункта «Зашифровать»');

      if ((await encryptItem.count()) > 0) {
        await encryptItem.click();
        await page.waitForTimeout(500);

        // Первый раз — лист просит пароль хранилища.
        const password = page.getByLabel(/^Пароль$|^Password$/).first();
        check((await password.count()) > 0, 'лист шифрования не спросил пароль в первый раз');
        await password.fill('пароль для прогона');
        await page.getByLabel(/Повторите пароль|Repeat the password/).fill('пароль для прогона');
        await page.getByRole('button', { name: /^Зашифровать$|^Encrypt$/ }).last().click();
        await page.waitForTimeout(1200);

        const locked = await page.evaluate(() =>
          document.body.innerText.includes('Заметка зашифрована'),
        );
        const titles = await page.$$eval('.za-row__title', (nodes) => nodes.map((n) => n.textContent));
        check(
          locked || titles.some((name) => name?.includes('Личное')),
          'после шифрования заметка не видна ни в списке, ни как запертая',
          titles.join(' · '),
        );
      }
    }
  }
}

// ── Меню панели: ВИДНО ли его на экране ────────────────────────────────────
//
// Тот самый класс отказов, который прошёл мимо тысячи модульных тестов. У
// панели стоит `overflow-x: auto`, и по CSS вторая ось при этом тоже
// вычисляется в `auto`: панель стала скролл-контейнером высотой 46 px, а меню
// начиналось на 48-й — то есть не было видно ни одним пикселем. В DOM оно при
// этом присутствовало, и все проверки «пункт есть» проходили.
//
// Поэтому проверяется не наличие, а прямоугольник: непустой, внутри вьюпорта и
// не перекрытый. И на двух вьюпортах с ТАЧЕМ: заказчик смотрел телефон и
// планшет, а прежний единственный вьюпорт был 1440×900 с мышью.
for (const [name, viewport] of [
  ['телефон', { width: 390, height: 844 }],
  ['планшет', { width: 1024, height: 768 }],
]) {
  const touch = await browser.newContext({ viewport, hasTouch: true, locale: 'ru-RU' });
  const screen = await touch.newPage();
  await screen.goto(URL_BASE, { waitUntil: 'networkidle' });
  await screen.waitForTimeout(600);

  /* Контекст свой, хранилище чистое — значит снова онбординг. Проходим его
     теми же двумя нажатиями и оказываемся в новой заметке. */
  for (const name of [/Начать|Start/, /Дальше|Next/]) {
    const button = screen.getByRole('button', { name }).first();
    if (await button.count()) {
      await button.click();
      await screen.waitForTimeout(500);
    }
  }
  await screen.waitForTimeout(900);
  if ((await screen.locator('.cm-content').count()) === 0) {
    const row = screen.locator('.za-row').first();
    if (await row.count()) {
      await row.click();
      await screen.waitForTimeout(700);
    }
  }
  if ((await screen.locator('.cm-content').count()) === 0) {
    check(false, `${name}: редактор не открылся, панель проверять не на чем`);
    await touch.close();
    continue;
  }

  const style = screen.locator('button[aria-label="Стиль абзаца"]').first();
  if ((await style.count()) === 0) {
    check(false, `${name}: кнопки «Стиль абзаца» на экране нет`);
    await touch.close();
    continue;
  }

  /* ОДНО касание. Пара `mousedown` + `touchstart` давала два срабатывания:
     меню открывалось и тут же закрывалось само. */
  await style.tap();
  await screen.waitForTimeout(400);

  const layer = screen.locator('.zp-panel__layer');
  if ((await layer.count()) === 0) {
    check(false, `${name}: одно касание не открыло меню (или сразу закрыло)`);
    await touch.close();
    continue;
  }

  const box = await layer.boundingBox();
  check(
    Boolean(box) && box.width > 40 && box.height > 40,
    `${name}: меню есть в DOM, но на экране его нет`,
    `прямоугольник ${JSON.stringify(box)}`,
  );
  if (box) {
    check(
      box.x >= -1 &&
        box.y >= -1 &&
        box.x + box.width <= viewport.width + 1 &&
        box.y + box.height <= viewport.height + 1,
      `${name}: меню вылезло за край экрана`,
      `${JSON.stringify(box)} при ${viewport.width}×${viewport.height}`,
    );
  }

  /* Не перекрыто ли: точка в центре пункта обязана принадлежать меню. */
  const item = screen.locator('.zp-panel__layer [role="menuitem"]').first();
  const itemBox = (await item.count()) ? await item.boundingBox() : null;
  if (itemBox) {
    const mine = await screen.evaluate(
      ([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('.zp-panel__layer')),
      [itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2],
    );
    check(mine, `${name}: центр пункта меню перекрыт чем-то другим`);
  } else {
    check(false, `${name}: в открытом меню нет ни одного пункта`);
  }

  await touch.close();
}

await browser.close();
server?.kill();

for (const error of errors) problems.push(error);
if (problems.length > 0) {
  console.error('walkthrough: ПРОВАЛЕН');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}
console.log(
  'walkthrough: пройден — онбординг, набор текста, одна заметка, фокус на месте, папки, ' +
    'шифрование, меню панели видно на телефоне и планшете',
);
