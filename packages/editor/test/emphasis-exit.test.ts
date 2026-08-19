/**
 * Пробел на краю начертания: выйти, а не сломать.
 *
 * ── Отчёт заказчика, дословно ───────────────────────────────────────────────
 *
 * «Когда в строке одно слово, ты 2 раза на него топаешь и делаешь жирным, то
 * далее когда печатаешь, например, пробел, то после пробела появляются `**` и
 * каретка не может быть за них перенесена. Таким образом почти невозможно
 * печатать дальше текст. Думаю, так не только с выделением жирным».
 *
 * ── Почему это происходило ──────────────────────────────────────────────────
 *
 * После `toggleBold` каретка стоит ВНУТРИ пары маркеров — иначе следующая
 * буква не попала бы в жирное слово. Пробел, набранный там, даёт `**слово **`,
 * а это по CommonMark уже не жирный текст: закрывающая пара не может стоять
 * после пробела. Разметка разваливается, `**` из невидимых становятся обычным
 * текстом — ровно то, что человек и увидел.
 *
 * Дальше хуже: каждое следующее слово снова оказывается внутри пары, и текст
 * «засасывает» в жирное. Отсюда «почти невозможно печатать дальше».
 *
 * Заказчик прав и во втором: беда общая для всех начертаний, а не только для
 * жирного, — поэтому здесь проверяются все пять.
 */
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { toggleBold, toggleItalic, toggleStrike } from '../src/commands/formatting.js';
import { makeView } from './helpers.js';

/**
 * Набрать пробел там, где стоит каретка.
 *
 * Сначала спрашиваем обработчики ввода — клавиатура делает ровно это, — и
 * только если никто не взялся, пробел попадает в документ сам.
 */
function typeSpace(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  const handled = view.state
    .facet(EditorView.inputHandler)
    .some((handler) => handler(view, from, to, ' ', () => null as never));
  if (!handled) view.dispatch(view.state.replaceSelection(' '));
}

/**
 * Поставить каретку в конец слова — как это делает тап по экрану.
 *
 * После «B» слово остаётся выделенным, и это правильно: панель стоит, пока
 * стоит выделение. Человек снимает выделение тапом, и каретка попадает ВНУТРЬ
 * пары — закрывающие `**` невидимы, и конец слова с концом строки для пальца
 * одна и та же точка. Отсюда и начинается случай заказчика.
 */
function caretAtWordEnd(view: EditorView): void {
  view.dispatch({ selection: { anchor: view.state.selection.main.to } });
}

describe('пробел на краю начертания печатается снаружи', () => {
  it('жирное слово: пробел не ломает разметку — случай заказчика', () => {
    /* Двойной тап выделил слово, панель сделала его жирным. */
    const view = makeView('слово', { selection: { anchor: 0, head: 5 } });
    toggleBold(view);
    expect(view.state.doc.toString()).toBe('**слово**');
    caretAtWordEnd(view);

    typeSpace(view);

    expect(view.state.doc.toString(), 'пробел уехал внутрь и сломал запись').toBe('**слово** ');
    expect(view.state.selection.main.head, 'каретка осталась внутри пары').toBe(10);
    view.destroy();
  });

  it('дальше печатается обычный текст, а не продолжение жирного', () => {
    const view = makeView('слово', { selection: { anchor: 0, head: 5 } });
    toggleBold(view);
    caretAtWordEnd(view);
    typeSpace(view);
    view.dispatch(view.state.replaceSelection('дальше'));

    expect(view.state.doc.toString()).toBe('**слово** дальше');
    view.destroy();
  });

  it('курсив и зачёркнутый — та же беда и то же лечение', () => {
    const italic = makeView('слово', { selection: { anchor: 0, head: 5 } });
    toggleItalic(italic);
    caretAtWordEnd(italic);
    typeSpace(italic);
    expect(italic.state.doc.toString()).toBe('*слово* ');
    italic.destroy();

    const strike = makeView('слово', { selection: { anchor: 0, head: 5 } });
    toggleStrike(strike);
    caretAtWordEnd(strike);
    typeSpace(strike);
    expect(strike.state.doc.toString()).toBe('~~слово~~ ');
    strike.destroy();
  });

  it('инлайн-код: пробел у закрывающей кавычки тоже выходит наружу', () => {
    const view = makeView('`код`', { selection: { anchor: 4 } });
    typeSpace(view);
    expect(view.state.doc.toString()).toBe('`код` ');
    view.destroy();
  });

  it('передний край: пробел встаёт перед парой, а не внутрь неё', () => {
    /* `**|слово**` — каретка сразу за открывающей парой. */
    const view = makeView('**слово**', { selection: { anchor: 2 } });
    typeSpace(view);
    expect(view.state.doc.toString()).toBe(' **слово**');
    expect(view.state.selection.main.head).toBe(1);
    view.destroy();
  });
});

describe('чего правило НЕ делает', () => {
  it('пробел в середине слова остаётся на месте', () => {
    const view = makeView('**слово**', { selection: { anchor: 5 } });
    typeSpace(view);
    expect(view.state.doc.toString()).toBe('**сло во**');
    view.destroy();
  });

  it('обычный текст не трогается вовсе', () => {
    const view = makeView('просто текст', { selection: { anchor: 6 } });
    typeSpace(view);
    expect(view.state.doc.toString()).toBe('просто  текст');
    view.destroy();
  });

  it('буква на краю дописывает слово внутрь — это «допишу», а не «закончил»', () => {
    const view = makeView('**слов**', { selection: { anchor: 6 } });
    view.dispatch(view.state.replaceSelection('о'));
    expect(view.state.doc.toString()).toBe('**слово**');
    view.destroy();
  });

  it('слово ещё выделено, а человек печатает пробел — маркеры уходят с ним', () => {
    /* Второй путь того же отчёта: после «B» выделение остаётся на слове.
       Замена дала бы `** **` — ту же сломанную запись вокруг пробела. */
    const view = makeView('слово', { selection: { anchor: 0, head: 5 } });
    toggleBold(view);
    typeSpace(view);
    expect(view.state.doc.toString()).toBe(' ');
    view.destroy();
  });

  it('ссылка не трогается: пробел внутри неё разметку не ломает', () => {
    const view = makeView('[имя](адрес)', { selection: { anchor: 4 } });
    typeSpace(view);
    expect(view.state.doc.toString()).toBe('[имя ](адрес)');
    view.destroy();
  });
});
