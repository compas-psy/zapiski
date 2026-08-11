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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = process.env.ZAPISKI_PORT ?? '4173';
const URL_BASE = process.env.ZAPISKI_URL ?? `http://127.0.0.1:${PORT}/`;
const DIST = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
const CHROME =
  process.env.ZAPISKI_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

function skip(reason) {
  console.log(`walkthrough: ПРОПУЩЕН — ${reason}`);
  process.exit(0);
}

if (!existsSync(CHROME)) skip(`нет браузера по пути ${CHROME}`);

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
  server = spawn('npx', ['--yes', 'serve', '-s', DIST, '-l', String(PORT)], { stdio: 'ignore' });
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
const state = async () => ({
  text: await page.$eval('.cm-content', (n) => n.innerText),
  rows: await page.locator('.za-row').count(),
  focused: await page.evaluate(() => document.activeElement?.className ?? ''),
});

const chunks = [
  '# Привет!',
  '\nЯ хотел бы ветром стать и над землей лететь',
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

await browser.close();
server?.kill();

for (const error of errors) problems.push(error);
if (problems.length > 0) {
  console.error('walkthrough: ПРОВАЛЕН');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}
console.log(
  'walkthrough: пройден — онбординг, набор текста, одна заметка, фокус на месте, папки, шифрование',
);
