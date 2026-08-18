/**
 * Определение текущего блока (ITERATION-1 §4).
 *
 * Меню панели помечают галочкой текущий вариант — «Заголовок», «Текст»,
 * «Список с маркерами». Без верного определения галочка врёт, а это хуже её
 * отсутствия: человек читает её как факт.
 */
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { blockStyleAt, inlineActiveAt, listStyleAt } from '../src/commands/block-state.js';

/** Состояние с курсором на позиции `|` в тексте. */
function at(text: string): EditorState {
  const pos = text.indexOf('|');
  const doc = text.replace('|', '');
  return EditorState.create({ doc, selection: { anchor: pos } });
}

describe('стиль абзаца', () => {
  it('обычный текст', () => {
    expect(blockStyleAt(at('прос|то текст'))).toBe('text');
  });

  it('заголовки всех шести уровней', () => {
    for (let level = 1; level <= 6; level += 1) {
      expect(blockStyleAt(at(`${'#'.repeat(level)} Заго|ловок`))).toBe(`h${level}`);
    }
  });

  it('семь решёток — уже не заголовок', () => {
    /* Markdown знает шесть уровней; седьмая решётка — просто текст. */
    expect(blockStyleAt(at('####### не заго|ловок'))).toBe('text');
  });

  it('цитата', () => {
    expect(blockStyleAt(at('> ци|тата'))).toBe('quote');
  });

  it('выноска — не просто цитата', () => {
    expect(blockStyleAt(at('> [!note] вни|мание'))).toBe('callout');
  });

  it('мелкий текст', () => {
    expect(blockStyleAt(at('<small>сно|ска</small>'))).toBe('small');
  });

  it('строка внутри код-блока', () => {
    /* Сама строка ничем не отличается от обычного текста — опознаётся по
       ограждению выше. */
    expect(blockStyleAt(at('```js\nconst a| = 1\n```'))).toBe('code');
  });

  it('строка после закрытого код-блока — снова текст', () => {
    expect(blockStyleAt(at('```\nкод\n```\nпо|сле'))).toBe('text');
  });
});

describe('тип списка', () => {
  it('без списка', () => {
    expect(listStyleAt(at('прос|то текст'))).toBe('none');
  });

  it('маркированный', () => {
    expect(listStyleAt(at('- пун|кт'))).toBe('bullet');
    expect(listStyleAt(at('* пун|кт'))).toBe('bullet');
  });

  it('нумерованный', () => {
    expect(listStyleAt(at('1. пун|кт'))).toBe('ordered');
    expect(listStyleAt(at('2) пун|кт'))).toBe('ordered');
  });

  it('чек-лист опознаётся раньше маркированного', () => {
    /* `- [ ] дело` подходит и под маркированный: порядок проверок важен. */
    expect(listStyleAt(at('- [ ] де|ло'))).toBe('task');
    expect(listStyleAt(at('- [x] сде|лано'))).toBe('task');
  });

  it('сворачиваемый блок', () => {
    expect(listStyleAt(at('<details><summary>Ито|ги</summary>'))).toBe('details');
  });
});

describe('парные маркеры под курсором', () => {
  it('жирный', () => {
    expect(inlineActiveAt(at('это **важ|но** и всё')).bold).toBe(true);
    expect(inlineActiveAt(at('это **важно** и| всё')).bold).toBe(false);
  });

  it('подчёркнутый виден по паре разных тегов', () => {
    /* У остальных начертаний маркеры одинаковы с обеих сторон, а тут `<u>` и
       `</u>` — проверка парности пришлось написать свою, и вот она. */
    expect(inlineActiveAt(at('это <u>важ|но</u> и всё')).underline).toBe(true);
    expect(inlineActiveAt(at('это <u>важно</u> и| всё')).underline).toBe(false);
  });

  it('курсив не срабатывает внутри жирного', () => {
    /* `**жирный**` состоит из звёздочек, и наивная проверка одиночной
       звёздочкой считала бы его курсивом. */
    expect(inlineActiveAt(at('это **важ|но** и всё')).italic).toBe(false);
    expect(inlineActiveAt(at('это *кур|сив* и всё')).italic).toBe(true);
  });

  it('зачёркнутый, подсветка и код', () => {
    expect(inlineActiveAt(at('~~уб|рано~~')).strike).toBe(true);
    expect(inlineActiveAt(at('==ярк|ое==')).highlight).toBe(true);
    expect(inlineActiveAt(at('`ко|д`')).code).toBe(true);
  });

  it('незакрытая пара не считается', () => {
    expect(inlineActiveAt(at('это **нез|акрыто')).bold).toBe(false);
  });
});
