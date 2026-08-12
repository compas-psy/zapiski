/**
 * Ссылка диалогом «Текст» + «Адрес» (ITERATION-1 §4).
 *
 * Прежняя кнопка вставляла `[текст]()` и ставила курсор внутрь скобок.
 * Работает, но требует знать разметку: человек видит две пары скобок и должен
 * догадаться, что адрес идёт во вторую. §4 просит поле и поле — с
 * предзаполнением из выделения.
 *
 * Проверяется модель: что показать в полях и какой текст ляжет в файл.
 * Про DOM здесь нет ни строчки — ровность результата видно только текстом.
 */
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { applyLink, linkDraft } from '../src/commands/link.js';

/** Состояние с курсором на `|` или с выделением между двумя `|`. */
function at(text: string): EditorState {
  const first = text.indexOf('|');
  const second = text.indexOf('|', first + 1);
  const doc = text.replace(/\|/g, '');
  if (second === -1) {
    return EditorState.create({ doc, selection: { anchor: Math.max(0, first) } });
  }
  return EditorState.create({ doc, selection: { anchor: first, head: second - 1 } });
}

/** Итоговый текст документа после вставки — то, что ляжет в файл. */
function inserted(state: EditorState, text: string, url: string): string {
  const draft = linkDraft(state);
  return state.update(applyLink(draft, text, url)).state.doc.toString();
}

describe('чем заполняются поля', () => {
  it('выделенная подпись идёт в «Текст»', () => {
    const draft = linkDraft(at('см. |документацию| дальше'));
    expect(draft.text).toBe('документацию');
    expect(draft.url).toBe('');
    expect(draft.editing).toBe(false);
  });

  it('выделенный адрес идёт в «Адрес», а не в «Текст»', () => {
    /* Частый случай: скопировали ссылку, вставили, выделили, нажали кнопку.
       Подпись «https://…» в поле «Текст» пришлось бы стирать руками. */
    const draft = linkDraft(at('|https://example.org/док|'));
    expect(draft.url).toBe('https://example.org/док');
    expect(draft.text).toBe('');
  });

  it('без выделения оба поля пустые', () => {
    const draft = linkDraft(at('просто текст|'));
    expect(draft).toMatchObject({ text: '', url: '', editing: false });
  });

  it('курсор внутри готовой ссылки — правка, а не вставка второй', () => {
    /* Иначе поправить адрес значило бы сначала стереть ссылку руками. */
    const draft = linkDraft(at('см. [дока|](https://example.org) дальше'));
    expect(draft).toMatchObject({
      text: 'дока',
      url: 'https://example.org',
      editing: true,
    });
  });

  it('соседняя ссылка на той же строке не подменяет текущую', () => {
    const draft = linkDraft(at('[раз](a) и [дв|а](b)'));
    expect(draft.url).toBe('b');
  });

  it('курсор рядом со ссылкой, но вне её — обычная вставка', () => {
    const draft = linkDraft(at('[раз](a) |хвост'));
    expect(draft.editing).toBe(false);
  });
});

describe('что ложится в файл', () => {
  it('текст и адрес собираются в разметку markdown', () => {
    expect(inserted(at('см. |документацию| дальше'), 'документацию', 'https://example.org')).toBe(
      'см. [документацию](https://example.org) дальше',
    );
  });

  it('правка заменяет ссылку целиком, а не дописывает рядом', () => {
    expect(inserted(at('см. [дока|](https://old.example) дальше'), 'дока', 'https://new.example')).toBe(
      'см. [дока](https://new.example) дальше',
    );
  });

  it('пустой адрес — валидная ссылка, курсор встаёт внутрь скобок', () => {
    /* Человек мог открыть диалог, чтобы подписать текст, а адрес вставить
       потом. Терять набранное из-за пустого поля нельзя. */
    const state = at('|подпись|');
    const draft = linkDraft(state);
    const next = state.update(applyLink(draft, 'подпись', ''));
    expect(next.state.doc.toString()).toBe('[подпись]()');
    expect(next.state.selection.main.head).toBe('[подпись](' .length);
  });

  it('пустой текст с адресом даёт форму вложения', () => {
    expect(inserted(at('|'), '', 'attachments/файл.pdf')).toBe('[](attachments/файл.pdf)');
  });
});
