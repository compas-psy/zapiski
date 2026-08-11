/**
 * React-обёртка и тулбар (BEHAVIOR §2.7, SCREENS §4).
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { Editor } from '../src/react/Editor.js';
import type { EditorHandle } from '../src/react/Editor.js';
import { Toolbar } from '../src/react/Toolbar.js';
import { ru } from '../src/i18n.js';

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(node);
  });
  return host;
}

/**
 * Backspace через настоящее событие клавиатуры, а не вызовом команды: проверять
 * надо именно keymap — что наш обработчик стоит выше штатного удаления.
 */
function backspace(view: { contentDOM: HTMLElement } | null | undefined): void {
  view?.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
});

describe('<Editor/>', () => {
  it('монтируется и показывает текст', () => {
    const container = mount(<Editor value={'# Заголовок\n\nТекст'} />);
    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(container.textContent).toContain('Заголовок');
  });

  it('сообщает об изменениях через onChange', () => {
    const onChange = vi.fn();
    const ref = createRef<EditorHandle>();
    mount(<Editor value="текст" onChange={onChange} ref={ref} />);
    act(() => {
      ref.current?.view?.dispatch({ changes: { from: 5, insert: '!' } });
    });
    expect(onChange).toHaveBeenCalledWith('текст!');
  });

  it('внешнее изменение value применяется к документу', () => {
    const ref = createRef<EditorHandle>();
    mount(<Editor value="старый" ref={ref} />);
    act(() => {
      root?.render(<Editor value="новый" ref={ref} />);
    });
    expect(ref.current?.view?.state.doc.toString()).toBe('новый');
  });

  it('ref даёт доступ к представлению и принудительному сохранению', () => {
    const onSave = vi.fn();
    const ref = createRef<EditorHandle>();
    mount(<Editor value="текст" onSave={onSave} ref={ref} />);
    act(() => {
      ref.current?.view?.dispatch({ changes: { from: 5, insert: '.' } });
    });
    act(() => {
      ref.current?.save();
    });
    expect(onSave).toHaveBeenCalledWith('текст.');
  });

  /**
   * `cursorAtTitleEnd` был нужен, пока заголовок жил первой строкой текста.
   * ITERATION-1 §1 вынес его в отдельное поле, и редактор теперь получает
   * только тело — ставить курсор «в конец заголовка» стало некуда. Взамен
   * `focusStart` уводит курсор в начало тела: это Enter и Tab из поля
   * заголовка.
   */
  it('focusStart ставит курсор в начало тела', () => {
    const ref = createRef<EditorHandle>();
    mount(<Editor value={'первая строка\n\nвторая'} ref={ref} />);
    act(() => {
      ref.current?.focusStart();
    });
    expect(ref.current?.view?.state.selection.main.head).toBe(0);
  });

  it('Backspace в начале тела отдаётся приложению, а не удаляет символ', () => {
    const ref = createRef<EditorHandle>();
    let asked = 0;
    mount(
      <Editor
        value={'тело'}
        ref={ref}
        onBackspaceAtStart={() => {
          asked += 1;
          return true;
        }}
      />,
    );
    const view = ref.current?.view;
    act(() => {
      view?.dispatch({ selection: { anchor: 0 } });
    });
    act(() => {
      backspace(view);
    });
    expect(asked).toBe(1);
    /* Текст цел: приложение сказало «обработал», подниматься курсору в
       заголовок, а не съедать первый символ. */
    expect(view?.state.doc.toString()).toBe('тело');
  });

  it('режим фокуса и raw-режим управляются пропсами', () => {
    const ref = createRef<EditorHandle>();
    mount(<Editor value="текст" ref={ref} />);
    act(() => {
      root?.render(<Editor value="текст" focusMode rawMode ref={ref} />);
    });
    const view = ref.current?.view;
    expect(view?.dom.querySelector('.cm-z-focus-hint')).not.toBeNull();
    expect(view?.contentDOM.classList.contains('cm-z-raw')).toBe(true);
  });

  it('размонтирование сохраняет несохранённое', () => {
    const onSave = vi.fn();
    const ref = createRef<EditorHandle>();
    mount(<Editor value="текст" onSave={onSave} ref={ref} />);
    act(() => {
      ref.current?.view?.dispatch({ changes: { from: 5, insert: '…' } });
    });
    act(() => {
      root?.unmount();
    });
    root = null;
    expect(onSave).toHaveBeenCalledWith('текст…');
  });
});

describe('<Toolbar/>', () => {
  it('первая строка — семь элементов: BEHAVIOR §2.7 минус микрофон (Р4)', () => {
    const container = mount(<Toolbar view={null} />);
    const rows = container.querySelectorAll('.zpsk-toolbar-row');
    expect(rows.length).toBe(1);
    expect(rows[0]?.querySelectorAll('button').length).toBe(7);
  });

  it('«⋯» открывает вторую строку с семью элементами', () => {
    const container = mount(<Toolbar view={null} />);
    const more = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${ru.toolbar.more}"]`,
    );
    act(() => {
      more?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    const rows = container.querySelectorAll('.zpsk-toolbar-row');
    expect(rows.length).toBe(2);
    expect(rows[1]?.querySelectorAll('button').length).toBe(7);
  });

  it('кнопки подписаны для доступности', () => {
    const container = mount(<Toolbar view={null} />);
    const labels = Array.from(container.querySelectorAll('button')).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toContain(ru.toolbar.bold);
    expect(labels).toContain(ru.toolbar.photo);
  });

  /**
   * Решение Р4 мастер-ТЗ: голос — P1, микрофон из тулбара v1 убран, потому что
   * «пустая кнопка „скоро“ в самом частом месте интерфейса хуже её
   * отсутствия». Сторожится составом первой строки целиком, а не отсутствием
   * одной подписи: вернуть кнопку под другим именем так не выйдет.
   */
  it('в первой строке ровно семь кнопок ТЗ, микрофона среди них нет', () => {
    const container = mount(<Toolbar view={null} />);
    const first = container.querySelector('.zpsk-toolbar-row');
    const labels = Array.from(first?.querySelectorAll('button') ?? []).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      ru.toolbar.heading,
      ru.toolbar.bold,
      ru.toolbar.italic,
      ru.toolbar.bulletList,
      ru.toolbar.task,
      ru.toolbar.photo,
      ru.toolbar.more,
    ]);
  });

  it('фото уходит наружу колбэком', () => {
    const onPhoto = vi.fn();
    const container = mount(<Toolbar view={null} onPhoto={onPhoto} />);
    const button = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${ru.toolbar.photo}"]`,
    );
    act(() => {
      button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onPhoto).toHaveBeenCalledOnce();
  });

  it('«H» в тулбаре крутит уровень заголовка в живом редакторе', () => {
    const ref = createRef<EditorHandle>();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(<Editor value="Текст" ref={ref} />);
    });
    const view = ref.current?.view ?? null;
    const toolbarHost = document.createElement('div');
    document.body.appendChild(toolbarHost);
    const toolbarRoot = createRoot(toolbarHost);
    act(() => {
      toolbarRoot.render(<Toolbar view={view} />);
    });
    const heading = toolbarHost.querySelector<HTMLButtonElement>(
      `button[aria-label="${ru.toolbar.heading}"]`,
    );
    act(() => {
      heading?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(view?.state.doc.toString()).toBe('# Текст');
    act(() => {
      toolbarRoot.unmount();
    });
    toolbarHost.remove();
  });
});
