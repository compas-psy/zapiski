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

  it('cursorAtTitleEnd ставит курсор в конец первой строки', () => {
    const ref = createRef<EditorHandle>();
    mount(<Editor value={'# Заголовок\n\nтело'} cursorAtTitleEnd ref={ref} />);
    expect(ref.current?.view?.state.selection.main.head).toBe(11);
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
  it('первая строка — восемь элементов из BEHAVIOR §2.7', () => {
    const container = mount(<Toolbar view={null} />);
    const rows = container.querySelectorAll('.zpsk-toolbar-row');
    expect(rows.length).toBe(1);
    expect(rows[0]?.querySelectorAll('button').length).toBe(8);
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
    expect(labels).toContain(ru.toolbar.voice);
  });

  it('фото и микрофон уходят наружу колбэками', () => {
    const onPhoto = vi.fn();
    const onVoice = vi.fn();
    const container = mount(<Toolbar view={null} onPhoto={onPhoto} onVoice={onVoice} />);
    const click = (label: string): void => {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      act(() => {
        button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
    };
    click(ru.toolbar.photo);
    click(ru.toolbar.voice);
    expect(onPhoto).toHaveBeenCalledOnce();
    expect(onVoice).toHaveBeenCalledOnce();
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
