/**
 * Три замечания заказчика по командам разметки, по одному describe на каждое.
 *
 * Общее у них то, что все три ломались молча: разметка в файл ложилась
 * правильная, а на экране получалось не то, что человек просил.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { insertCollapsible, insertQuoteAuthor, insertSmall } from '../src/commands/blocks';
import { insertCodeBlock, toggleBulletList, toggleOrderedList } from '../src/commands/formatting';
import { decorationsOf, hiddenRanges, makeState } from './helpers.js';
import { toggleCollapsed } from '../src/live-preview/collapsed';

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

describe('замечание 12: сворачиваемый блок работает, а не выдаёт xml', () => {
  const DOC = '<details>\n<summary>Заголовок</summary>\n\nТело\n\n</details>';

  it('теги прячутся — на экране остаётся заголовок', () => {
    /* Заказчик: «просто выдаёт xml, заполняя который ничего не происходит». */
    const state = makeState(DOC, { selection: { anchor: DOC.length } });
    const hiddenText = hiddenRanges(state).map((range) => DOC.slice(range.from, range.to));

    expect(hiddenText.join('')).toContain('<details>');
    expect(hiddenText.join('')).toContain('<summary>');
    expect(hiddenText.join('')).toContain('</summary>');
  });

  it('строка заголовка помечена — от неё идёт стрелка', () => {
    const state = makeState(DOC, { selection: { anchor: DOC.length } });
    const classes = decorationsOf(state)
      .map((deco) => deco.class ?? '')
      .join(' ');
    expect(classes).toContain('cm-z-summary');
  });

  it('свёрнутый блок прячет тело, не трогая текст', () => {
    /* Свёрнутость — состояние показа: в файле `<details>` всегда записан
       целиком, и заметка открывается в чужом редакторе так же. */
    const state = makeState(DOC, { selection: { anchor: DOC.length } });
    const collapsed = state.update({ effects: toggleCollapsed.of(0) }).state;

    const classes = decorationsOf(collapsed)
      .map((deco) => deco.class ?? '')
      .join(' ');
    expect(classes).toContain('cm-z-collapsed');
    /* Текст документа при этом не изменился ни на символ. */
    expect(collapsed.doc.toString()).toBe(DOC);
  });

  it('повторное переключение разворачивает обратно', () => {
    const state = makeState(DOC, { selection: { anchor: DOC.length } });
    const once = state.update({ effects: toggleCollapsed.of(0) }).state;
    const twice = once.update({ effects: toggleCollapsed.of(0) }).state;

    /*
     * Проверяется тело, а не отсутствие класса вообще.
     *
     * Одна скрытая строка в развёрнутом блоке остаётся законно: пустая строка
     * сразу под заголовком стоит там ради CommonMark (без неё markdown внутри
     * не разбирается), человек её не писал и видеть не должен. Раньше тест
     * требовал «ни одной скрытой строки» и на этой строительной подпорке
     * падал, хотя тело как раз показывалось.
     */
    const hidden = new Set(
      decorationsOf(twice)
        .filter((deco) => (deco.class ?? '').includes('cm-z-collapsed'))
        .map((deco) => deco.from),
    );
    const body = twice.doc.line(4);

    expect(body.text, 'взята не та строка — проверка смотрит не на тело').toBe('Тело');
    expect(hidden.has(body.from), 'тело осталось скрытым после разворачивания').toBe(false);
  });
});

describe('замечание 13: таблица читается колонками, а не каркасом', () => {
  const DOC = '| Колонка | Колонка |\n| --- | --- |\n| раз | два |\n\nдалее';

  it('служебная строка `| --- |` не показывается', () => {
    /* Она нужна разбору, а не читателю: без неё markdown перестаёт считать
       это таблицей, поэтому в файле она остаётся. */
    const state = makeState(DOC, { selection: { anchor: DOC.length - 1 } });
    const classes = decorationsOf(state)
      .map((deco) => deco.class ?? '')
      .join(' ');
    expect(classes).toContain('cm-z-table-rule');
  });

  it('палки между ячейками спрятаны, а ячейки помечены', () => {
    const state = makeState(DOC, { selection: { anchor: DOC.length - 1 } });
    const hiddenText = hiddenRanges(state).map((range) => DOC.slice(range.from, range.to));
    expect(hiddenText).toContain('|');

    const classes = decorationsOf(state)
      .map((deco) => deco.class ?? '')
      .join(' ');
    expect(classes).toContain('cm-z-table-cell');
  });

  it('курсор в таблице возвращает разметку целиком', () => {
    /* Иначе таблицу не отредактировать: границы ячеек — это и есть палки. */
    const state = makeState(DOC, { selection: { anchor: DOC.indexOf('раз') } });
    const hiddenText = hiddenRanges(state).map((range) => DOC.slice(range.from, range.to));
    expect(hiddenText).not.toContain('|');

    const classes = decorationsOf(state)
      .map((deco) => deco.class ?? '')
      .join(' ');
    expect(classes).not.toContain('cm-z-table-rule');
  });
});

describe('замечание 4: автор цитаты', () => {
  it('пункт добавляет строку атрибуции к цитате', () => {
    expect(run('> Мысль|', insertQuoteAuthor)).toBe('> Мысль\n> — ');
  });

  it('вне цитаты не срабатывает', () => {
    /* Автор без цитаты — просто тире посреди текста. */
    expect(run('Обычный абзац|', insertQuoteAuthor)).toBe('Обычный абзац');
  });

  it('пустая атрибуция не занимает места в просмотре', () => {
    /* Прямое требование: «если пользователь не вбивает автора, место под него
       в режиме просмотра не должно оставаться». */
    const doc = '> Мысль\n> — \n\nдалее';
    const classes = decorationsOf(makeState(doc, { selection: { anchor: doc.length - 1 } }))
      .map((deco) => deco.class ?? '')
      .join(' ');
    expect(classes).toContain('cm-z-collapsed');
  });

  it('заполненная показывается подписью', () => {
    const doc = '> Мысль\n> — Автор\n\nдалее';
    const classes = decorationsOf(makeState(doc, { selection: { anchor: doc.length - 1 } }))
      .map((deco) => deco.class ?? '')
      .join(' ');
    expect(classes).toContain('cm-z-quote-author');
    expect(classes).not.toContain('cm-z-collapsed');
  });
});

describe('дефекты со снимков экрана', () => {
  it('курсор встаёт ЗА маркером и на пустой строке', () => {
    /* На непустой строке дефект не воспроизводился, поэтому и дожил до
       второго круга: курсор стоял в позиции 0, маркер вставлялся туда же и
       позиция «прилипала» к началу вставки — `|- `. */
    const doc = '';
    let state = EditorState.create({ doc, selection: EditorSelection.cursor(0) });
    toggleBulletList({
      state,
      dispatch: (tr: { state: EditorState }) => {
        state = tr.state;
      },
    } as never);
    expect(state.selection.main.head).toBe(state.doc.length);
  });

  it('мелкий текст показывается мелким, а теги прячутся', () => {
    /* «Вставка мелкого текста не работает»: команда его вставляла, а показ —
       нет, на экране оставалась сырая разметка. */
    const doc = 'Проба <small>2</small> дальше';
    const state = makeState(doc, { selection: { anchor: 0 } });
    const hiddenText = hiddenRanges(state).map((range) => doc.slice(range.from, range.to));
    expect(hiddenText).toContain('<small>');
    expect(hiddenText).toContain('</small>');

    const classes = decorationsOf(state)
      .map((deco) => deco.class ?? '')
      .join(' ');
    expect(classes).toContain('cm-z-small');
  });

  it('путь с пробелом остаётся вложением, а не текстом', () => {
    /* Папка «Other files» с пробелом разрывала ссылку: markdown читал её как
       ссылку на «Other», а хвост — обычным текстом. Экранируется угловыми
       скобками, и разбор обязан их понимать. */
    const doc = '[](<Other files/смета.docx>)';
    const state = makeState(doc, {
      selection: { anchor: doc.length },
      /* Карточка рисуется только для вложения, которое хранилище умеет
         показать, — поэтому подставляем разрешение пути. */
      runtime: { resolveAttachment: (src: string) => `blob:${src}` },
    });
    const widgets = decorationsOf(state)
      .map((deco) => deco.widget ?? '')
      .join(' ');
    expect(widgets).toContain('FileWidget');
  });
});

describe('маркеры внутри сворачиваемого блока', () => {
  it('тело отделено пустой строкой — иначе markdown внутри не работает', () => {
    /* HTML-блок тянется до пустой строки: без неё список внутри `<details>`
       остаётся частью html и списком не становится. Заказчик увидел это как
       «булеты не появляются». */
    const text = run('Заголовок|', insertCollapsible);
    const lines = text.split('\n');
    const summaryAt = lines.findIndex((line) => line.includes('<summary>'));

    expect(summaryAt).toBeGreaterThan(-1);
    expect(lines[summaryAt + 1], 'после <summary> нет пустой строки').toBe('');
    expect(lines[lines.length - 2], 'перед </details> нет пустой строки').toBe('');
  });

  it('список внутри блока остаётся списком', () => {
    const doc = '<details>\n<summary>Заголовок</summary>\n\n- Первый\n- Второй\n\n</details>';
    const decos = decorationsOf(makeState(doc, { selection: { anchor: doc.length } }));
    expect(decos.map((deco) => deco.class ?? '').join(' ')).toContain('cm-z-list-mark');
  });
});

/**
 * Правки по снимкам веб-версии от заказчика.
 */
describe('снимки веб-версии', () => {
  it('закрывающий `</details>` не печатается в тексте', () => {
    /* На снимке под заголовком блока стояло голое `</details>` — разметка,
       которую заказчик не писал и убрать не мог. Так выходит, когда тело не
       отделено от `<summary>` пустой строкой: html-блок по правилу CommonMark
       тянется до первой пустой строки и утаскивает закрывающий тег внутрь. */
    const doc = ['<details>', '<summary>Заголовок</summary>', 'Тело', '</details>', '', 'хвост'].join(
      '\n',
    );
    /* Курсор в хвосте: внутри блока разметка показывается нарочно — иначе её
       не поправить. */
    const found = decorationsOf(makeState(doc, { selection: { anchor: doc.length } }));
    const closing = doc.indexOf('</details>');
    const hidden = found.some(
      (deco) => deco.from <= closing && deco.to >= closing + '</details>'.length && deco.class === null,
    );
    expect(hidden, 'закрывающий тег остался видимым').toBe(true);
  });

  it('разметка картинки прячется целиком', () => {
    /* На снимке над картинкой стояла строка `|320Images/…png`: подпись с
       шириной и путь торчали обычным текстом. */
    const doc = '![подпись|320](Images/кот.png)';
    const found = decorationsOf(
      makeState(doc + '\n\nхвост', {
        runtime: { resolveAttachment: (src: string) => `blob:${src}` },
        selection: { anchor: doc.length + 3 },
      }),
    );
    const hidden = found.some((deco) => deco.from === 0 && deco.to === doc.length);
    expect(hidden, 'разметка картинки осталась на экране').toBe(true);
  });

  it('надстрочный и подстрочный набираются тегами', () => {
    /* Своего синтаксиса у markdown для них нет: `<sup>`/`<sub>` — то, что
       понимают GitHub, Obsidian и браузер. */
    const doc = '2<sup>2</sup> и H<sub>2</sub>O';
    const found = decorationsOf(makeState(doc, { selection: { anchor: doc.length } }));
    expect(found.some((deco) => deco.class === 'cm-z-sup')).toBe(true);
    expect(found.some((deco) => deco.class === 'cm-z-sub')).toBe(true);
  });

  it('подчёркнутый набирается тегом и показывается подчёркиванием', () => {
    /*
     * Заказчик просил кнопку «подчёркнутый» рядом с курсивом и зачёркнутым.
     * Своего знака у markdown для него нет — берём тот же html, что уже взят
     * для надстрочного: `<u>` понимают все, а выдуманный синтаксис читался бы
     * правильно только у нас.
     */
    const doc = 'обычный <u>подчёркнутый</u> текст';
    const found = decorationsOf(makeState(doc, { selection: { anchor: doc.length } }));
    expect(found.some((deco) => deco.class === 'cm-z-u'), 'подчёркивание не нарисовано').toBe(true);
    /* Сами теги на экране не нужны: курсор далеко, показывать их незачем. */
    const marker = doc.indexOf('<u>');
    expect(
      found.some((deco) => deco.from === marker && deco.to === marker + 3),
      'тег <u> остался на экране',
    ).toBe(true);
  });
});
