/**
 * Тапы по элементам разметки (BEHAVIOR §2.3, §2.4, §2.5).
 *
 * - Тап по КВАДРАТУ чекбокса — переключение + лёгкая хэптика.
 * - Тап по ТЕКСТУ задачи — обычная постановка курсора (мы его не перехватываем).
 * - Тап по тегу — поиск по тегу.
 * - Тап по wiki-ссылке — переход; по висячей — предложение создать заметку;
 *   Ctrl/Cmd+клик — открыть в соседней панели.
 */

import { EditorView } from '@codemirror/view';
import type { Command } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { editorRuntime } from '../runtime.js';
import { reorderTasks } from '../input/task-order.js';

/** Элемент списка-задачи: маркер списка, затем `[ ]` / `[x]`. */
const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/;

/**
 * Переключить чекбокс на строке, в которой лежит `pos`.
 * Возвращает `false`, если строка не является задачей.
 */
export function toggleTaskAt(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const match = TASK_LINE.exec(line.text);
  if (!match) return false;
  const prefix = match[1];
  const box = match[2];
  if (prefix === undefined || box === undefined) return false;

  const at = line.from + prefix.length + 1;
  const checked = box !== ' ';
  view.dispatch({
    // Замена символ-в-символ: длина документа не меняется, курсор и скролл
    // остаются на месте, отмеченная задача никуда не переезжает (BEHAVIOR §2.3).
    changes: { from: at, to: at + 1, insert: checked ? ' ' : 'x' },
    scrollIntoView: false,
  });
  /* Перестановка — отдельной транзакцией и только если настройка включена
     (ITERATION-1 §3). Отдельной, чтобы отмена возвращала сначала порядок, а
     потом галочку: одним шагом человек бы не понял, что именно откатилось. */
  const reorder = reorderTasks(view.state, view.state.doc.lineAt(at).number);
  if (reorder) view.dispatch({ changes: reorder, scrollIntoView: false });
  view.state.facet(editorRuntime).haptic('light');
  return true;
}

/** Ctrl+Enter — отметить чекбокс на строке курсора (BEHAVIOR §7). */
export const toggleTaskAtCursor: Command = (view) =>
  toggleTaskAt(view, view.state.selection.main.head);

function nodeTextAt(view: EditorView, pos: number, nodeName: string): { from: number; to: number } | null {
  let node = syntaxTree(view.state).resolveInner(pos, 1);
  for (let cur: typeof node | null = node; cur; cur = cur.parent) {
    if (cur.name === nodeName) return { from: cur.from, to: cur.to };
  }
  node = syntaxTree(view.state).resolveInner(pos, -1);
  for (let cur: typeof node | null = node; cur; cur = cur.parent) {
    if (cur.name === nodeName) return { from: cur.from, to: cur.to };
  }
  return null;
}

/** Разобрать `[[цель|подпись]]` → цель. */
export function wikiTargetAt(view: EditorView, pos: number): string | null {
  const range = nodeTextAt(view, pos, 'ZWikiLink');
  if (!range) return null;
  const inner = view.state.doc.sliceString(range.from + 2, Math.max(range.from + 2, range.to - 2));
  const pipe = inner.indexOf('|');
  const target = (pipe > -1 ? inner.slice(0, pipe) : inner).trim();
  return target || null;
}

export const markupInteractions: Extension = EditorView.domEventHandlers({
  mousedown(event: MouseEvent, view: EditorView) {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    const runtime = view.state.facet(editorRuntime);

    // ── Чекбокс ─────────────────────────────────────────────────────────────
    const box = target.closest('.cm-z-taskbox, .cm-z-task');
    if (box instanceof HTMLElement || box instanceof SVGElement) {
      const pos = view.posAtDOM(box);
      if (toggleTaskAt(view, pos)) {
        event.preventDefault();
        return true;
      }
    }

    // ── Тег ─────────────────────────────────────────────────────────────────
    const tag = target.closest('.cm-z-tag');
    if (tag instanceof HTMLElement) {
      const text = tag.textContent ?? '';
      const name = text.startsWith('#') ? text.slice(1) : text;
      if (name) {
        event.preventDefault();
        runtime.openTag(name);
        return true;
      }
    }

    // ── Wiki-ссылка ─────────────────────────────────────────────────────────
    const wiki = target.closest('.cm-z-wiki');
    if (wiki instanceof HTMLElement) {
      const pos = view.posAtDOM(wiki);
      const wikiTarget = wikiTargetAt(view, pos);
      if (wikiTarget) {
        event.preventDefault();
        if (!runtime.wikiExists(wikiTarget)) runtime.createNote(wikiTarget);
        else runtime.openWikiLink(wikiTarget, event.ctrlKey || event.metaKey ? 'aside' : 'same');
        return true;
      }
    }

    return false;
  },
});
