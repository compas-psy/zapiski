/**
 * Умная вставка (BEHAVIOR §2.1, §2.6).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { htmlToMarkdown } from '../src/paste/html-to-markdown.js';
import { plainPaste } from '../src/paste/smart-paste.js';
import { makeView } from './helpers.js';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

/** Минимальный DataTransfer для jsdom. */
function clipboard(parts: { text?: string; html?: string; files?: File[] }): DataTransfer {
  const files = parts.files ?? [];
  return {
    getData: (type: string) =>
      type === 'text/html' ? (parts.html ?? '') : (parts.text ?? ''),
    files: {
      length: files.length,
      item: (i: number) => files[i] ?? null,
    },
    items: { length: 0 },
  } as unknown as DataTransfer;
}

function paste(target: EditorView, data: DataTransfer): void {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent & {
    clipboardData: DataTransfer;
  };
  Object.defineProperty(event, 'clipboardData', { value: data });
  target.contentDOM.dispatchEvent(event);
}

describe('HTML → markdown', () => {
  it('заголовки', () => {
    expect(htmlToMarkdown('<h1>Раз</h1><h3>Три</h3>')).toBe('# Раз\n\n### Три');
  });

  it('жирный, курсив, зачёркнутый, подсветка', () => {
    expect(htmlToMarkdown('<p><b>ж</b> <i>к</i> <s>з</s> <mark>п</mark></p>')).toBe(
      '**ж** *к* ~~з~~ ==п==',
    );
  });

  it('маркированный и нумерованный списки, включая вложенные', () => {
    const html = '<ul><li>раз</li><li>два<ul><li>вложенный</li></ul></li></ul>';
    expect(htmlToMarkdown(html)).toBe('- раз\n- два\n  - вложенный');
  });

  it('список задач', () => {
    const html = '<ul><li><input type="checkbox" checked>сделано</li><li><input type="checkbox">нет</li></ul>';
    expect(htmlToMarkdown(html)).toBe('- [x] сделано\n- [ ] нет');
  });

  it('ссылки и изображения', () => {
    expect(htmlToMarkdown('<p><a href="https://ya.ru">Яндекс</a></p>')).toBe(
      '[Яндекс](https://ya.ru)',
    );
    expect(htmlToMarkdown('<p><img src="a.png" alt="кот"></p>')).toBe('![кот](a.png)');
  });

  it('таблица превращается в GFM-таблицу', () => {
    const html =
      '<table><tr><th>Имя</th><th>Год</th></tr><tr><td>Марина</td><td>1990</td></tr></table>';
    expect(htmlToMarkdown(html)).toBe('| Имя | Год |\n| --- | --- |\n| Марина | 1990 |');
  });

  it('цитата и код', () => {
    expect(htmlToMarkdown('<blockquote><p>мысль</p></blockquote>')).toBe('> мысль');
    expect(htmlToMarkdown('<pre><code class="language-js">let a = 1;</code></pre>')).toBe(
      '```js\nlet a = 1;\n```',
    );
    expect(htmlToMarkdown('<p>тут <code>x + 1</code></p>')).toBe('тут `x + 1`');
  });

  it('скрипты и стили выбрасываются', () => {
    expect(htmlToMarkdown('<p>текст</p><script>alert(1)</script>')).toBe('текст');
  });

  it('пустой html даёт пустую строку', () => {
    expect(htmlToMarkdown('   ')).toBe('');
  });
});

describe('вставка в редактор', () => {
  it('html из буфера конвертируется в markdown', () => {
    const v = makeView('', { selection: { anchor: 0 } });
    view = v;
    paste(v, clipboard({ text: 'Раз Два', html: '<h2>Раз</h2><p>Два</p>' }));
    expect(v.state.doc.toString()).toBe('## Раз\n\nДва');
  });

  it('ссылка поверх выделения оборачивает его', () => {
    const v = makeView('документация', { selection: { anchor: 0, head: 12 } });
    view = v;
    paste(v, clipboard({ text: 'https://example.org/doc' }));
    expect(v.state.doc.toString()).toBe('[документация](https://example.org/doc)');
  });

  it('ссылка без выделения вставляется как обычный текст', () => {
    const v = makeView('', { selection: { anchor: 0 } });
    view = v;
    paste(v, clipboard({ text: 'https://example.org' }));
    // Наш обработчик пропустил событие дальше — вставку сделал сам CodeMirror.
    expect(v.state.doc.toString()).toBe('https://example.org');
  });

  it('Ctrl+Shift+V вставляет без форматирования', () => {
    const v = makeView('', { selection: { anchor: 0 } });
    view = v;
    // Команда только помечает режим, вставку делает браузер.
    expect(plainPaste(v)).toBe(false);
    paste(v, clipboard({ text: 'Раз Два', html: '<h2>Раз</h2><p>Два</p>' }));
    expect(v.state.doc.toString()).toBe('Раз Два');
  });

  it('Ctrl+Shift+V поверх выделения не оборачивает URL ссылкой (P1-аудит)', () => {
    /* «Без форматирования» обещает буквальный текст, а не какую-то другую
       разметку взамен — автоссылка над выделением такое же форматирование,
       как и любое другое, и обязана подчиняться тому же флагу. */
    const v = makeView('документация', { selection: { anchor: 0, head: 12 } });
    view = v;
    plainPaste(v);
    paste(v, clipboard({ text: 'https://example.org/doc' }));
    expect(v.state.doc.toString()).toBe('https://example.org/doc');
  });

  it('после обычной вставки метка «без форматирования» сбрасывается', () => {
    const v = makeView('', { selection: { anchor: 0 } });
    view = v;
    plainPaste(v);
    paste(v, clipboard({ text: 'Раз', html: '<h2>Раз</h2>' }));
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '' } });
    paste(v, clipboard({ text: 'Два', html: '<h2>Два</h2>' }));
    expect(v.state.doc.toString()).toBe('## Два');
  });

  describe('вставка не переопределяет соседний блок (MVP P0 §9)', () => {
    /*
     * Заказчик (через аудит): «Обычный абзац» + вставка «---» не имеет права
     * стать Setext H2 — тот же класс ловушки, что и ручной ввод/тулбар, но
     * `smart-paste.ts` вставлял обычный текст напрямую через
     * `insertText()`/нативную вставку CodeMirror, минуя всякую проверку.
     */
    it('"---" после абзаца получает пустую строку перед собой, а не становится H2', () => {
      const v = makeView('Обычный абзац\n', { selection: { anchor: 14 } });
      view = v;
      paste(v, clipboard({ text: '---' }));
      expect(v.state.doc.toString()).toBe('Обычный абзац\n\n---');
    });

    it('"===" после абзаца не становится H1', () => {
      const v = makeView('Обычный абзац\n', { selection: { anchor: 14 } });
      view = v;
      paste(v, clipboard({ text: '===' }));
      expect(v.state.doc.toString()).toBe('Обычный абзац\n\n===');
    });

    it('маркированный список из буфера не прерывает абзац лишним слиянием', () => {
      const v = makeView('Варианты:\n', { selection: { anchor: 10 } });
      view = v;
      paste(v, clipboard({ text: '- раз\n- два' }));
      expect(v.state.doc.toString()).toBe('Варианты:\n\n- раз\n- два');
    });

    it('нумерованный список из буфера — та же защита', () => {
      const v = makeView('Шаги:\n', { selection: { anchor: 6 } });
      view = v;
      paste(v, clipboard({ text: '1. раз' }));
      expect(v.state.doc.toString()).toBe('Шаги:\n\n1. раз');
    });

    it('цитата из буфера — та же защита', () => {
      const v = makeView('Комментарий:\n', { selection: { anchor: 13 } });
      view = v;
      paste(v, clipboard({ text: '> цитата' }));
      expect(v.state.doc.toString()).toBe('Комментарий:\n\n> цитата');
    });

    it('уже есть пустая строка — лишней не добавляется', () => {
      const v = makeView('Обычный абзац\n\n', { selection: { anchor: 15 } });
      view = v;
      paste(v, clipboard({ text: '---' }));
      expect(v.state.doc.toString()).toBe('Обычный абзац\n\n---');
    });

    it('вставка внутрь списка не разбавляется лишней пустой строкой', () => {
      const v = makeView('- один\n- ', { selection: { anchor: 9 } });
      view = v;
      paste(v, clipboard({ text: '---' }));
      expect(v.state.doc.toString()).toBe('- один\n- ---');
    });

    it('обычный текст без опасного начала вставляется как раньше', () => {
      const v = makeView('Обычный абзац\n', { selection: { anchor: 14 } });
      view = v;
      paste(v, clipboard({ text: 'Ещё текст' }));
      expect(v.state.doc.toString()).toBe('Обычный абзац\nЕщё текст');
    });

    /*
     * P1-аудит: защита срабатывала по «опасная ли строка НАД целевой», но
     * никогда не проверяла, что курсор вообще стоит в НАЧАЛЕ этой строки.
     * Вставка посреди слова с опасной строкой выше получала точно такую же
     * вставленную пустую строку — но уже не перед абзацем, а прямо посреди
     * набранного слова: абзац рвался пополам, а хвост строки превращался в
     * самостоятельный список/цитату, которых никто не просил.
     */
    it('вставка посреди слова не разрубает строку и не плодит фантомный список', () => {
      const doc = 'Первая строка абзаца\nВторая строка абзаца';
      const pos = doc.indexOf('строка', doc.indexOf('\n')) + 4; // «Вторая стро|ка»
      const v = makeView(doc, { selection: { anchor: pos } });
      view = v;
      paste(v, clipboard({ text: '- item' }));

      // Никакой пустой строки не вставлено — просто буквальная склейка,
      // как при обычном наборе символов посреди слова.
      expect(v.state.doc.toString()).toBe(
        'Первая строка абзаца\nВторая стро- itemка абзаца',
      );
    });

    it('вставка посреди слова внутри цитаты не выходит из цитаты', () => {
      const doc = '> Первая строка\n> Вторая строка';
      const pos = doc.indexOf('Вторая') + 4; // «> Втор|ая строка»
      const v = makeView(doc, { selection: { anchor: pos } });
      view = v;
      paste(v, clipboard({ text: '- item' }));

      expect(v.state.doc.toString()).toBe('> Первая строка\n> Втор- itemая строка');
    });

    it('замена выделения посреди слова той же опасной строкой не рвёт абзац', () => {
      const doc = 'Первая строка абзаца\nВторая строка абзаца';
      const from = doc.indexOf('строка', doc.indexOf('\n'));
      const to = from + 'строка'.length;
      const v = makeView(doc, { selection: { anchor: from, head: to } });
      view = v;
      paste(v, clipboard({ text: '> quote' }));

      expect(v.state.doc.toString()).toBe('Первая строка абзаца\nВторая > quote абзаца');
    });
  });

  it('картинка уходит в колбэк и вставляется как ![](attachments/…)', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'кот.png', { type: 'image/png' });
    const onPaste = vi.fn(async () => 'attachments/2026-08-09_ab12.png');
    const v = makeView('', {
      selection: { anchor: 0 },
      runtime: { pasteImage: onPaste },
    });
    view = v;
    paste(v, clipboard({ files: [file] }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onPaste).toHaveBeenCalledOnce();
    expect(v.state.doc.toString()).toBe('![](attachments/2026-08-09_ab12.png)');
  });

  it('неудачная вставка картинки не ломает и не блокирует ввод', async () => {
    const file = new File([new Uint8Array([1])], 'кот.png', { type: 'image/png' });
    const v = makeView('текст', {
      selection: { anchor: 5 },
      runtime: { pasteImage: async () => null },
    });
    view = v;
    paste(v, clipboard({ files: [file] }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(v.state.doc.toString()).toBe('текст');
    v.dispatch({ changes: { from: 5, insert: '!' } });
    expect(v.state.doc.toString()).toBe('текст!');
  });
});
