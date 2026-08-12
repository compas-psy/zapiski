/**
 * Вложения в тексте (ITERATION-1 §5, «Как выглядит в тексте»).
 *
 * Спецификация просит трёх разных видов от трёх разных вложений: картинка —
 * превью с полноэкранным просмотром по тапу, файл — строка-карточка с именем
 * и размером, аудио — мини-плеер. До этой правки картинкой показывалась
 * только картинка, а документ и звук оставались голой ссылкой
 * `[](attachments/договор.pdf)` — то есть выглядели как опечатка.
 *
 * Здесь сторожатся три вещи: какое вложение каким виджетом показывается, что
 * при тапе уходит наружу (путь из текста, а не `blob:`-адрес из кэша) и что
 * обычная ссылка карточкой не становится.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import type { EditorRuntime } from '../src/runtime.js';
import { decorationsOf, makeState, makeView } from './helpers.js';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

/** Рантайм, у которого всё вложение резолвится: `blob:` + путь. */
const resolving = { resolveAttachment: (src: string) => `blob:${src}` };

function widgets(doc: string, runtime: Partial<EditorRuntime> = resolving): (string | null)[] {
  return decorationsOf(makeState(doc, { runtime, selection: { anchor: 0 } }))
    .filter((deco) => deco.widget !== null)
    .map((deco) => deco.widget);
}

describe('чем показывается вложение', () => {
  it('документ — карточкой файла', () => {
    expect(widgets('[](attachments/договор.pdf)')).toContain('FileWidget');
  });

  it('аудио — мини-плеером, а не карточкой', () => {
    /* Иначе запись пришлось бы открывать в стороннем приложении, чтобы
       услышать: §5 обещает кнопку прямо в тексте. */
    const found = widgets('[](attachments/2026-08-11_ab.opus)');
    expect(found).toContain('AudioWidget');
    expect(found).not.toContain('FileWidget');
  });

  it('картинка остаётся картинкой', () => {
    const found = widgets('![кот](attachments/кот.png)');
    expect(found).toContain('ImageWidget');
    expect(found).not.toContain('FileWidget');
  });

  it('внешняя ссылка карточкой не становится', () => {
    /* За `https://` нет файла, который мы могли бы открыть, а превращать
       обычную ссылку в карточку значит соврать про её природу. */
    expect(widgets('[сайт](https://example.org/файл.pdf)')).not.toContain('FileWidget');
  });

  it('ссылка НА картинку — тоже ссылка, а не вложение', () => {
    /* Разница с превью ровно в восклицательном знаке: `![…]` встраивает,
       `[…]` ведёт. Показать карточку здесь — подменить смысл разметки. */
    expect(widgets('[схема](attachments/схема.png)')).toEqual([]);
  });

  it('нечитаемое вложение виджета не создаёт', () => {
    /* Файла нет или доступ отозван: пусть остаётся текст ссылки — по нему
       видно, чего не хватает. Пустая карточка не сказала бы ничего. */
    expect(widgets('[](attachments/нет.pdf)', { resolveAttachment: () => null })).toEqual([]);
  });

  it('виджет добавочный: ни одного символа он не подменяет', () => {
    const doc = '[](attachments/договор.pdf)';
    const card = decorationsOf(makeState(doc, { runtime: resolving, selection: { anchor: 0 } }))
      .find((deco) => deco.widget === 'FileWidget');
    /* Нулевая длина и позиция в конце строки — текст ссылки остаётся на
       месте и правится руками (BEHAVIOR §2.1). */
    expect(card?.from).toBe(doc.length);
    expect(card?.to).toBe(doc.length);
  });
});

describe('что написано на карточке', () => {
  it('имя из текста ссылки, а если его нет — имя файла', () => {
    const v = makeView('[](attachments/договор.pdf)', { runtime: resolving });
    view = v;
    expect(v.dom.querySelector('.cm-z-file__name')?.textContent).toBe('договор.pdf');
  });

  it('подпись из скобок сильнее имени файла', () => {
    const v = makeView('[Договор аренды](attachments/2026-08-11_ab.pdf)', { runtime: resolving });
    view = v;
    expect(v.dom.querySelector('.cm-z-file__name')?.textContent).toBe('Договор аренды');
  });

  it('размер приходит от приложения и показывается моноширинным', () => {
    const v = makeView('[](attachments/договор.pdf)', {
      runtime: { ...resolving, attachmentSize: () => '96 КБ' },
    });
    view = v;
    expect(v.dom.querySelector('.cm-z-file__size')?.textContent).toBe('96 КБ');
  });

  it('размера ещё нет — строки размера нет вовсе', () => {
    /* Ноль байт вместо неизвестности читался бы как пустой файл. */
    const v = makeView('[](attachments/договор.pdf)', { runtime: resolving });
    view = v;
    expect(v.dom.querySelector('.cm-z-file__size')).toBeNull();
  });
});

describe('тап по вложению', () => {
  it('картинка отдаёт путь из текста, а не blob:-адрес', () => {
    /* `blob:`-адрес живёт только внутри кэша приложения и за его пределами
       не значит ничего: открыть по нему файл нельзя. */
    const openAttachment = vi.fn();
    const v = makeView('![кот](attachments/кот.png)', {
      runtime: { ...resolving, openAttachment },
    });
    view = v;
    const image = v.dom.querySelector('.cm-z-image');
    expect(image, 'превью не нарисовано').not.toBeNull();
    image?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(openAttachment).toHaveBeenCalledWith('attachments/кот.png');
  });

  it('карточка файла — тем же путём', () => {
    const openAttachment = vi.fn();
    const v = makeView('[](attachments/договор.pdf)', {
      runtime: { ...resolving, openAttachment },
    });
    view = v;
    v.dom.querySelector('.cm-z-file')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(openAttachment).toHaveBeenCalledWith('attachments/договор.pdf');
  });

  it('тап по тексту заметки просмотр не открывает', () => {
    const openAttachment = vi.fn();
    const v = makeView('![кот](attachments/кот.png)', {
      runtime: { ...resolving, openAttachment },
    });
    view = v;
    v.contentDOM.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(openAttachment).not.toHaveBeenCalled();
  });
});
