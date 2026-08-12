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
import { afterEach, describe, expect, it } from 'vitest';

import { FormatPanel } from '../src/react/FormatPanel.js';
import { ru } from '../src/i18n.js';

let root: Root | null = null;
let host: HTMLElement | null = null;
let view: EditorView | null = null;

/** Редактор с курсором на позиции `|`. */
function makeView(text: string): EditorView {
  const pos = text.indexOf('|');
  const doc = text.replace('|', '');
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({ doc, selection: { anchor: pos < 0 ? 0 : pos } }),
    parent,
  });
}

function mount(text: string): HTMLElement {
  view = makeView(text);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<FormatPanel view={view} />);
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

/** Нажатие так, как его делает человек: mousedown, не click. */
function press(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
}

function button(container: HTMLElement, label: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
  expect(found, `кнопки «${label}» нет`).not.toBeNull();
  return found as HTMLElement;
}

function items(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

function itemByText(container: HTMLElement, text: string): HTMLElement {
  const found = items(container).find((item) => item.textContent?.includes(text));
  expect(found, `пункта «${text}» нет в меню`).toBeTruthy();
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
    /* Своей команды хватает: `[текст]()` с курсором внутри скобок. Диалог
       «Текст» + «Адрес» приложение подставляет сверху, если хочет. */
    expect(button(mount('текст|'), copy.link)).toBeTruthy();
  });

  it('формулы нет, пока нет KaTeX', () => {
    /* §4: включается только если KaTeX в сборке. Кнопка, которая есть и не
       работает, хуже отсутствующей. */
    const container = mount('текст|');
    expect(container.querySelector(`button[aria-label="${copy.formula}"]`)).toBeNull();
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

    expect(container.querySelectorAll('.zp-panel__menu').length).toBe(1);
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

describe('эмодзи вставляется в текст', () => {
  it('символ попадает на позицию курсора', () => {
    /* Это вставка в ТЕКСТ пользователя, а не украшение интерфейса, — запрет
       на эмодзи в UI она не нарушает. */
    const container = mount('мысль|');
    press(button(container, copy.emoji));
    const star = container.querySelector<HTMLElement>('button[aria-label="⭐"]');
    expect(star, 'палитра не открылась').not.toBeNull();
    press(star as HTMLElement);
    expect(view?.state.doc.toString()).toBe('мысль⭐');
  });
});

describe('панель не уводит фокус из текста', () => {
  it('нажатие отменяет событие по умолчанию', () => {
    /* Это и есть механизм: `preventDefault` на mousedown не даёт браузеру
       перевести фокус на кнопку. Без него на Android схлопывается клавиатура,
       а курсор уезжает с той позиции, к которой применяли формат. */
    const container = mount('текст|');
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button(container, copy.undo).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
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
