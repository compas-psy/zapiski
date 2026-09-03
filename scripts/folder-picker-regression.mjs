/**
 * Настоящий Chromium regression для FolderPicker (MVP hardening-pass).
 *
 * `packages/app/test/folder-picker.test.tsx` (20 тестов, включая один со
 * ВСЕМ настоящим `AppController`) доказывает логику и DOM-структуру в jsdom.
 * Этот прогон — то, что jsdom доказать не может: настоящий правый клик
 * (`contextmenu`), настоящая клавиатура, настоящие координаты для «шеврон —
 * не то же самое место, что название строки».
 *
 * Сценарии — по списку из ТЗ этого прохода:
 *   move note · move folder · вложенная папка · root · одинаковые basename ·
 *   expand/collapse · клик по chevron не выбирает · клик по названию выбирает ·
 *   Escape закрывает · keyboard navigation Tree.
 *
 * «Open with / внешний .md» сюда намеренно не входит: `AppHost.onIntent`,
 * через который приходит это намерение, у веб-оболочки не реализован вовсе
 * (`apps/web/src/` не содержит `onIntent` — это Windows/Android-специфичный
 * порт, см. `packages/app/test/open-file.test.tsx`, где намерение подделывается
 * портом именно потому, что по-другому до него не добраться). Тот же
 * `FolderPickerDialog` в режиме «внешний файл» отличается только значением
 * `current` (`NO_CURRENT_LOCATION` вместо реального пути) — а оно уже
 * покрыто и здесь (root/пустое хранилище), и в jsdom-тестах. Настоящую
 * доставку намерения ОС в браузере физически не воспроизвести.
 *
 * Каждый шаг, от которого зависят дальнейшие проверки, требует своего
 * элемента явно (`requireVisible`) — если элемент не найден, прогон падает
 * с понятной причиной, а не молча пропускает всё, что от него зависело. Это
 * не абстрактная предосторожность: первая редакция скрипта именно так и
 * соврала — прошла «зелёным» на заведомо сломанном коде, потому что шаг
 * «переместить второй раз» тихо не выполнился, а проверка `aria-disabled`
 * внутри него — тоже.
 *
 * Запуск:
 *   pnpm --filter "@zapiski/web..." build
 *   node scripts/folder-picker-regression.mjs [--strict]
 */
import { fileURLToPath } from 'node:url';

import { serveDist } from './static-server.mjs';
import { browserEnv, findChrome } from './find-chrome.mjs';
import { seedWebSession } from './web-session.mjs';

const DIST = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
const PORT = process.env.ZAPISKI_PORT ?? '4203';

const STRICT =
  process.argv.includes('--strict') || process.env.ZAPISKI_FOLDER_PICKER_STRICT === '1';

function skip(reason) {
  if (STRICT) {
    console.error(`folder-picker-regression: ПРОВАЛЕН (строгий режим) — ${reason}`);
    process.exit(1);
  }
  console.log(`folder-picker-regression: ПРОПУЩЕН — ${reason}`);
  process.exit(0);
}

const CHROME = findChrome();
if (CHROME === null) {
  skip('браузер не найден — поставьте Chromium или задайте ZAPISKI_CHROME');
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  skip('нет playwright-core (npm i -D playwright-core)');
}

const server = await serveDist(DIST, Number(PORT)).catch((error) => {
  skip(error.message);
  return null;
});
const URL_BASE = `${server.url}notes/`;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'], env: browserEnv() });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' });
await seedWebSession(page);

const problems = [];
page.on('pageerror', (error) => problems.push(`ошибка страницы: ${error.message}`));

const check = (condition, description, detail) => {
  if (condition) return;
  problems.push(detail === undefined ? description : `${description} — ${detail}`);
};

/** Найден ровно один элемент — иначе прогон падает сразу, с понятной причиной. */
async function requireVisible(locator, description) {
  const count = await locator.count();
  if (count < 1) {
    throw new Error(`${description}: элемент не найден на экране (count=0)`);
  }
  await locator.first().waitFor({ state: 'visible', timeout: 5000 });
  return locator.first();
}

function step(label) {
  console.log(`— ${label}`);
}

const treeitem = (name, opts = {}) => page.getByRole('treeitem', { name, ...opts });

async function createFolder(name, parentRow) {
  if (parentRow) {
    await parentRow.click({ button: 'right' });
    const item = await requireVisible(
      page.getByRole('menuitem', { name: /Новая подпапка/ }),
      `меню «Новая подпапка» для родителя перед созданием «${name}»`,
    );
    await item.click();
  } else {
    const button = await requireVisible(
      page.getByRole('button', { name: /Новая папка/ }),
      'кнопка «Новая папка»',
    );
    await button.click();
  }
  const dialog = await requireVisible(page.getByRole('dialog'), `диалог создания папки «${name}»`);
  const field = await requireVisible(dialog.getByRole('textbox'), `поле имени папки «${name}»`);
  await field.fill(name);
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  await page.waitForTimeout(150);
}

/**
 * «Все заметки» — единственное место, где заметка видна независимо от того,
 * в какую папку её только что перенесли. Открывать FolderPicker для заметки
 * после переноса нужно именно отсюда: строка `.za-row`, взятая в папке,
 * из которой заметку уже увели, больше не существует — список этой папки
 * её не показывает (и это правильное поведение продукта, не дефект).
 */
async function goToAllNotes() {
  // Без exact: счётчик заметок дописывается в имя кнопки без пробела
  // («Все заметки» + «5» = «Все заметки5»), точное совпадение его не найдёт.
  const button = await requireVisible(
    page.getByRole('button', { name: /^Все заметки/ }),
    'кнопка «Все заметки»',
  );
  await button.click();
  await page.waitForTimeout(200);
}

/** Открыть FolderPicker через правый клик → «Переместить» на строке дерева/заметки. */
async function openMoveMenu(rowLocator, description) {
  await rowLocator.click({ button: 'right' });
  const item = await requireVisible(
    page.getByRole('menuitem', { name: 'Переместить', exact: true }),
    `пункт меню «Переместить» для ${description}`,
  );
  await item.click();
  const dialog = await requireVisible(page.getByRole('dialog'), `диалог FolderPicker для ${description}`);
  return dialog;
}

try {
  await page.goto(URL_BASE, { waitUntil: 'networkidle' });
  await (await requireVisible(page.getByRole('button', { name: /Начать|Start/ }), 'кнопка «Начать»')).click();
  await page.waitForTimeout(300);
  await (await requireVisible(page.getByRole('button', { name: /Дальше|Next/ }), 'кнопка «Дальше»')).click();
  await page.waitForTimeout(1000);

  await requireVisible(page.locator('.cm-content'), 'редактор после онбординга');
  await page.keyboard.press('Control+\\');
  await requireVisible(page.locator('.za-library, .za-pane--library'), 'панель Библиотеки');

  // ── Структура: Работа/Архив, Личное/Архив, Архив (корень) ────────────────
  step('создаю структуру папок: Работа, Личное, Архив (корень), Работа/Архив, Личное/Архив');
  await createFolder('Работа');
  await createFolder('Личное');
  await createFolder('Архив');
  const workRow = await requireVisible(treeitem('Работа', { exact: true }), 'строка «Работа» в Библиотеке');
  await createFolder('Архив', workRow);
  const personalRow = await requireVisible(treeitem('Личное', { exact: true }), 'строка «Личное» в Библиотеке');
  await createFolder('Архив', personalRow);

  /*
    Все три папки создаются раскрытыми (родитель авто-раскрывается при
    создании подпапки), поэтому сразу после структуры видно все три «Архив»:
    корневую, «Работа/Архив» и «Личное/Архив» — а не одну.
  */
  const archiveCountAfterCreate = await treeitem('Архив', { exact: true }).count();
  check(
    archiveCountAfterCreate === 3,
    'после создания структуры ожидались ровно три строки «Архив» (корень, «Работа/Архив», «Личное/Архив»)',
    `count=${archiveCountAfterCreate}`,
  );

  // ── 1. Expand/collapse через шеврон ───────────────────────────────────────
  step('expand/collapse: сворачиваю и разворачиваю «Работа» через шеврон');

  const chevron = workRow.locator('.z-tree__chevron');
  await chevron.click();
  await page.waitForTimeout(200);
  const expandedAfterCollapse = await workRow.getAttribute('aria-expanded');
  check(expandedAfterCollapse === 'false', 'клик по шеврону не свернул «Работа»', `aria-expanded=${expandedAfterCollapse}`);
  const hiddenAfterCollapse = await treeitem('Архив', { exact: true }).count();
  check(
    hiddenAfterCollapse === archiveCountAfterCreate - 1,
    'после сворачивания «Работа» её дочерняя «Архив» всё ещё в DOM',
    `count=${hiddenAfterCollapse}, ожидалось ${archiveCountAfterCreate - 1}`,
  );

  await chevron.click();
  await page.waitForTimeout(200);
  const expandedAfterReopen = await workRow.getAttribute('aria-expanded');
  check(expandedAfterReopen === 'true', 'клик по шеврону не развернул «Работа» обратно', `aria-expanded=${expandedAfterReopen}`);

  // ── 2. Клик по chevron не выбирает, клик по названию выбирает ────────────
  step('в FolderPicker: клик по шеврону не закрывает диалог, клик по названию — закрывает и выбирает');
  let dialog = await openMoveMenu(workRow, '«Работа» (проверка chevron vs название)');
  const personalRowInPicker = await requireVisible(
    dialog.getByRole('treeitem', { name: 'Личное', exact: true }),
    '«Личное» внутри FolderPicker',
  );
  const personalChevronInPicker = personalRowInPicker.locator('.z-tree__chevron');
  await personalChevronInPicker.click();
  await page.waitForTimeout(200);
  check(await dialog.isVisible(), 'клик по шеврону в FolderPicker закрыл диалог — должен только раскрывать/сворачивать');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });

  // ── 3. Move folder: «Работа» переносим в «Личное»; себя как цель не предлагает ──
  step('move folder: переношу «Работа» внутрь «Личное»');
  dialog = await openMoveMenu(workRow, '«Работа» (move folder)');
  const workAsOwnTarget = await dialog.getByRole('treeitem', { name: 'Работа', exact: true }).count();
  check(workAsOwnTarget === 0, 'move folder: «Работа» видна как цель переноса самой себя', `count=${workAsOwnTarget}`);
  const personalTarget = await requireVisible(
    dialog.getByRole('treeitem', { name: 'Личное', exact: true }),
    '«Личное» как цель переноса «Работа»',
  );
  await personalTarget.click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  await page.waitForTimeout(300);

  const workAfterMove = await requireVisible(treeitem('Работа', { exact: true }), '«Работа» после переноса под «Личное»');
  const workLevelAfter = await workAfterMove.getAttribute('aria-level');
  check(workLevelAfter === '2', 'после переноса «Работа» под «Личное» её уровень вложенности не изменился', `aria-level=${workLevelAfter}`);

  // ── 4. Move note: выбираю папку «Личное/Архив», создаю в ней заметку ─────
  step('создаю заметку внутри «Личное/Архив», переношу через FolderPicker');
  const nestedArchiveInLibrary = await requireVisible(
    treeitem('Архив', { exact: true }).last(),
    'строка «Архив» под «Личное» в Библиотеке',
  );
  await nestedArchiveInLibrary.click();
  await page.waitForTimeout(300);
  const newNoteButton = await requireVisible(page.getByRole('button', { name: 'Новая заметка' }).first(), 'кнопка «Новая заметка»');
  await newNoteButton.click();
  await page.waitForTimeout(500);
  /*
    Пустую только что созданную заметку приложение удаляет при уходе с нею
    (`discardIfUntouched`, store.ts) — иначе от каждого нажатия «Новая
    заметка» плодились бы файлы «Без названия». Дальше в сценарии есть уходы
    со страницы заметки (`goToAllNotes`), поэтому у заметки должно быть
    настоящее содержимое — иначе тест гоняется не за багом FolderPicker, а за
    собственной пустышкой, которую продукт корректно стирает.
  */
  await requireVisible(page.locator('.cm-content'), 'редактор новой заметки');
  await page.keyboard.type('Заметка для проверки FolderPicker');
  await page.waitForTimeout(300);
  let noteRow = await requireVisible(page.locator('.za-row').first(), 'строка заметки в списке');

  step('первое «Переместить»: заметка сейчас в «Личное/Архив», переношу в корневую «Архив»');
  dialog = await openMoveMenu(noteRow, 'заметки (первый перенос)');
  const disabledOnFirstOpen = await dialog.locator('[aria-disabled="true"]').count();
  check(disabledOnFirstOpen >= 1, 'первое открытие FolderPicker для заметки: текущая папка не помечена disabled', `count=${disabledOnFirstOpen}`);
  // Корневая «Архив» — единственная НЕ вложенная в disabled-родителя цель с этим именем.
  const rootArchiveTarget = await requireVisible(
    dialog.getByRole('treeitem', { name: 'Архив', exact: true }).first(),
    'корневая «Архив» как цель переноса заметки',
  );
  await rootArchiveTarget.click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  await page.waitForTimeout(300);

  /*
    Заметка уехала из папки, которая сейчас открыта в Библиотеке
    («Личное/Архив») — её список эту заметку больше не показывает, это верно
    для продукта и не является дефектом. Чтобы найти строку заметки заново
    независимо от того, в какой папке она теперь лежит, дальше используется
    «Все заметки» — единственное место, где видно вообще всё.
  */
  await goToAllNotes();
  noteRow = await requireVisible(page.locator('.za-row').first(), 'строка заметки в «Все заметки» после первого переноса');

  // ── 5. Одинаковые basename: три «Архив» в разных ветках однозначно различимы ──
  step('одинаковые basename: заметка в корневой «Архив» — среди трёх «Архив» она однозначно узнаётся по своей');
  dialog = await openMoveMenu(noteRow, 'заметки (одинаковые basename)');
  const archivesExact = await dialog.getByRole('treeitem', { name: 'Архив', exact: true }).all();
  check(
    archivesExact.length === 2,
    'ожидались ровно 2 СТРОГО «Архив» в FolderPicker (третья — текущая, её подпись «Архив · сейчас здесь» не совпадает буквально)',
    `count=${archivesExact.length}`,
  );
  const currentArchiveRow = await requireVisible(
    dialog.locator('[aria-disabled="true"]').filter({ hasText: 'Архив' }),
    'текущая «Архив» помечена disabled и подписана «сейчас здесь»',
  );
  check(
    (await currentArchiveRow.innerText()).includes('сейчас здесь'),
    'текущая «Архив» не несёт суффикс «сейчас здесь» — одноимённые папки неразличимы на глаз',
    await currentArchiveRow.innerText(),
  );

  step('второе «Переместить»: «В корень» переносит заметку из корневой «Архив» в true root');
  const rootButton = await requireVisible(dialog.getByRole('button', { name: /В корень/ }), 'кнопка «В корень»');
  await rootButton.click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  await page.waitForTimeout(300);

  await goToAllNotes();
  noteRow = await requireVisible(page.locator('.za-row').first(), 'строка заметки в «Все заметки» после второго переноса');

  // ── 6. Escape закрывает диалог ────────────────────────────────────────────
  step('Escape закрывает FolderPicker');
  dialog = await openMoveMenu(noteRow, 'заметки (проверка Escape)');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(!(await dialog.isVisible().catch(() => false)), 'Escape не закрыл диалог FolderPicker');

  // ── 7. Keyboard navigation: ArrowRight/ArrowLeft раскрывают/сворачивают ──
  step('keyboard navigation: ArrowRight/ArrowLeft переключают раскрытие фокусированного узла');
  dialog = await openMoveMenu(noteRow, 'заметки (keyboard navigation)');
  const expandableRow = await requireVisible(dialog.locator('[aria-expanded]').first(), 'раскрываемый узел в FolderPicker');
  await expandableRow.focus();
  const before = await expandableRow.getAttribute('aria-expanded');
  await page.keyboard.press(before === 'true' ? 'ArrowLeft' : 'ArrowRight');
  await page.waitForTimeout(200);
  const after = await expandableRow.getAttribute('aria-expanded');
  check(after !== before, 'стрелка не переключила раскрытие узла клавиатурой', `${before} → ${after}`);
  await page.keyboard.press('Escape');
} finally {
  await browser.close();
  server.close();
}

if (problems.length > 0) {
  console.error('folder-picker-regression: ПРОВАЛЕН');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}
console.log(
  'folder-picker-regression: пройден — move note/folder, вложенная папка, root, ' +
    'одинаковые basename, expand/collapse, chevron vs название, Escape, keyboard nav',
);
