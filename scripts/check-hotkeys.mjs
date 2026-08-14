/**
 * Каждое сочетание из справки — нажимается и проверяется по результату.
 *
 * Заказчик: «не работают горячие клавиши, например Ctrl+Shift+0 (Windows,
 * Web). Проверь все доступные сочетания на работоспособность». Проверить их
 * можно только нажатием: модульный тест зовёт команду напрямую и о том, дошло
 * ли до неё нажатие, не знает ничего.
 *
 * Что этот прогон НЕ проверяет и проверить не может: сочетания, которые
 * забирает себе сам браузер (Ctrl+L — адресная строка, Ctrl+E — поиск в
 * омнибоксе, Ctrl+Shift+O — закладки). Playwright шлёт события прямо
 * странице, минуя браузерные обработчики, поэтому здесь они «работают», а в
 * настоящем окне Chrome до страницы не доходят. Такие сочетания перечислены
 * ниже в `RESERVED` и разбираются отдельно — их надо не чинить, а менять.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveDist } from './static-server.mjs';
import { findChrome } from './find-chrome.mjs';
import { seedWebSession } from './web-session.mjs';

const DIST = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
const PORT = process.env.ZAPISKI_PORT ?? '4191';


/**
 * Сочетания, которые в окне браузера принадлежат браузеру.
 *
 * Список составлен по документации Chrome и проверяется вручную: страница их
 * либо не видит вовсе, либо видит после того, как браузер уже отработал.
 */
const RESERVED = new Set(['Control+l', 'Control+e', 'Control+Shift+O', 'Control+n', 'Control+t', 'Control+w']);

/** Что нажать и как понять, что сработало. */
const CASES = [
  { id: 'Жирный', keys: 'Control+b', doc: 'слово', expect: (text) => text.includes('**') },
  { id: 'Курсив', keys: 'Control+i', doc: 'слово', expect: (text) => text.includes('*') },
  { id: 'Подсветка', keys: 'Control+u', doc: 'слово', expect: (text) => text.includes('==') },
  {
    id: 'Зачёркнутый',
    keys: 'Control+Shift+X',
    doc: 'слово',
    expect: (text) => text.includes('~~'),
  },
  { id: 'Заголовок 1', keys: 'Control+1', doc: 'слово', expect: (text) => text.startsWith('# ') },
  { id: 'Заголовок 3', keys: 'Control+3', doc: 'слово', expect: (text) => text.startsWith('### ') },
  { id: 'Обычный текст', keys: 'Control+0', doc: '## слово', expect: (text) => text === 'слово' },
  /* Вторые сочетания — те, что доживают до страницы в браузере. Их заказчик
     и нажимал: «например Ctrl+Shift+0». */
  {
    id: 'Заголовок 1 (браузерное)',
    keys: 'Control+Shift+1',
    doc: 'слово',
    expect: (text) => text.startsWith('# '),
  },
  {
    id: 'Заголовок 6 (браузерное)',
    keys: 'Control+Shift+6',
    doc: 'слово',
    expect: (text) => text.startsWith('###### '),
  },
  {
    id: 'Обычный текст (браузерное)',
    keys: 'Control+Shift+0',
    doc: '## слово',
    expect: (text) => text === 'слово',
  },
  {
    id: 'Список с номерами (браузерное)',
    keys: 'Control+Shift+7',
    doc: 'слово',
    expect: (text) => text.startsWith('1. '),
  },
  {
    id: 'Список с маркерами (браузерное)',
    keys: 'Control+Shift+8',
    doc: 'слово',
    expect: (text) => /^[-*+] /.test(text),
  },
  {
    id: 'Ссылка (браузерное)',
    keys: 'Control+Alt+l',
    doc: 'слово',
    expect: (text) => text.includes(']('),
  },
  { id: 'Цитата', keys: 'Control+Shift+Q', doc: 'слово', expect: (text) => text.startsWith('> ') },
  {
    id: 'Код-блок',
    keys: 'Control+Shift+C',
    doc: 'слово',
    expect: (text) => text.includes('```'),
  },
  {
    id: 'Список с маркерами',
    keys: 'Control+Shift+L',
    doc: 'слово',
    expect: (text) => /^[-*+] /.test(text),
  },
  {
    id: 'Список с номерами',
    keys: 'Control+Shift+O',
    doc: 'слово',
    expect: (text) => text.startsWith('1. '),
  },
  {
    id: 'Чек-лист',
    keys: 'Control+Shift+K',
    doc: 'слово',
    expect: (text) => text.includes('[ ]'),
  },
  {
    id: 'Отметить задачу',
    keys: 'Control+Enter',
    doc: '- [ ] дело',
    expect: (text) => text.includes('[x]'),
  },
  { id: 'Ссылка', keys: 'Control+l', doc: 'слово', expect: (text) => text.includes('](') },
  {
    id: 'Wiki-ссылка',
    keys: 'Control+Shift+W',
    doc: 'слово',
    expect: (text) => text.includes('[['),
  },
  {
    id: 'Дублировать строку',
    keys: 'Control+d',
    doc: 'слово',
    expect: (text) => text === 'слово\nслово',
  },
  {
    id: 'Двигать строку вниз',
    keys: 'Alt+ArrowDown',
    doc: 'первая\nвторая',
    caret: 0,
    expect: (text) => text.startsWith('вторая'),
  },
];

/**
 * Сочетания оболочки: проверяются по тому, что появилось на экране.
 *
 * Ctrl+K — ПОИСК, а не палитра: так его читают Linear, Notion и Slack, и так
 * он подписан у поля поиска. Палитра осталась на Ctrl+P. Справка это место
 * называла наоборот — расхождение поймано этим прогоном и исправлено.
 */
const SHELL = [
  { id: 'Поиск по заметкам', keys: 'Control+k', selector: '.za-search, input[type="search"]' },
  { id: 'Палитра команд', keys: 'Control+p', selector: '[role="dialog"]' },
  { id: 'Найти в заметке', keys: 'Control+f', selector: '.cm-panels' },
  { id: 'Заменить', keys: 'Control+h', selector: '.cm-panels' },
  { id: 'Библиотека', keys: 'Control+\\', selector: '.za-library, .za-pane--library' },
  { id: 'Настройки', keys: 'Control+Comma', selector: '.za-settings, .za-section' },
];

const CHROME = findChrome();
if (!CHROME) {
  console.log('хоткеи: пропущено — браузера нет');
  process.exit(process.argv.includes('--strict') ? 1 : 0);
}

const { chromium } = await import('playwright-core');
const server = await serveDist(DIST, Number(PORT));
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
/* Ворота веба: без сессии прогон упрётся в экран входа. */
await seedWebSession(page);
const problems = [];
page.on('pageerror', (error) => problems.push(`ошибка страницы: ${error.message}`));

try {
  await page.goto(server.url);
  const start = page.getByRole('button', { name: /Начать|Start/ }).first();
  await start.waitFor({ state: 'visible', timeout: 20000 });
  await start.click();
  await page.getByRole('button', { name: /Дальше|Next/ }).first().click();
  await page.waitForSelector('.cm-content', { timeout: 20000 });

  const setDoc = async (text, caret) =>
    page.evaluate(
      ([value, at]) => {
        /* CodeMirror вешает свой узел представления на DOM: в 6.43 это
           `cmTile`. Лезть внутрь чужого пакета не любо, но иначе прогону
           неоткуда взять исходный текст: на экране он скрыт декорациями. */
        const view = document.querySelector('.cm-content')?.cmTile?.view;
        if (!view) throw new Error('редактор не найден в DOM');
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: value },
          selection: { anchor: at ?? value.length },
        });
        view.focus();
      },
      [text, caret],
    );
  const readDoc = () =>
    page.evaluate(() => document.querySelector('.cm-content').cmTile.view.state.doc.toString());

  for (const item of CASES) {
    /*
     * Экран возвращается в исходное состояние перед КАЖДЫМ нажатием.
     *
     * Часть сочетаний открывает диалог (ссылка, вложение), а открытый диалог
     * забирает фокус у текста — и следующее нажатие уходит не туда. В CI это
     * дало плавающее падение: «Ссылка (браузерное)» и «Чек-лист» через раз
     * «ничего не делали», хотя оба работают. Прогон, падающий по своей же
     * инерции, обвиняет продукт вместо себя, а по такому отчёту ищут дефект
     * там, где его нет.
     *
     * `Escape` закрывает то, что осталось от предыдущего шага, а `setDoc`
     * ниже сам возвращает фокус в текст.
     */
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
    /* Исходный текст обязан НЕ удовлетворять ожиданию: иначе проверка
       проходит сама собой и о сочетании не говорит ничего. */
    if (item.expect(item.doc)) {
      problems.push(`${item.id}: исходный текст уже подходит под ожидание — проверка пустая`);
    }
    await setDoc(item.doc, item.caret);
    const focusBefore = await page.evaluate(
      () => document.activeElement?.className || document.activeElement?.tagName || '?',
    );
    /*
      Ждём РЕЗУЛЬТАТА, а не фиксированные 80 мс.

      Пауза в 80 мс — это ставка на то, что раннер успеет. Один раз он не
      успел: в CI «Подсветка» и «Обычный текст» отчитались как «ничего не
      сделали», хотя оба работают и локально проходят подряд. Отчёт при этом
      обвинял продукт, а причина была в спешке прогона — тот самый класс
      дефекта, за которым уже приходили: сторож, врущий о причине.

      Опрос до срока: как только текст стал ожидаемым — идём дальше (обычно с
      первой же попытки), не стал за полторы секунды — это настоящее падение.
    */
    await page.keyboard.press(item.keys);
    let text = await readDoc();
    for (let waited = 0; waited < 1500 && !item.expect(text); waited += 50) {
      await page.waitForTimeout(50);
      text = await readDoc();
    }
    const ok = item.expect(text);
    if (!ok) problems.push(`  фокус перед нажатием: ${focusBefore}`);
    const reserved = RESERVED.has(item.keys) ? ' (в окне браузера сочетание занято)' : '';
    console.log(`${ok ? '  ✓' : '  ✗'} ${item.id} — ${item.keys}${ok ? reserved : ''}`);
    if (!ok) problems.push(`${item.id} (${item.keys}) ничего не сделал: ${JSON.stringify(text)}`);
  }

  for (const item of SHELL) {
    /* Экран возвращается в исходное состояние перед каждой проверкой: иначе
       уже открытая панель считалась бы результатом следующего нажатия. */
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    await page.locator('.cm-content').click();
    await page.keyboard.press(item.keys);
    /* Та же причина, что и выше: ждём появления панели, а не отмеренной
       четверти секунды. */
    let ok = false;
    for (let waited = 0; waited < 1500 && !ok; waited += 50) {
      ok = (await page.locator(item.selector).count()) > 0;
      if (!ok) await page.waitForTimeout(50);
    }
    console.log(`${ok ? '  ✓' : '  ✗'} ${item.id} — ${item.keys}`);
    if (!ok) problems.push(`${item.id} (${item.keys}) не изменил экран`);
  }
} finally {
  await browser.close();
  server.close();
}

if (problems.length > 0) {
  console.log('\nхоткеи: не работают');
  for (const problem of problems) console.log(`  · ${problem}`);
  process.exit(1);
}
console.log('\nхоткеи: все сочетания из справки срабатывают');
