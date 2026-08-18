/**
 * Панель форматирования (ITERATION-1 §4).
 *
 * Прежний тулбар был рядом плоских кнопок: форматировать можно было только
 * тем, что в него влезло, а что именно сейчас применено — не видно. Для
 * простого режима (§8), где разметки в тексте нет вовсе, это принципиально:
 * панель там единственный способ форматировать.
 *
 * Проверяется то, что §4 называет прямо и что легко потерять при любой правке
 * разметки: галочка на текущем варианте, подсветка кнопки с открытым меню и —
 * главное — что панель не уводит курсор из текста.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history } from '@codemirror/commands';
import { afterEach, describe, expect, it } from 'vitest';

import { FormatPanel, type FormatPanelProps } from '../src/react/FormatPanel.js';
import { ru } from '../src/i18n.js';

let root: Root | null = null;
let host: HTMLElement | null = null;
let view: EditorView | null = null;

/**
 * Редактор с курсором на месте маркера.
 *
 * Маркеров два: обычно `|`, но в таблицах палка — часть разметки, и там
 * курсор помечается `¦`. Один маркер на всё не годится: `text.indexOf('|')`
 * в таблице находит первую палку строки, а не то место, куда его ставили.
 */
function makeView(text: string): EditorView {
  const marker = text.includes('¦') ? '¦' : '|';
  const pos = text.indexOf(marker);
  const doc = text.replace(marker, '');
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({
    /* История нужна ровно затем, зачем она есть в сборке: панель обещает
       отмену удаления, и проверять это на состоянии без истории значило бы
       проверять заглушку. */
    state: EditorState.create({
      doc,
      selection: { anchor: pos < 0 ? 0 : pos },
      extensions: history(),
    }),
    parent,
  });
}

/**
 * Редактор с ВЫДЕЛЕНИЕМ — от «до». Отдельно от курсора нарочно: маркер
 * курсора `|` в документе с таблицей совпал бы с палкой разметки, а
 * выделение нужно ровно диалогу ссылки.
 */
function makeSelection(text: string): EditorView {
  const from = text.indexOf('«');
  const to = text.indexOf('»') - 1;
  const doc = text.replace('«', '').replace('»', '');
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({ doc, selection: { anchor: from, head: to }, extensions: history() }),
    parent,
  });
}

function mount(text: string, props: Partial<FormatPanelProps> = {}): HTMLElement {
  view = text.includes('«') ? makeSelection(text) : makeView(text);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<FormatPanel view={view} {...props} />);
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  view?.destroy();
  view = null;
});

/**
 * Нажатие так, как его делает человек: `pointerdown`/`pointerup`, не click.
 *
 * Именно pointer, а не mouse: панель слушает единый поток событий для мыши,
 * пера и пальца. Прежняя пара `mouse*` + `touch*` давала на касании ДВА
 * срабатывания — меню открывалось и тут же закрывалось само, — и тест,
 * шедший мышью, этого увидеть не мог в принципе.
 */
function press(element: Element): void {
  act(() => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
  });
}

function button(container: HTMLElement, label: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
  expect(found, `кнопки «${label}» нет`).not.toBeNull();
  return found as HTMLElement;
}

/**
 * Пункты меню ищутся во ВСЁМ документе, а не внутри контейнера панели.
 *
 * Меню рисуется порталом в `document.body`: внутри панели его держать нельзя —
 * у той `overflow-x: auto`, и она обрезала выпадашку по своей высоте так, что
 * от меню не оставалось ни одного видимого пикселя. Аргумент `container`
 * сохранён нарочно: он делает вызовы читаемыми и не даёт забыть, что панель
 * должна быть смонтирована.
 */
function menuLayer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.zp-panel__layer');
}

function items(_container: HTMLElement): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

function itemByText(container: HTMLElement, text: string): HTMLElement {
  const found = items(container).find((item) => item.textContent?.includes(text));
  expect(found, `пункта «${text}» нет в меню`).toBeTruthy();
  return found as HTMLElement;
}

/** Кнопка диалога по надписи — у неё нет роли `menuitem`. */
function itemByLabel(_container: HTMLElement, text: string): HTMLElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (node) => node.textContent === text,
  );
  expect(found, `кнопки «${text}» нет`).toBeTruthy();
  return found as HTMLElement;
}

/**
 * Нажатие на обычную кнопку диалога.
 *
 * Отдельно от `press` нарочно. `press` — про кнопки панели: они слушают
 * `pointerdown`/`pointerup`, потому что не должны уводить фокус из текста и
 * потому что пара `mouse*` + `touch*` давала на касании два срабатывания.
 * Кнопки внутри диалога — обычные: браузер шлёт им и `click`, и слушают они
 * его. Гнать их через `press` значило бы проверять не тот путь, каким по ним
 * попадает человек.
 */
function tap(element: Element): void {
  act(() => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** Кнопка по подписи для диктора — ими помечены глифы без текста. */
function byLabel(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
  expect(found, `кнопки «${label}» нет`).not.toBeNull();
  return found as HTMLElement;
}

/** Ручка строки редактора таблицы (первая колонка сетки). */
function rowHandle(index: number): HTMLElement {
  const found = Array.from(
    document.querySelectorAll<HTMLElement>('.zp-table__handle:not(.zp-table__handle--col)'),
  )[index];
  expect(found, `ручки строки ${index} нет`).toBeTruthy();
  return found as HTMLElement;
}

/** Кнопка «＋ Строка» / «＋ Столбец»: глиф плюса плюс подпись. */
function addButton(text: string): HTMLElement {
  const found = Array.from(document.querySelectorAll<HTMLElement>('.zp-table__add')).find((node) =>
    node.textContent?.includes(text),
  );
  expect(found, `кнопки «${text}» нет`).toBeTruthy();
  return found as HTMLElement;
}

/** Крестик удаления строки. */
function rowDrop(index: number): HTMLElement {
  const found = Array.from(document.querySelectorAll<HTMLElement>('.zp-table__drop'))[index];
  expect(found, `удаления строки ${index} нет`).toBeTruthy();
  return found as HTMLElement;
}

const copy = ru.panel;

describe('состав панели', () => {
  it('три группы: отмена, форматирование, эмодзи', () => {
    const container = mount('текст|');
    expect(container.querySelectorAll('.zp-panel__pill').length).toBe(3);
    expect(button(container, copy.undo)).toBeTruthy();
    expect(button(container, copy.blockStyle)).toBeTruthy();
    expect(button(container, copy.emoji)).toBeTruthy();
  });

  it('ссылка есть и без обработчика приложения', () => {
    /* Диалог «Текст» + «Адрес» — свой, панельный (§4). Приложение может
       подменить его своим через `onLink`, но не обязано. */
    expect(button(mount('текст|'), copy.link)).toBeTruthy();
  });

  it('формула есть и без обработчика приложения', () => {
    /* §4 требовал прятать кнопку, пока KaTeX не в сборке: «есть и не
       работает» хуже отсутствующей. Теперь KaTeX в сборке — и кнопка есть
       всегда, со своим диалогом, как у ссылки. */
    expect(button(mount('текст|'), copy.formula)).toBeTruthy();
  });

  it('диалог формулы показывает набранное', () => {
    const container = mount('текст|');
    press(button(container, copy.formula));
    const field = document.querySelector<HTMLTextAreaElement>('#zp-formula-tex');
    expect(field, 'поля формулы нет').not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(field, 'x^2');
      field?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    /* KaTeX рисует формулу в свою разметку — её наличие и проверяем: текст
       поля в показе остался бы и без разбора. */
    expect(document.querySelector('.zp-formula__preview .katex')).not.toBeNull();
  });

  it('формула уходит в текст долларами', () => {
    const container = mount('текст|');
    press(button(container, copy.formula));
    const field = document.querySelector<HTMLTextAreaElement>('#zp-formula-tex');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(field, 'e^{i\\pi}+1=0');
      field?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    tap(itemByLabel(container, copy.insert));
    expect(view?.state.doc.toString()).toContain('$e^{i\\pi}+1=0$');
  });

  it('вложения нет без обработчика: класть файл приложению некуда', () => {
    const container = mount('текст|');
    expect(container.querySelector(`button[aria-label="${copy.attachment}"]`)).toBeNull();
  });
});

describe('меню помечает текущий вариант', () => {
  it('обычный текст — галочка на «Текст»', () => {
    const container = mount('прос|то текст');
    press(button(container, copy.blockStyle));
    expect(itemByText(container, copy.styles.text).getAttribute('aria-checked')).toBe('true');
    expect(itemByText(container, copy.styles.quote).getAttribute('aria-checked')).toBe('false');
  });

  it('цитата — галочка на «Цитата»', () => {
    const container = mount('> ци|тата');
    press(button(container, copy.blockStyle));
    expect(itemByText(container, copy.styles.quote).getAttribute('aria-checked')).toBe('true');
    expect(itemByText(container, copy.styles.text).getAttribute('aria-checked')).toBe('false');
  });

  it('заголовок — галочка на «Заголовок», ведущем в подменю', () => {
    const container = mount('## Раз|дел');
    press(button(container, copy.blockStyle));
    expect(itemByText(container, copy.styles.heading).getAttribute('aria-checked')).toBe('true');
  });

  it('в подменю помечен нужный уровень и набран своим кеглем', () => {
    const container = mount('## Раз|дел');
    press(button(container, copy.blockStyle));
    press(itemByText(container, copy.styles.heading));

    const second = itemByText(container, copy.headingLevel(2));
    expect(second.getAttribute('aria-checked')).toBe('true');
    expect(second.className).toContain('zp-panel__item--h2');
    expect(itemByText(container, copy.headingLevel(1)).getAttribute('aria-checked')).toBe('false');
  });

  it('подменю открывается на месте родительского, с «Назад»', () => {
    /* §4: вложенное меню занимает место родителя, а не встаёт рядом. */
    const container = mount('# Заго|ловок');
    press(button(container, copy.blockStyle));
    press(itemByText(container, copy.styles.heading));

    expect(document.querySelectorAll('.zp-panel__menu').length).toBe(1);
    expect(itemByText(container, copy.back)).toBeTruthy();
    expect(items(container).some((item) => item.textContent?.includes(copy.styles.quote))).toBe(
      false,
    );
  });

  it('«Без списка» — такой же вариант, как остальные', () => {
    const container = mount('прос|то текст');
    press(button(container, copy.lists));
    expect(itemByText(container, copy.listKinds.none).getAttribute('aria-checked')).toBe('true');
  });

  it('чек-лист опознаётся, а не путается с маркированным', () => {
    const container = mount('- [ ] де|ло');
    press(button(container, copy.lists));
    expect(itemByText(container, copy.listKinds.task).getAttribute('aria-checked')).toBe('true');
    expect(itemByText(container, copy.listKinds.bullet).getAttribute('aria-checked')).toBe('false');
  });
});

describe('кнопка подсвечена, пока её меню открыто', () => {
  it('подсветка появляется и снимается', () => {
    const container = mount('текст|');
    const aa = button(container, copy.blockStyle);
    expect(aa.className).not.toContain('zp-panel__btn--active');

    press(aa);
    expect(aa.className).toContain('zp-panel__btn--active');
    expect(aa.getAttribute('aria-expanded')).toBe('true');

    press(aa);
    expect(aa.className).not.toContain('zp-panel__btn--active');
  });
});

describe('кнопка отражает текст под курсором', () => {
  /* §4, «Поведение»: курсор внутри жирного → «B» подсвечена. Без этого
     кнопка говорила только про своё меню, и понять, что уже применено к
     тексту, было нельзя — особенно в простом режиме, где разметки не видно
     вовсе (§8). */
  it('курсор внутри жирного подсвечивает «B»', () => {
    const bold = button(mount('это **жир|ное** слово'), copy.weight);
    expect(bold.className).toContain('zp-panel__btn--active');
    expect(bold.getAttribute('aria-pressed')).toBe('true');
  });

  it('курсор снаружи — подсветки нет', () => {
    const bold = button(mount('это **жирное** сло|во'), copy.weight);
    expect(bold.className).not.toContain('zp-panel__btn--active');
    expect(bold.getAttribute('aria-pressed')).toBe('false');
  });

  it('в меню начертаний галочкой отмечено то, что применено', () => {
    const container = mount('это ~~зачёр|кнутое~~ слово');
    /* Меню открывается долгим нажатием; короткое переключило бы жирный — и
       проверка тогда мерила бы собственное действие. Правый клик открывает
       то же меню и текста не трогает. */
    act(() => {
      button(container, copy.weight).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    const strike = itemByText(container, copy.weights.strike);
    expect(strike.textContent).toContain('✓');
    expect(itemByText(container, copy.weights.bold).textContent).not.toContain('✓');
  });
});

describe('ссылка вставляется диалогом «Текст» + «Адрес»', () => {
  /** Поле диалога по его подписи. */
  /* Диалог, как и меню, живёт порталом в `document.body` — ищем там. */
  function field(_container: HTMLElement, label: string): HTMLInputElement {
    const found = Array.from(document.querySelectorAll('label')).find(
      (node) => node.textContent === label,
    );
    expect(found, `поля «${label}» нет`).toBeTruthy();
    const input = document.querySelector<HTMLInputElement>(`#${found!.htmlFor}`);
    expect(input, `поле «${label}» ни к чему не привязано`).not.toBeNull();
    return input as HTMLInputElement;
  }

  function type(input: HTMLInputElement, value: string): void {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function click(element: Element): void {
    act(() => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  it('выделение предзаполняет «Текст»', () => {
    const container = mount('см. «документацию» дальше');
    press(button(container, copy.link));
    expect(field(container, copy.linkText).value).toBe('документацию');
    expect(field(container, copy.linkUrl).value).toBe('');
  });

  it('«Вставить» кладёт в текст готовую разметку', () => {
    const container = mount('см. «документацию» дальше');
    press(button(container, copy.link));
    type(field(container, copy.linkUrl), 'https://example.org');
    click(itemByLabel(container, copy.insert));
    expect(view?.state.doc.toString()).toBe('см. [документацию](https://example.org) дальше');
  });

  it('«Отмена» не трогает текст', () => {
    const container = mount('см. «документацию» дальше');
    press(button(container, copy.link));
    type(field(container, copy.linkUrl), 'https://example.org');
    click(itemByLabel(container, copy.cancel));
    expect(view?.state.doc.toString()).toBe('см. документацию дальше');
  });

  it('курсор внутри готовой ссылки открывает её на правку', () => {
    /* Иначе поправить адрес значило бы сначала стереть ссылку руками. */
    const container = mount('см. [дока|](https://old.example) дальше');
    press(button(container, copy.link));
    expect(field(container, copy.linkText).value).toBe('дока');
    expect(field(container, copy.linkUrl).value).toBe('https://old.example');

    type(field(container, copy.linkUrl), 'https://new.example');
    click(itemByLabel(container, copy.insert));
    expect(view?.state.doc.toString()).toBe('см. [дока](https://new.example) дальше');
  });
});

describe('эмодзи вставляется в текст', () => {
  it('символ попадает на позицию курсора', () => {
    /* Это вставка в ТЕКСТ пользователя, а не украшение интерфейса, — запрет
       на эмодзи в UI она не нарушает. */
    const container = mount('мысль|');
    press(button(container, copy.emoji));
    const star = document.querySelector<HTMLElement>('button[aria-label="⭐"]');
    expect(star, 'палитра не открылась').not.toBeNull();
    press(star as HTMLElement);
    expect(view?.state.doc.toString()).toBe('мысль⭐');
  });
});

describe('панель не уводит фокус из текста', () => {
  it('нажатие отменяет событие по умолчанию', () => {
    /* Это и есть механизм: `preventDefault` на `pointerdown` не даёт браузеру
       перевести фокус на кнопку. Без него на Android схлопывается клавиатура,
       а курсор уезжает с той позиции, к которой применяли формат.

       Проверяется именно pointer: в пассивном `touchstart`, на котором панель
       держалась раньше, `preventDefault` не работает вовсе — то есть на
       телефоне обещание не выполнялось, а тест этого не видел. */
    const container = mount('текст|');
    const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    button(container, copy.undo).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('одно касание — одно действие, а не два', () => {
    /* Прежняя пара `mouse*` + `touch*` давала на касании ДВА `onPress`: одно
       нажатие «Отменить» откатывало два шага, а меню открывалось и тут же
       закрывалось. Здесь это сторожится напрямую. */
    const container = mount('раз два три|');
    const target = view as EditorView;
    act(() => {
      target.dispatch({ changes: { from: target.state.doc.length, insert: ' четыре' } });
    });
    expect(target.state.doc.toString()).toBe('раз два три четыре');

    press(button(container, copy.undo));
    expect(target.state.doc.toString()).toBe('раз два три');
  });

  it('после команды курсор возвращается в редактор', () => {
    const container = mount('текст|');
    press(button(container, copy.lists));
    press(itemByText(container, copy.listKinds.bullet));
    expect(view?.hasFocus).toBe(true);
  });
});

describe('команды действительно меняют текст', () => {
  it('маркированный список', () => {
    const container = mount('пункт|');
    press(button(container, copy.lists));
    press(itemByText(container, copy.listKinds.bullet));
    expect(view?.state.doc.toString()).toBe('- пункт');
  });

  it('цитата', () => {
    const container = mount('мысль|');
    press(button(container, copy.blockStyle));
    press(itemByText(container, copy.styles.quote));
    expect(view?.state.doc.toString()).toBe('> мысль');
  });

  it('выноска — цитата с меткой, понятной чужому редактору', () => {
    const container = mount('важное|');
    press(button(container, copy.blockStyle));
    press(itemByText(container, copy.styles.callout));
    expect(view?.state.doc.toString()).toBe('> [!note] важное');
  });

  it('сворачиваемый блок сохраняется как details', () => {
    const container = mount('Итоги|');
    press(button(container, copy.lists));
    press(itemByText(container, copy.listKinds.details));
    const text = view?.state.doc.toString() ?? '';
    expect(text).toContain('<details>');
    expect(text).toContain('<summary>Итоги</summary>');
    expect(text).toContain('</details>');
  });

  it('«Без списка» снимает маркер', () => {
    const container = mount('- пункт|');
    press(button(container, copy.lists));
    press(itemByText(container, copy.listKinds.none));
    expect(view?.state.doc.toString()).toBe('пункт');
  });
});

/**
 * Редактор таблицы (ITERATION-1 §4).
 *
 * §4 называет ручки строк и столбцов «самой недооценённой частью, без которой
 * таблица нередактируема на телефоне». Заказчик попросил довести их до
 * виджета — по образцу диалога ссылки: вся таблица целиком, ячейки полями,
 * строки и столбцы ручками.
 *
 * Модель проверена отдельно (`table.test.ts`); здесь — что до неё можно
 * дотянуться пальцем и что кнопка меняет поведение в зависимости от того, где
 * стоит курсор.
 */
describe('таблица правится редактором', () => {
  const TABLE = '| Дело   | Срок |\n| ------ | ---- |\n| созвон | пн   |';
  /* Курсор в таблице помечается `¦`: палка занята разметкой. */

  /** Поля ячеек в порядке обхода. */
  function cells(): HTMLInputElement[] {
    return Array.from(document.querySelectorAll<HTMLInputElement>('.zp-table__cell'));
  }

  /** Ввод в поле ячейки — как его делает человек. */
  function type(cell: HTMLInputElement, text: string): void {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(cell, text);
      cell.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('вне таблицы кнопка вставляет новую', () => {
    const container = mount('текст|');
    press(button(container, copy.table));
    expect(view?.state.doc.toString()).toContain('|');
    /* Редактор при этом не открылся: править было нечего. */
    expect(document.querySelector('.zp-table')).toBeNull();
  });

  it('внутри таблицы та же кнопка открывает редактор', () => {
    const container = mount(TABLE.replace('созвон', 'соз¦вон'));
    press(button(container, copy.table));
    /* Вся таблица видна целиком: четыре ячейки — по одной на каждую. */
    expect(cells().map((cell) => cell.value)).toEqual(['Дело', 'Срок', 'созвон', 'пн']);
  });

  it('ячейка правится прямо в редакторе', () => {
    const container = mount(TABLE.replace('созвон', 'соз¦вон'));
    press(button(container, copy.table));
    type(cells()[2] as HTMLInputElement, 'встреча');
    expect(view?.state.doc.toString()).toContain('встреча');
    expect(view?.state.doc.toString()).not.toContain('созвон');
  });

  it('пробел в конце ячейки не съедается', () => {
    /* Иначе «Бумага А4» не набрать: в файле ячейка хранится обрезанной, и
       возвращённое из документа значение стирало бы каждый последний пробел
       ровно в тот момент, когда его набрали. */
    const container = mount(TABLE.replace('созвон', 'соз¦вон'));
    press(button(container, copy.table));
    type(cells()[2] as HTMLInputElement, 'Бумага ');
    expect((cells()[2] as HTMLInputElement).value).toBe('Бумага ');
  });

  it('палка внутри ячейки не рвёт таблицу на лишний столбец', () => {
    const container = mount(TABLE.replace('созвон', 'соз¦вон'));
    press(button(container, copy.table));
    type(cells()[2] as HTMLInputElement, 'до | после');
    expect(view?.state.doc.toString()).toContain('\\|');
    expect(cells()).toHaveLength(4);
  });

  it('вставка строки и столбца — в четыре стороны от текущей ячейки', () => {
    /* Эталон заказчика (Telegram, «Add Cells») предлагает четыре направления.
       Две кнопки «в конец» заставляли добавлять строку последней и тащить её
       ручкой на место. */
    const container = mount(TABLE.replace('созвон', 'соз¦вон'));
    press(button(container, copy.table));
    tap(addButton(copy.tableMenu.insertBelow));
    expect(view?.state.doc.toString().split('\n')).toHaveLength(4);
    tap(addButton(copy.tableMenu.insertRight));
    expect(cells()).toHaveLength(9);
  });

  it('строка вставляется ВЫШЕ текущей, а не в конец', () => {
    const container = mount(TABLE.replace('созвон', 'соз¦вон'));
    press(button(container, copy.table));
    tap(addButton(copy.tableMenu.insertAbove));

    const body = view?.state.doc.toString().split('\n') ?? [];
    /* Пустая строка встала перед той, где стоял курсор, а не после неё. */
    const empty = body.findIndex((line) => /^\|(\s*\|)+$/.test(line.trim()));
    const anchor = body.findIndex((line) => line.includes('созвон'));
    expect(empty, 'пустой строки не появилось').toBeGreaterThan(-1);
    expect(empty, 'строка вставлена не выше текущей').toBeLessThan(anchor);
  });

  it('удаление столбца', () => {
    const container = mount(TABLE.replace('Срок', 'Ср¦ок'));
    press(button(container, copy.table));
    tap(byLabel(copy.tableMenu.removeColumn));
    expect(view?.state.doc.toString()).not.toContain('Срок');
    expect(view?.state.doc.toString()).toContain('созвон');
  });

  /* §4: «Удаление строки и столбца — ОО: тост „Строка удалена · Отменить“».
     Тосты рисует приложение — в редакторе их нет и не должно быть, — поэтому
     панель отдаёт наружу сообщение и способ откатиться. Без обработчика
     удаление всё равно откатывается по Ctrl+Z. */
  describe('удаление предлагает отмену', () => {
    /** Последнее объявленное отменяемое действие. */
    function undoable(): { calls: Array<[string, () => void]> } {
      return { calls: [] };
    }

    it('удаление строки сообщает, что именно удалено', () => {
      const box = undoable();
      const container = mount(TABLE.replace('созвон', 'соз¦вон'), {
        onUndoable: (message, undoAction) => box.calls.push([message, undoAction]),
      });
      press(button(container, copy.table));
      tap(rowDrop(1));

      expect(box.calls.map(([message]) => message)).toEqual([copy.tableMenu.rowRemoved]);
    });

    it('«Отменить» возвращает строку на место', () => {
      const box = undoable();
      const container = mount(TABLE.replace('созвон', 'соз¦вон'), {
        onUndoable: (message, undoAction) => box.calls.push([message, undoAction]),
      });
      press(button(container, copy.table));
      tap(rowDrop(1));
      expect(view?.state.doc.toString()).not.toContain('созвон');

      act(() => box.calls[0]?.[1]());
      expect(view?.state.doc.toString()).toContain('созвон');
      /* И редактор показывает вернувшуюся строку, а не свой прежний вид. */
      expect(cells().map((cell) => cell.value)).toContain('созвон');
    });

    it('у столбца своё сообщение — иначе оно врёт про удалённое', () => {
      const box = undoable();
      const container = mount(TABLE.replace('Срок', 'Ср¦ок'), {
        onUndoable: (message, undoAction) => box.calls.push([message, undoAction]),
      });
      press(button(container, copy.table));
      tap(byLabel(copy.tableMenu.removeColumn));
      expect(box.calls[0]?.[0]).toBe(copy.tableMenu.columnRemoved);
    });

    it('запрещённое удаление молчит: отменять нечего', () => {
      /* Шапку удалить нельзя — таблица без неё распадается на строки с
         палками. Тост «Строка удалена» после ничего не сделавшего нажатия
         был бы прямой ложью. */
      const box = undoable();
      const container = mount(TABLE.replace('Дело', 'Де¦ло'), {
        onUndoable: (message, undoAction) => box.calls.push([message, undoAction]),
      });
      press(button(container, copy.table));
      tap(rowDrop(0));
      expect(box.calls).toEqual([]);
      expect(view?.state.doc.toString()).toContain('Дело');
    });

    it('добавление строки тоста не поднимает', () => {
      /* ОО — про деструктив. Тост на каждое действие панели был бы шумом. */
      const box = undoable();
      const container = mount(TABLE.replace('созвон', 'соз¦вон'), {
        onUndoable: (message, undoAction) => box.calls.push([message, undoAction]),
      });
      press(button(container, copy.table));
      tap(addButton(copy.tableMenu.insertBelow));
      expect(box.calls).toEqual([]);
    });
  });

  it('выравнивание помечено и применяется', () => {
    const container = mount(TABLE.replace('Срок', 'Ср¦ок'));
    press(button(container, copy.table));
    tap(byLabel(copy.tableMenu.aligns.center));
    expect(view?.state.doc.toString().split('\n')[1]).toMatch(/:-+:/);
    expect(byLabel(copy.tableMenu.aligns.center).getAttribute('aria-pressed')).toBe('true');
  });

  it('вертикального выравнивания нет — и об этом сказано вслух', () => {
    /* Заказчик просил его наравне с горизонтальным, но markdown кодирует
       только левое, правое и центр. Мёртвых кнопок не рисуем. */
    const container = mount(TABLE.replace('Срок', 'Ср¦ок'));
    press(button(container, copy.table));
    expect(document.querySelector('.zp-table__note')?.textContent).toBe(
      copy.tableMenu.noVertical,
    );
  });

  it('строка заголовка отмечена галочкой', () => {
    const container = mount(TABLE.replace('созвон', 'соз¦вон'));
    press(button(container, copy.table));
    const check = document.querySelector<HTMLInputElement>('.zp-table__check input');
    expect(check?.checked).toBe(true);
  });

  it('шапку не тащат: её ручка выключена', () => {
    /* Перестановка сделала бы заголовком чужие данные. */
    const container = mount(TABLE.replace('созвон', 'соз¦вон'));
    press(button(container, copy.table));
    expect(rowHandle(0).hasAttribute('disabled')).toBe(true);
    expect(rowHandle(1).hasAttribute('disabled')).toBe(false);
  });

  it('строка переносится перетаскиванием', () => {
    const container = mount(
      '| Дело   | Срок |\n| ------ | ---- |\n| созвон | пн   |\n| отчёт¦ | ср   |',
    );
    press(button(container, copy.table));
    /* Прямоугольники в happy-dom нулевые, поэтому строкам раздаются
       настоящие: перетаскивание считает попадание именно по ним. */
    [0, 1, 2].forEach((index) => {
      const node = rowHandle(index);
      node.getBoundingClientRect = () =>
        ({ top: index * 30, bottom: index * 30 + 30, left: 0, right: 24 }) as DOMRect;
    });
    const handle = rowHandle(2);
    /* Каждое событие — своим `act`: React объединяет обновления внутри одного,
       и `pointermove` увидел бы состояние ДО нажатия, то есть «никто ничего не
       тащит». В браузере события приходят разными задачами, и такого нет. */
    act(() => {
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }),
      );
    });
    act(() => {
      handle.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: 40 }),
      );
    });
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    });
    const lines = view?.state.doc.toString().split('\n') ?? [];
    expect(lines[2]).toContain('отчёт');
    expect(lines[3]).toContain('созвон');
  });
});

/**
 * Меню не должно жить внутри панели — она его обрезает.
 *
 * Это тот самый дефект, который прошёл мимо тысячи модульных тестов: у панели
 * стоит `overflow-x: auto`, и по CSS вторая ось при этом тоже вычисляется в
 * `auto`. Панель становится скролл-контейнером высотой 46 px, а меню начиналось
 * на 48-й — то есть не было видно НИ ОДНИМ пикселем. В DOM оно при этом
 * присутствовало, и все проверки «пункт есть» проходили.
 *
 * happy-dom раскладку не считает и обрезания не воспроизводит, поэтому здесь
 * сторожится не видимость, а её ПРЕДУСЛОВИЕ: меню вынесено из поддерева
 * панели. Саму видимость проверяет браузерный прогон `scripts/walkthrough.mjs`.
 */
describe('меню вынесено из обрезающего контейнера', () => {
  it('слой меню лежит в body, а не внутри панели', () => {
    const container = mount('текст|');
    press(button(container, copy.blockStyle));

    const layer = menuLayer();
    expect(layer, 'слоя меню нет').not.toBeNull();
    expect(container.contains(layer as Node), 'меню внутри панели — её обрежет').toBe(false);
    expect(layer?.parentElement).toBe(document.body);
  });

  it('пункты меню лежат внутри слоя', () => {
    const container = mount('текст|');
    press(button(container, copy.blockStyle));
    const layer = menuLayer() as HTMLElement;
    for (const item of items(container)) {
      expect(layer.contains(item)).toBe(true);
    }
  });

  it('закрытое меню слоя не оставляет', () => {
    /* Иначе поверх текста висел бы невидимый прямоугольник, перехватывающий
       нажатия. */
    const container = mount('текст|');
    press(button(container, copy.blockStyle));
    expect(menuLayer()).not.toBeNull();
    press(button(container, copy.blockStyle));
    expect(menuLayer()).toBeNull();
  });

  it('нажатие внутри меню его не закрывает', () => {
    /* Обработчик «нажали мимо» смотрит на поддерево панели, а меню теперь вне
       него: без учёта слоя меню закрывалось бы от нажатия по себе самому. */
    const container = mount('текст|');
    press(button(container, copy.blockStyle));
    const layer = menuLayer() as HTMLElement;

    act(() => {
      layer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    });
    expect(menuLayer(), 'меню закрылось от нажатия внутри себя').not.toBeNull();
  });

  it('нажатие вне панели и вне меню закрывает', () => {
    const container = mount('текст|');
    press(button(container, copy.blockStyle));
    expect(menuLayer()).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
      );
    });
    expect(menuLayer()).toBeNull();
  });
});

/**
 * Начертания на панели: курсив, подчёркнутый, зачёркнутый.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Заказчик: «сильный проёб в меню форматирования — нет кнопок зачёркнутый,
 * подчёркнутый и италик (причём в hot keys есть, но это Android не помогает)».
 *
 * Он прав дважды. Курсив и зачёркивание жили в меню под ДОЛГИМ нажатием на
 * «B» — жест, о котором на телефоне никто не догадывается, — а подчёркивания
 * не было вовсе. Сочетания клавиш там, где клавиатуры нет, помочь не могут по
 * устройству, и «в hot keys есть» означает ровно «на Android нет».
 *
 * ── Что сторожится ──────────────────────────────────────────────────────────
 *
 * Поведение, описанное заказчиком по шагам и взятое из Telegram: выделил →
 * средний блок подменился начертаниями → применил → блок вернулся.
 */
describe('начертания появляются на выделении', () => {
  it('выделил фрагмент — вместо стиля абзаца стоят B · I · U · S', () => {
    const panel = mount('текст «важное» дальше');

    for (const label of [
      ru.panel.weights.bold,
      ru.panel.weights.italic,
      ru.panel.weights.underline,
      ru.panel.weights.strike,
    ]) {
      expect(
        panel.querySelector(`button[aria-label="${label}"]`),
        `кнопки «${label}» нет на панели`,
      ).not.toBeNull();
    }
    /* Средний блок именно ПОДМЕНЁН: иначе четыре кнопки не влезли бы в
       ширину телефона, ради которой всё и затевалось. */
    expect(panel.querySelector(`button[aria-label="${ru.panel.blockStyle}"]`)).toBeNull();
  });

  it('без выделения начертаний не предлагают: форматировать нечего', () => {
    const panel = mount('текст|');

    expect(panel.querySelector(`button[aria-label="${ru.panel.weights.italic}"]`)).toBeNull();
    expect(panel.querySelector(`button[aria-label="${ru.panel.blockStyle}"]`)).not.toBeNull();
  });

  it('нажал «Зачёркнутый» — разметка легла, а блок ОСТАЛСЯ', () => {
    const panel = mount('текст «важное» дальше');

    press(button(panel, ru.panel.weights.strike));

    expect(view?.state.doc.toString()).toBe('текст ~~важное~~ дальше');
    /*
     * Первая версия убирала блок сразу после применения, и заказчик описал,
     * во что это превращается: «нажимаешь I — она исчезает и проявляется
     * полная панель, где нажатие происходит уже не на I, а на B или Aa. В
     * итоге моргание и бесит». Кнопки стоят в одной строке, поэтому подмена
     * набора двигает соседей ПОД ПАЛЬЦЕМ.
     *
     * Правило теперь одно: блок стоит, пока стоит выделение.
     */
    expect(
      panel.querySelector(`button[aria-label="${ru.panel.weights.italic}"]`),
      'блок начертаний исчез после применения — кнопки поедут под пальцем',
    ).not.toBeNull();
    expect(panel.querySelector(`button[aria-label="${ru.panel.blockStyle}"]`)).toBeNull();
  });

  it('три начертания подряд ложатся с трёх нажатий, без промахов', () => {
    /* Ровно тот сценарий, на котором ломалось: подряд, не снимая выделения. */
    const panel = mount('текст «важное» дальше');

    press(button(panel, ru.panel.weights.strike));
    press(button(panel, ru.panel.weights.italic));
    press(button(panel, ru.panel.weights.underline));

    /* Каждое следующее начертание ложится ВНУТРЬ предыдущего: выделение после
       команды охватывает сам текст, а не маркеры вокруг него. Так и надо —
       иначе третий тап оборачивал бы уже обёрнутое вместе со звёздочками. */
    expect(view?.state.doc.toString()).toBe('текст ~~*<u>важное</u>*~~ дальше');
  });

  it('применённое начертание подсвечено — видно, что уже сделано', () => {
    const panel = mount('текст «важное» дальше');

    press(button(panel, ru.panel.weights.strike));

    expect(
      button(panel, ru.panel.weights.strike).className,
      'применённое начертание не подсвечено',
    ).toContain('--active');
  });

  it('сняли выделение — вернулся обычный набор', () => {
    const panel = mount('текст «важное» дальше');

    act(() => {
      view?.dispatch({ selection: { anchor: 0 } });
    });

    expect(panel.querySelector(`button[aria-label="${ru.panel.blockStyle}"]`)).not.toBeNull();
    expect(panel.querySelector(`button[aria-label="${ru.panel.weights.italic}"]`)).toBeNull();
  });

  it('«Подчёркнутый» кладёт <u>, потому что своего знака у markdown нет', () => {
    const panel = mount('текст «важное» дальше');

    press(button(panel, ru.panel.weights.underline));

    expect(view?.state.doc.toString()).toBe('текст <u>важное</u> дальше');
  });

  it('«Курсив» на месте и работает одним нажатием, без долгого', () => {
    const panel = mount('текст «важное» дальше');

    press(button(panel, ru.panel.weights.italic));

    expect(view?.state.doc.toString()).toBe('текст *важное* дальше');
  });
});
