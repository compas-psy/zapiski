/**
 * Формулы LaTeX (ITERATION-1 §4).
 *
 * Заказчик: «ты тихой сапой забыл про формулы LaTeX с вводом через виджет».
 * Кнопка и строки были готовы, но KaTeX не входил в сборку — и §4 велел в
 * таком случае кнопку прятать. Теперь KaTeX в сборке.
 *
 * Здесь проверяется разбор и показ. Разбор строгий нарочно: доллар — обычный
 * символ в тексте про деньги, и «заплатил $5 и $7» формулой быть не должно.
 */
import { describe, expect, it } from 'vitest';

import { decorationsOf, makeState } from './helpers.js';
import { MathWidget } from '../src/live-preview/widgets.js';

/** Классы и виджеты по документу с курсором в начале. */
function decos(doc: string): { class: string | null; widget: string | null }[] {
  return decorationsOf(makeState(doc, { selection: { anchor: 0 } })).map((deco) => ({
    class: deco.class,
    widget: deco.widget,
  }));
}

const hasMath = (doc: string): boolean => decos(doc).some((d) => d.widget === 'MathWidget');

describe('что считается формулой', () => {
  it('`$E=mc^2$` — формула', () => {
    expect(hasMath('Инлайн $E=mc^2$ в строке')).toBe(true);
  });

  it('`$$…$$` — тоже формула, только блочная', () => {
    /* Курсор в первой строке: под кареткой формула нарочно показывается
       исходником, и проверять надо ту, где каретки нет. */
    expect(hasMath('текст\n\n$$\\frac{1}{2}$$')).toBe(true);
  });

  it('цены формулой не становятся', () => {
    /* Пробел после открывающего доллара — верный признак, что это не
       формула, а деньги: `$5 и $7`. */
    expect(hasMath('заплатил $5 и $7 сверху')).toBe(false);
  });

  it('пустая пара долларов формулой не становится', () => {
    expect(hasMath('текст\n\n$$ вот так $$')).toBe(false);
  });
});

describe('как формула показана', () => {
  it('на месте разметки — виджет, а не текст', () => {
    const found = decos('перед $x^2$ после');
    expect(found.filter((d) => d.widget === 'MathWidget')).toHaveLength(1);
  });

  it('под курсором виден исходник, а не набранная формула', () => {
    /* Иначе формулу нельзя поправить: она превращается в картинку под
       кареткой. */
    const doc = 'перед $x^2$ после';
    const found = decorationsOf(makeState(doc, { selection: { anchor: doc.indexOf('x^2') + 1 } }));
    expect(found.some((d) => d.widget === 'MathWidget')).toBe(false);
    expect(found.some((d) => d.class === 'cm-z-math-src')).toBe(true);
  });
});

describe('виджет формулы', () => {
  it('набирает разметку KaTeX, а не печатает исходник', () => {
    const dom = new MathWidget('x^2', false).toDOM();
    expect(dom.querySelector('.katex'), 'KaTeX не отработал').not.toBeNull();
  });

  it('блочная формула — своей строкой', () => {
    expect(new MathWidget('x^2', true).toDOM().className).toContain('cm-z-math-block');
  });

  it('сломанная формула не роняет редактор', () => {
    /* Пока формулу набирают, она сломана почти всегда: разбор не должен
       бросать ни на одном промежуточном состоянии. */
    expect(() => new MathWidget('\\frac{', false).toDOM()).not.toThrow();
  });
});
