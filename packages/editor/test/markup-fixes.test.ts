/**
 * Три замечания заказчика по командам разметки, по одному describe на каждое.
 *
 * Общее у них то, что все три ломались молча: разметка в файл ложилась
 * правильная, а на экране получалось не то, что человек просил.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { insertSmall } from '../src/commands/blocks';
import { insertCodeBlock, toggleBulletList, toggleOrderedList } from '../src/commands/formatting';
import { decorationsOf, hiddenRanges, makeState } from './helpers.js';

/** Состояние с курсором или выделением; `|` — курсор, `[…]` — выделение. */
function stateOf(source: string): EditorState {
  const selectionStart = source.indexOf('[');
  if (selectionStart !== -1) {
    const selectionEnd = source.indexOf(']') - 1;
    return EditorState.create({
      doc: source.replace('[', '').replace(']', ''),
      selection: EditorSelection.single(selectionStart, selectionEnd),
    });
  }
  return EditorState.create({
    doc: source.replace('|', ''),
    selection: EditorSelection.cursor(source.indexOf('|')),
  });
}

/** Прогоняет команду и отдаёт получившийся текст. */
function run(source: string, command: (target: never) => boolean): string {
  let state = stateOf(source);
  const target = {
    state,
    dispatch: (tr: { state: EditorState }) => {
      state = tr.state;
    },
  };
  command(target as never);
  return state.doc.toString();
}

describe('замечание 7: блок кода не захватывает текст ниже', () => {
  it('в непустой строке блок встаёт СВОЕЙ строкой, а не разрывает её', () => {
    /* Раньше вставка шла в позицию курсора: открывающая ограда приклеивалась
       к тексту слева, закрывающая — к тексту справа. После первого же Enter
       ограды переставали быть парой, и кодом становилось всё до конца
       заметки. */
    const result = run('Привет|мир', insertCodeBlock);

    expect(result).not.toContain('Привет```');
    expect(result).not.toContain('```мир');
    const lines = result.split('\n');
    /* Строка остаётся ЦЕЛОЙ. Курсор стоял в её середине, но резать набранное
       пополам ради вставки блока — ровно тот дефект, который чинится. */
    expect(lines[0]).toBe('Приветмир');
    /* Ограды — целыми строками: только так markdown считает их парой. */
    expect(lines.filter((line) => line === '```')).toHaveLength(2);
  });

  it('текст ниже остаётся снаружи блока', () => {
    const result = run('Первая строка|\nВторая строка', insertCodeBlock);
    const lines = result.split('\n');
    const closing = lines.lastIndexOf('```');
    expect(closing).toBeGreaterThan(-1);
    expect(
      lines.slice(closing + 1).join('\n'),
      'текст, который шёл ниже, оказался внутри блока кода',
    ).toContain('Вторая строка');
  });

  it('в пустой строке лишних переводов не появляется', () => {
    expect(run('|', insertCodeBlock)).toBe('```\n\n```');
  });
});

describe('замечание 8: мелкий текст применяется к выделению', () => {
  it('оборачивается выделенный фрагмент, а не вся строка', () => {
    /* Случай заказчика дословно: выделена вторая двойка в `22**2=8`, а
       мелким становилась строка целиком. */
    expect(run('22*[2]*=8', insertSmall)).toBe('22*<small>2</small>*=8');
  });

  it('без выделения работает по строке — это осмысленное намерение', () => {
    expect(run('Подпись к рисунку|', insertSmall)).toBe('<small>Подпись к рисунку</small>');
  });

  it('повторный вызов на обёрнутом фрагменте снимает разметку', () => {
    expect(run('22*[<small>2</small>]*=8', insertSmall)).toBe('22*2*=8');
  });
});

describe('замечание 5: выноска без лишних символов', () => {
  it('метка [!note] прячется, как и маркер цитаты', () => {
    /* Заказчик видел на экране «|> [!note] Текст»: маркер цитаты схлопывался,
       а метку типа не прятал никто. */
    const doc = '> [!note] Осторожно\n\nдалее';
    const hidden = hiddenRanges(makeState(doc, { selection: { anchor: doc.length - 1 } }));
    const hiddenText = hidden.map((range) => doc.slice(range.from, range.to));

    expect(hiddenText.join('')).toContain('[!note]');
    /* И ничего не остаётся от самого маркера цитаты вместе с отбивкой. */
    expect(hiddenText).toContain('> ');
  });

  it('строка выноски получает свой класс, а не класс цитаты', () => {
    const doc = '> [!note] Осторожно\n\nдалее';
    const decos = decorationsOf(makeState(doc, { selection: { anchor: doc.length - 1 } }));
    const classes = decos.map((deco) => deco.class ?? '').join(' ');

    expect(classes).toContain('cm-z-callout');
    expect(classes).not.toContain('cm-z-quote');
  });

  it('обычная цитата выноской не становится', () => {
    /* Обратная сторона: без метки это по-прежнему цитата. Без этой проверки
       можно было бы «починить» выноску, превратив в неё все цитаты. */
    const doc = '> Просто цитата\n\nдалее';
    const decos = decorationsOf(makeState(doc, { selection: { anchor: doc.length - 1 } }));
    const classes = decos.map((deco) => deco.class ?? '').join(' ');

    expect(classes).toContain('cm-z-quote');
    expect(classes).not.toContain('cm-z-callout');
  });
});

describe('замечания 9–11: списки', () => {
  /** Прогоняет команду и отдаёт «текст с курсором», где `|` — позиция курсора. */
  function withCursor(source: string, command: (target: never) => boolean): string {
    let state = stateOf(source);
    const target = {
      state,
      dispatch: (tr: { state: EditorState }) => {
        state = tr.state;
      },
    };
    command(target as never);
    const at = state.selection.main.head;
    const text = state.doc.toString();
    return `${text.slice(0, at)}|${text.slice(at)}`;
  }

  it('маркерный список: курсор остаётся при тексте, а не перед дефисом', () => {
    /* Заказчик: «добавляется `-`, но курсор встаёт перед этим символом».
       Строка заменялась целиком, и позиция курсора схлопывалась к её началу. */
    expect(withCursor('Пункт|', toggleBulletList)).toBe('- Пункт|');
  });

  it('нумерованный список ведёт себя так же', () => {
    expect(withCursor('Пункт|', toggleOrderedList)).toBe('1. Пункт|');
  });

  it('снятие списка тоже не роняет курсор в начало строки', () => {
    expect(withCursor('- Пункт|', toggleBulletList)).toBe('Пункт|');
  });

  it('у задачи дефис перед квадратом не показывается', () => {
    /* В файле пункт остаётся каноническим `- [ ] …`, а на экране роль маркера
       играет сам квадрат — дефис рядом с ним лишний. */
    const doc = '- [ ] Задача\n\nдалее';
    const hidden = hiddenRanges(makeState(doc, { selection: { anchor: doc.length - 1 } }));
    expect(hidden.map((range) => doc.slice(range.from, range.to))).toContain('- ');
  });

  it('у обычного пункта дефис остаётся видимым', () => {
    /* Обратная сторона: прятать маркер у всех списков нельзя — тогда пункты
       перестанут отличаться от абзацев. */
    const doc = '- Пункт\n\nдалее';
    const hidden = hiddenRanges(makeState(doc, { selection: { anchor: doc.length - 1 } }));
    expect(hidden.map((range) => doc.slice(range.from, range.to))).not.toContain('- ');
  });

  it('список получает свой класс — от него идёт сдвиг вправо', () => {
    const doc = '- Пункт\n- Второй\n\nдалее';
    const decos = decorationsOf(makeState(doc, { selection: { anchor: doc.length - 1 } }));
    expect(decos.map((deco) => deco.class ?? '').join(' ')).toContain('cm-z-list');
  });
});

describe('замечание 14: ссылка показывается текстом, а не разметкой', () => {
  it('адрес прячется вместе со скобками — остаётся только подпись', () => {
    /* Заказчик видел «[CMPAS](https://cmpas.ru)» слитным текстом: скобки
       схлопывались, а адрес оставался и приклеивался к подписи. */
    const doc = 'Сайт [CMPAS](https://cmpas.ru) тут';
    const state = makeState(doc, { selection: { anchor: 0 } });
    const hiddenText = hiddenRanges(state).map((range) => doc.slice(range.from, range.to));

    expect(hiddenText.join('')).toContain('https://cmpas.ru');
  });

  it('у автоссылки адрес остаётся видимым', () => {
    /* Обратная сторона: в `https://…` без подписи адрес — единственное, что
       есть, и прятать там нечего. */
    const doc = 'Сайт https://cmpas.ru тут';
    const state = makeState(doc, { selection: { anchor: 0 } });
    const hiddenText = hiddenRanges(state).map((range) => doc.slice(range.from, range.to));

    expect(hiddenText.join('')).not.toContain('cmpas.ru');
  });

  it('курсор внутри ссылки показывает адрес целиком', () => {
    /* Профессиональный режим: в блоке под курсором разметка обязана быть
       видна — иначе ссылку не отредактировать. */
    const doc = 'Сайт [CMPAS](https://cmpas.ru) тут';
    const state = makeState(doc, { selection: { anchor: doc.indexOf('CMPAS') + 2 } });
    const hiddenText = hiddenRanges(state).map((range) => doc.slice(range.from, range.to));

    expect(hiddenText.join('')).not.toContain('https://cmpas.ru');
  });
});
