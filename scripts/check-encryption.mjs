#!/usr/bin/env node
/**
 * Сторож флоу шифрования — в настоящем браузере, от начала до конца.
 *
 * ── Зачем ───────────────────────────────────────────────────────────────────
 *
 * Заказчик прошёл шифрование руками и вернул четыре пункта: «пароль не помню и
 * восстановить нельзя», «переключатель биометрии не срабатывает», «кнопка
 * сменить пароль не активируется», «должно работать чётко и предсказуемо».
 * Под ними лежало шесть разных дефектов, и ни один не был виден модульным
 * тестам: они проверяли контроллер, а ломались ПУТИ к нему.
 *
 * Самый показательный: кнопка «⋯» в шапке заметки на десктопе не открывала
 * ничего — меню монтировалось только под `isMobile`, а кнопка рисовалась
 * всегда. Через это меню лежал единственный путь к «Зашифровать» и «Снять
 * шифрование» из открытой заметки, то есть с Windows шифрование было
 * недостижимо. В дереве компонентов всё на месте, на экране — ничего.
 *
 * Отсюда правило этого файла: каждая проверка утверждает то, что ВИДНО и
 * НАЖИМАЕТСЯ, а не то, что лежит в разметке. Выключенная кнопка засчитывается
 * только вместе с написанной рядом причиной: кнопка без объяснения
 * неотличима от сломанной — ровно так и выглядел отказ смены пароля.
 */
import { fileURLToPath } from 'node:url';

import { serveDist } from './static-server.mjs';
import { browserEnv, findChrome } from './find-chrome.mjs';
import { seedWebSession } from './web-session.mjs';

const PORT = process.env.ZAPISKI_PORT ?? '4176';
const DIST = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
const PASSWORD = 'пароль12345';
const HINT = 'первая строка песни';

const STRICT = process.argv.includes('--strict') || process.env.ZAPISKI_WALKTHROUGH_STRICT === '1';

function skip(reason) {
  if (STRICT) {
    console.error(`шифрование: ПРОВАЛЕН (строгий режим) — ${reason}`);
    process.exit(1);
  }
  console.log(`шифрование: ПРОПУЩЕН — ${reason}`);
  process.exit(0);
}

const CHROME = findChrome();
if (CHROME === null) skip('браузер не найден — поставьте Chromium или задайте ZAPISKI_CHROME');

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  skip('нет playwright-core (npm i -D playwright-core)');
}

const server = await serveDist(DIST, PORT).catch((error) => {
  skip(error.message);
  return null;
});

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox'],
  env: browserEnv(),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' });
await seedWebSession(page);

const problems = [];
const check = (condition, description, detail) => {
  if (condition) return;
  problems.push(detail === undefined ? description : `${description} — ${detail}`);
};

const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

/** Поле по подписи — так же, как его находит человек. */
const field = (label, scope = '') =>
  page.locator(`${scope} .z-field`.trim(), {
    has: page.locator(`.z-field__label:text-is("${label}")`),
  });

const fill = async (label, value, scope = '') => {
  await field(label, scope).first().locator('input').fill(value);
  await page.waitForTimeout(120);
};

/** Видна ли подпись под полем — причина, по которой ввод не принят. */
const messageUnder = async (label, scope = '') =>
  field(label, scope)
    .first()
    .locator('.z-field__message')
    .first()
    .innerText()
    .catch(() => '');

await page.goto(server.url, { waitUntil: 'networkidle' });

// ── Онбординг и заметка ───────────────────────────────────────────────────
const clickByName = async (pattern) => {
  await page.getByRole('button', { name: pattern }).first().click();
  await page.waitForTimeout(400);
};
await clickByName(/Начать|Start/);
await clickByName(/Дальше|Next/);
await page.waitForTimeout(1500);

if ((await page.locator('.cm-content').count()) === 0) {
  console.error('шифрование: ПРОВАЛЕН — после онбординга не открылся редактор');
  await browser.close();
  server.close();
  process.exit(1);
}

await page.locator('.za-editor__title').click();
await page.keyboard.type('Секрет', { delay: 15 });
await page.locator('.cm-content').click();
await page.keyboard.type('тайная строка', { delay: 15 });
await page.waitForTimeout(1600);

// ── 1. «Ещё» в шапке заметки открывает действия ───────────────────────────
//
// На десктопе меню не монтировалось вовсе: `isMobile` в условии, кнопка без
// условия. Проверяется появление листа на экране, а не состояние в React.
await page.locator('.za-header__actions button').last().click();
await page.waitForTimeout(600);
const sheetOpen = await page.locator('.z-sheet, .z-modal, [role=dialog]').count();
check(sheetOpen > 0, 'кнопка «Ещё» в шапке заметки не открыла ничего');

const sheetText = sheetOpen
  ? await page.locator('.z-sheet, .z-modal, [role=dialog]').first().innerText()
  : '';
check(sheetText.includes('Зашифровать'), 'в меню заметки нет «Зашифровать»', sheetText.slice(0, 120));

// ── 2. Лист шифрования: пароль, повтор, подсказка ─────────────────────────
await page.getByText('Зашифровать', { exact: true }).first().click();
await page.waitForTimeout(700);

const encryptButton = page.getByRole('button', { name: /^Зашифровать$/ }).last();
check(await encryptButton.isDisabled(), 'кнопка «Зашифровать» активна при пустых полях');

await fill('Пароль', 'корот');
const shortMessage = await messageUnder('Пароль');
check(
  shortMessage.length > 0,
  'короткий пароль не объяснён: кнопка выключена и ни слова почему',
  JSON.stringify(shortMessage),
);

await fill('Пароль', PASSWORD);
await fill('Повторите пароль', PASSWORD);
await fill('Подсказка (по желанию)', HINT);
check(!(await encryptButton.isDisabled()), 'кнопка «Зашифровать» не включилась при верных полях');
await encryptButton.click();
await page.waitForTimeout(2500);

// ── 3. Замок: подсказка видна СРАЗУ, до первой попытки ────────────────────
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.locator('.za-row').filter({ hasText: 'Секрет' }).first().click();
await page.waitForTimeout(1500);

const lockedBefore = await page
  .locator('.za-locked')
  .innerText()
  .catch(() => '');
check(lockedBefore.length > 0, 'после перезагрузки зашифрованная заметка не показала замок');
check(
  lockedBefore.includes(HINT),
  'подсказка не видна до первой попытки — а она и заводится, чтобы вспомнить пароль',
  JSON.stringify(lockedBefore.slice(0, 160)),
);
check(
  lockedBefore.includes('Не помню пароль'),
  'на замке нет ответа тому, кто пароль забыл',
  JSON.stringify(lockedBefore.slice(0, 160)),
);

// ── 4. Неверный пароль: сказано словами, данные целы ──────────────────────
await page.locator('.za-locked input').fill('не тот пароль');
await page.getByRole('button', { name: /Разблокировать/ }).first().click();
await page.waitForTimeout(1500);
const afterWrong = await page.locator('.za-locked').innerText();
check(afterWrong.includes('Пароль не подошёл'), 'неверный пароль не объяснён', afterWrong.slice(0, 120));

// ── 5. Верный пароль открывает заметку ────────────────────────────────────
await page.locator('.za-locked input').fill(PASSWORD);
await page.getByRole('button', { name: /Разблокировать/ }).first().click();
await page.waitForTimeout(2500);
check((await page.locator('.cm-content').count()) > 0, 'верный пароль не открыл заметку');
const bodyText = await page.locator('.cm-content').innerText().catch(() => '');
check(bodyText.includes('тайная строка'), 'текст после разблокировки не тот', bodyText.slice(0, 80));

// ── 5б. Шифрование ПОСЛЕ перезапуска — состояние, которого здесь не было ──
//
// Это и есть отказ, с которым пришёл заказчик: «при попытке шифровать выдаётся
// ошибка». Пароль хранилища задаётся один раз (ТЗ §3.3), ключ живёт только в
// памяти сеанса — значит после каждого перезапуска существует состояние
// «пароль есть, ключа нет». Лист шифрования его не знал: он спрашивал «есть ли
// соль на диске», а `encryptNote` требует ключ, и человек получал «Не удалось
// зашифровать заметку · Повторить». Повтор повторял отказ, а ввести пароль было
// негде — его спрашивает только замок УЖЕ зашифрованной заметки.
//
// Прогон этого не видел по той же причине, по какой не видели тесты: он шифровал
// одну заметку в том же сеансе, где задал пароль, а перезагружал страницу ПОСЛЕ.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const newNote = page.getByRole('button', { name: /Новая заметка|New note/ }).first();
check((await newNote.count()) > 0, 'после перезагрузки нечем создать заметку');
await newNote.click();
await page.waitForTimeout(1200);
await page.locator('.za-editor__title').click();
await page.keyboard.type('Вторая тайна', { delay: 15 });
await page.locator('.cm-content').click();
await page.keyboard.type('вторая тайная строка', { delay: 15 });
await page.waitForTimeout(1600);

await page.locator('.za-header__actions button').last().click();
await page.waitForTimeout(600);
await page.getByText('Зашифровать', { exact: true }).first().click();
await page.waitForTimeout(900);

const lockedSheet = page.locator('.z-sheet, .z-modal, [role=dialog]').first();
const lockedSheetText = await lockedSheet.innerText().catch(() => '');
check(
  lockedSheetText.includes('Хранилище закрыто'),
  'закрытое хранилище не названо: лист молчит о том, почему шифрование не пойдёт',
  JSON.stringify(lockedSheetText.slice(0, 160)),
);
const unlockAndEncrypt = page.getByRole('button', { name: /^Разблокировать и зашифровать$/ }).last();
check(
  (await unlockAndEncrypt.count()) > 0,
  'в закрытом хранилище нет кнопки, которая открывает и шифрует за один раз',
);
// Повтора пароля здесь быть не должно: пароль уже существует.
check(
  (await field('Повторите пароль').count()) === 0,
  'у существующего пароля спрашивают повтор — значит мы не знаем, чего просим',
);

/*
 * Дальше — только если поле пароля вообще появилось.
 *
 * Без этой развилки прогон с прежним поведением падал `TimeoutError` на
 * `locator.fill`, то есть жаловался на локатор вместо продукта. Отчёт обязан
 * называть отказ словами: «поля пароля нет» — это и есть тот тупик, из которого
 * человек не может выйти.
 */
const vaultPasswordField = field('Пароль');
if ((await vaultPasswordField.count()) === 0) {
  check(false, 'в закрытом хранилище нет поля пароля — зашифровать нечем, выхода из тупика нет');
} else {
  // Неверный пароль обязан быть назван словами, а не «не удалось зашифровать».
  await fill('Пароль', 'совсем не тот');
  await unlockAndEncrypt.click();
  await page.waitForTimeout(2500);
  const afterWrongVault = await lockedSheet.innerText().catch(() => '');
  check(
    afterWrongVault.includes('Пароль не подошёл'),
    'неверный пароль хранилища не объяснён в листе шифрования',
    JSON.stringify(afterWrongVault.slice(0, 160)),
  );

  await fill('Пароль', PASSWORD);
  await page.getByRole('button', { name: /^Разблокировать и зашифровать$/ }).last().click();
  await page.waitForTimeout(3000);
  check(
    (await page.locator('.z-sheet, .z-modal, [role=dialog]').count()) === 0,
    'лист шифрования не закрылся после верного пароля',
  );
  const secondLocked = await page
    .locator('.za-editor__lock, .za-locked, .za-editor')
    .innerText()
    .catch(() => '');
  check(
    (await page.locator('.za-row').filter({ hasText: 'Вторая тайна' }).count()) > 0,
    'вторая заметка исчезла из списка после шифрования',
    JSON.stringify(secondLocked.slice(0, 120)),
  );
}

/*
 * Убрать лист со дороги, чем бы дело ни кончилось.
 *
 * Иначе оставшийся открытым лист перехватывает нажатия, и следующие разделы
 * падают таймаутом клика — то есть прогон рапортует о поломке настроек, хотя
 * сломано шифрование. Одна забытая модалка так превращает точный отчёт в
 * загадку; проверено на себе при первой же проверке этого сторожа.
 */
if ((await page.locator('.z-sheet, .z-modal, [role=dialog]').count()) > 0) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
}

// ── 6. Настройки → Безопасность ───────────────────────────────────────────
await page.getByRole('button', { name: 'Настройки', exact: true }).first().click();
await page.waitForTimeout(1000);
await page.getByRole('button', { name: /Безопасность/ }).first().click();
await page.waitForTimeout(800);

/*
 * Поле пароля обязано стоять ВЫШЕ тумблера биометрии.
 *
 * Оно стояло ниже, и естественный жест — сначала переключить — уходил в
 * `setBiometricsEnabled(true, '')`: ключ выводился из пустой строки и уезжал
 * в защищённый модуль. Тумблер вставал в «включено», палец не открывал
 * ничего. Порядок на экране здесь — часть починки, поэтому он и проверяется.
 */
const biometricsRow = page.locator('.za-field-row', {
  has: page.locator('text=Разблокировать биометрией'),
});
if (await biometricsRow.count()) {
  const geometry = await page.evaluate(() => {
    const label = [...document.querySelectorAll('.z-field__label')].find(
      (node) => node.textContent.trim() === 'Пароль хранилища',
    );
    const toggle = [...document.querySelectorAll('.za-field-row')].find((node) =>
      node.textContent.includes('Разблокировать биометрией'),
    );
    if (!label || !toggle) return null;
    return {
      password: Math.round(label.getBoundingClientRect().top),
      toggle: Math.round(toggle.getBoundingClientRect().top),
      disabled: toggle.querySelector('input')?.disabled ?? null,
    };
  });
  check(geometry !== null, 'в «Безопасности» не нашлись поле пароля и тумблер биометрии');
  if (geometry) {
    check(
      geometry.password < geometry.toggle,
      'поле пароля хранилища стоит НИЖЕ тумблера биометрии — включение уйдёт с пустым паролем',
      JSON.stringify(geometry),
    );
    check(
      geometry.disabled === true,
      'тумблер биометрии нажимается при пустом поле пароля',
      JSON.stringify(geometry),
    );
  }
} else {
  /* Платформа без модуля обязана СКРЫВАТЬ тумблер (BEHAVIOR §5.1) — это
     законный исход, и молчать о нём нельзя: иначе проверка выглядит пройденной. */
  console.log('  · биометрии в этом браузере нет — тумблер скрыт, проверка порядка пропущена');
}

// ── 7. Смена пароля: отказ обязан назвать причину ─────────────────────────
await page.getByRole('button', { name: /^Сменить пароль$/ }).first().click();
await page.waitForTimeout(600);

const submitButton = page.locator('.z-modal .z-overlay__footer button').last();
await fill('Текущий пароль', PASSWORD, '.z-modal');
await fill('Новый пароль', 'коротк', '.z-modal');
await fill('Повторите пароль', 'коротк', '.z-modal');
check(await submitButton.isDisabled(), 'кнопка смены активна при новом пароле короче восьми');
const shortWhy = await messageUnder('Новый пароль', '.z-modal');
check(
  shortWhy.length > 0,
  'короткий новый пароль не объяснён — ровно это заказчик увидел как «кнопка не активируется»',
  JSON.stringify(shortWhy),
);

await fill('Новый пароль', 'новыйпароль99', '.z-modal');
await fill('Повторите пароль', 'новыйпароль9', '.z-modal');
check(await submitButton.isDisabled(), 'кнопка смены активна при несовпавшем повторе');
const mismatchWhy = await messageUnder('Повторите пароль', '.z-modal');
check(mismatchWhy.length > 0, 'несовпавший повтор не объяснён', JSON.stringify(mismatchWhy));

await fill('Повторите пароль', 'новыйпароль99', '.z-modal');
check(
  !(await submitButton.isDisabled()),
  'кнопка смены не включилась, когда все три поля заполнены верно',
);

// ── 8. Снятие шифрования достижимо и просит пароль ────────────────────────
await page.getByRole('button', { name: /Отмена/ }).first().click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: /Назад/ }).first().click();
await page.waitForTimeout(800);
/*
 * Заметка обязана ОСТАТЬСЯ зашифрованной после прогулки по приложению.
 *
 * Проверка стоит здесь, а не в конце, потому что иначе сторож врёт о причине:
 * потерявшая шифрование заметка показывает меню обычной, и отсутствие «Снять
 * шифрование» выглядит дефектом меню, хотя дефект в записи файла. Так и было:
 * выход из заметки запирал её, а редактор при возврате сохранял текст без
 * ключа — открытым, поверх контейнера.
 */
const rowsNow = await page.$$eval('.za-row', (ns) => ns.map((n) => n.textContent.trim()));
check(
  rowsNow.some((row) => row.includes('Зашифровано')),
  'заметка потеряла шифрование, пока человек ходил по приложению — на диск лёг открытый текст',
  JSON.stringify(rowsNow),
);

await page.locator('.za-row').filter({ hasText: 'Секрет' }).first().click({ button: 'right' });
await page.waitForTimeout(600);
const rowMenu = await page
  .locator('.z-sheet, .z-modal, [role=dialog]')
  .first()
  .innerText()
  .catch(() => '');
check(
  rowMenu.includes('Снять шифрование'),
  'в меню зашифрованной заметки нет «Снять шифрование» — обратного действия не существует',
  JSON.stringify(rowMenu.slice(0, 160)),
);

if (rowMenu.includes('Снять шифрование')) {
  await page.getByText('Снять шифрование', { exact: true }).first().click();
  await page.waitForTimeout(700);
  const removeSheet = await page
    .locator('.z-sheet, .z-modal, [role=dialog]')
    .first()
    .innerText()
    .catch(() => '');
  check(
    (await field('Пароль').count()) > 0,
    'снятие шифрования не спрашивает пароль — без него операция невыполнима',
    JSON.stringify(removeSheet.slice(0, 160)),
  );
}

if (errors.length) problems.push(...errors);

await browser.close();
server.close();

if (problems.length) {
  console.error('шифрование: ПРОВАЛЕН');
  console.error(problems.map((problem) => `  · ${problem}`).join('\n'));
  process.exit(1);
}
console.log('шифрование: пройден — путь от установки пароля до снятия шифрования цел');
