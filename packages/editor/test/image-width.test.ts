/**
 * Размер картинки в заметке и обрезка файла (замечание 2).
 *
 * «Изображение вставляется, но его нельзя кропить и менять масштаб —
 * получается лажа с большими изображениями». Это две разные вещи, и они
 * намеренно разведены: размер живёт в РАЗМЕТКЕ (подпись `![…|400]`, соглашение
 * Obsidian — в самом markdown размеров нет), обрезка меняет САМ ФАЙЛ.
 */
import { EditorState } from '@codemirror/state';
import { imageWidthOf, setImageWidth } from '../src/commands/image';
import { describe, expect, it } from 'vitest';


/** Прогоняет команду над текстом и отдаёт результат. */
function run(doc: string, command: (target: never) => boolean): string {
  let state = EditorState.create({ doc });
  command({
    state,
    dispatch: (tr: { state: EditorState }) => {
      state = tr.state;
    },
  } as never);
  return state.doc.toString();
}

describe('ширина картинки живёт в подписи', () => {
  it('читается из подписи', () => {
    expect(imageWidthOf('схема|420')).toBe(420);
    expect(imageWidthOf('схема')).toBeNull();
  });

  it('задаётся, не трогая путь', () => {
    expect(run('![схема](Images/a.png)', setImageWidth('Images/a.png', 420))).toBe(
      '![схема|420](Images/a.png)',
    );
  });

  it('меняется, а не накапливается', () => {
    expect(run('![схема|420](Images/a.png)', setImageWidth('Images/a.png', 240))).toBe(
      '![схема|240](Images/a.png)',
    );
  });

  it('сбрасывается в исходный размер', () => {
    expect(run('![схема|420](Images/a.png)', setImageWidth('Images/a.png', null))).toBe(
      '![схема](Images/a.png)',
    );
  });

  it('чужие картинки не трогает', () => {
    /* Без этой проверки команда, работающая по всему документу, однажды
       переразмерит все картинки заметки разом. */
    const doc = '![а](Images/a.png)\n\n![б](Images/b.png)';
    expect(run(doc, setImageWidth('Images/b.png', 300))).toBe(
      '![а](Images/a.png)\n\n![б|300](Images/b.png)',
    );
  });
});
