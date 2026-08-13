/**
 * Ввод формулы LaTeX (ITERATION-1 §4).
 *
 * Заказчик: «ты тихой сапой забыл про формулы LaTeX с вводом через виджет».
 * Кнопка и строки были готовы давно, но KaTeX не входил в сборку, и кнопка
 * пряталась — §4 это разрешает: «нет кнопки лучше, чем есть и не работает».
 * Теперь KaTeX в сборке, и кнопка появилась вместе с этим диалогом.
 *
 * Почему диалог, а не «вставить `$$` и печатайте». LaTeX не набирают вслепую:
 * ошибка в одной скобке ломает всю формулу, и увидеть это надо ДО того, как
 * она попала в текст. Поэтому здесь поле и живой показ под ним — то же, что
 * человек получит в заметке.
 *
 * В файле остаётся `$формула$` — соглашение, которое понимают Obsidian,
 * GitHub и Pandoc. Своего синтаксиса не выдумываем.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import katex from 'katex';
import type { EditorView } from '@codemirror/view';

import type { EditorStrings } from '../i18n.js';

export interface FormulaDialogProps {
  copy: EditorStrings['panel'];
  view: EditorView;
  onClose: () => void;
}

export function FormulaDialog({ copy, view, onClose }: FormulaDialogProps): ReactElement {
  const [tex, setTex] = useState(() => selectedTex(view));
  const [block, setBlock] = useState(false);
  const preview = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  /* Показ пересобирается на каждый набранный символ: он и есть ответ на
     вопрос «правильно ли я написал». */
  useEffect(() => {
    const host = preview.current;
    if (!host) return;
    if (tex.trim() === '') {
      host.textContent = '';
      setError(null);
      return;
    }
    try {
      katex.render(tex, host, { displayMode: block, throwOnError: true, output: 'html' });
      setError(null);
    } catch (failure) {
      /* Разбор не удался — сообщаем строкой из каталога, а не текстом KaTeX:
         тот на английском и говорит про токены, а не про формулу. */
      host.textContent = '';
      setError(failure instanceof Error ? copy.formulaBroken : copy.formulaBroken);
    }
  }, [tex, block, copy.formulaBroken]);

  const submit = (): void => {
    const value = tex.trim();
    if (value === '') {
      onClose();
      return;
    }
    const wrap = block ? '$$' : '$';
    const range = view.state.selection.main;
    /* Блочная формула встаёт своей строкой: `$$…$$` посреди абзаца markdown
       считает инлайновой, и она вылезает в строку текста. */
    const insert = block
      ? `${range.from > 0 && view.state.doc.sliceString(range.from - 1, range.from) !== '\n' ? '\n' : ''}${wrap}${value}${wrap}\n`
      : `${wrap}${value}${wrap}`;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: range.from + insert.length },
      userEvent: 'input.format',
      scrollIntoView: true,
    });
    onClose();
    view.focus();
  };

  return (
    <div
      className="zp-panel__menu zp-formula"
      role="dialog"
      aria-label={copy.formula}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        /* Enter вставляет, Shift+Enter переносит строку: в формуле бывают
           многострочные окружения. */
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <div className="zp-panel__field">
        <label htmlFor="zp-formula-tex">{copy.formula}</label>
        <textarea
          id="zp-formula-tex"
          ref={field}
          className="zp-panel__input zp-formula__input"
          placeholder={copy.formulaPlaceholder}
          spellCheck={false}
          rows={2}
          value={tex}
          onChange={(event) => setTex(event.target.value)}
        />
      </div>

      <div className="zp-formula__preview" ref={preview} aria-live="polite" />
      {error ? <div className="zp-formula__error">{error}</div> : null}

      <label className="zp-formula__check">
        <input type="checkbox" checked={block} onChange={() => setBlock((value) => !value)} />
        {copy.formulaBlock}
      </label>

      <div className="zp-panel__actions">
        <button type="button" className="zp-panel__action" onClick={onClose}>
          {copy.cancel}
        </button>
        <button
          type="button"
          className="zp-panel__action zp-panel__action--primary"
          onClick={submit}
        >
          {copy.insert}
        </button>
      </div>
    </div>
  );
}

/**
 * Что подставить в поле при открытии.
 *
 * Выделенный текст — заготовка формулы: человек выделил `x^2` и нажал
 * «Формула». Курсор внутри готовой формулы — она сама, чтобы её правили, а не
 * писали заново рядом.
 */
function selectedTex(view: EditorView): string {
  const range = view.state.selection.main;
  if (!range.empty) return view.state.sliceDoc(range.from, range.to);
  const line = view.state.doc.lineAt(range.head);
  const offset = range.head - line.from;
  for (const found of line.text.matchAll(/\$\$?([^$]+)\$\$?/g)) {
    const start = found.index ?? 0;
    if (offset >= start && offset <= start + found[0].length) return (found[1] ?? '').trim();
  }
  return '';
}

/** Стили диалога — в общем модуле панели, чтобы тень и радиусы совпадали. */
export const formulaDialogStyles = {
  '.zp-formula': { display: 'grid', gap: '8px', padding: '10px', minWidth: '260px' },
  '.zp-formula__input': {
    height: 'auto',
    padding: '8px 10px',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '13px',
    resize: 'vertical',
  },
  /* Показ формулы: пустой блок не должен схлопываться — иначе диалог прыгает
     на каждом первом символе. */
  '.zp-formula__preview': {
    minHeight: '44px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '6px 10px',
    borderRadius: '8px',
    backgroundColor: 'var(--surface-sunken)',
    color: 'var(--text)',
    overflowX: 'auto',
  },
  '.zp-formula__error': { fontSize: '11px', color: 'var(--danger, var(--accent))' },
  '.zp-formula__check': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '13px',
    color: 'var(--text-secondary)',
  },
  '.zp-formula__check input': { accentColor: 'var(--accent)' },
};
