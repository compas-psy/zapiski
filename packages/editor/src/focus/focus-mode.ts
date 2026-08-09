/**
 * Режим фокуса (BEHAVIOR §2.8, SCREENS §4).
 *
 * Активный абзац — 100% непрозрачности, остальные — 28%, переход 300 мс.
 * При `prefers-reduced-motion` перехода нет (за это отвечает CSS в теме).
 * Typewriter-скролл — ОПЦИЯ, по умолчанию ВЫКЛЮЧЕНА.
 *
 * «Абзац» здесь — связная группа непустых строк вокруг курсора: это ровно то,
 * что человек считает абзацем, и это дёшево считается без разбора дерева.
 */

import { StateEffect, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { Command, DecorationSet, ViewUpdate } from '@codemirror/view';
import { editorStrings } from '../i18n.js';

export interface FocusModeState {
  enabled: boolean;
  /** Typewriter scrolling — по умолчанию выключен (BEHAVIOR §2.8). */
  typewriter: boolean;
}

export const setFocusMode = StateEffect.define<Partial<FocusModeState>>();

export const focusModeField = StateField.define<FocusModeState>({
  create: () => ({ enabled: false, typewriter: false }),
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setFocusMode)) next = { ...next, ...effect.value };
    }
    return next;
  },
});

/** Ctrl+Shift+F — вход и выход. */
export const toggleFocusMode: Command = (view) => {
  const current = view.state.field(focusModeField, false);
  view.dispatch({ effects: setFocusMode.of({ enabled: !(current?.enabled ?? false) }) });
  return true;
};

/** Esc — выйти из фокуса. Возвращает false, если фокус и так выключен. */
export const exitFocusMode: Command = (view) => {
  if (!view.state.field(focusModeField, false)?.enabled) return false;
  view.dispatch({ effects: setFocusMode.of({ enabled: false }) });
  return true;
};

/** Включить/выключить typewriter-скролл. */
export function setTypewriterScroll(view: EditorView, on: boolean): void {
  view.dispatch({ effects: setFocusMode.of({ typewriter: on }) });
}

const activeLine = Decoration.line({ class: 'cm-z-focus-active' });
const dimLine = Decoration.line({ class: 'cm-z-focus-dim' });

/** Границы абзаца (в номерах строк) вокруг позиции. */
function paragraphAt(view: EditorView, pos: number): { first: number; last: number } {
  const doc = view.state.doc;
  const line = doc.lineAt(pos);
  let first = line.number;
  let last = line.number;
  while (first > 1 && doc.line(first - 1).text.trim().length > 0) first--;
  while (last < doc.lines && doc.line(last + 1).text.trim().length > 0) last++;
  return { first, last };
}

class FocusModePlugin {
  decorations: DecorationSet = Decoration.none;
  private hint: HTMLElement | null = null;
  private scrollFrame: number | null = null;

  constructor(private readonly view: EditorView) {
    this.decorations = this.compute(view);
    this.syncHint(view);
  }

  private compute(view: EditorView): DecorationSet {
    const state = view.state.field(focusModeField, false);
    if (!state?.enabled) return Decoration.none;
    const doc = view.state.doc;
    const active = new Set<number>();
    for (const range of view.state.selection.ranges) {
      const { first, last } = paragraphAt(view, range.head);
      for (let n = first; n <= last; n++) active.add(n);
    }
    const decorations: Array<{ from: number; value: Decoration }> = [];
    for (const { from, to } of view.visibleRanges) {
      const firstLine = doc.lineAt(from).number;
      const lastLine = doc.lineAt(to).number;
      for (let n = firstLine; n <= lastLine; n++) {
        const line = doc.line(n);
        decorations.push({ from: line.from, value: active.has(n) ? activeLine : dimLine });
      }
    }
    decorations.sort((a, b) => a.from - b.from);
    return Decoration.set(
      decorations.map((d) => d.value.range(d.from)),
      true,
    );
  }

  /** Подсказка «фокус · Esc — выйти» в правом верхнем углу (SCREENS §4). */
  private syncHint(view: EditorView): void {
    const enabled = view.state.field(focusModeField, false)?.enabled ?? false;
    if (enabled && !this.hint) {
      const hint = document.createElement('div');
      hint.className = 'cm-z-focus-hint';
      hint.textContent = view.state.facet(editorStrings).focus.hint;
      view.dom.appendChild(hint);
      this.hint = hint;
    } else if (!enabled && this.hint) {
      this.hint.remove();
      this.hint = null;
    }
  }

  update(update: ViewUpdate): void {
    const state = update.state.field(focusModeField, false);
    const wasEnabled = update.startState.field(focusModeField, false)?.enabled ?? false;
    const enabled = state?.enabled ?? false;

    if (enabled !== wasEnabled) this.syncHint(update.view);
    if (
      enabled !== wasEnabled ||
      (enabled && (update.docChanged || update.selectionSet || update.viewportChanged))
    ) {
      this.decorations = this.compute(update.view);
    }

    if (enabled && state?.typewriter && update.selectionSet && this.scrollFrame === null) {
      // Диспатчить прямо из update нельзя — откладываем на следующий кадр.
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        const head = this.view.state.selection.main.head;
        this.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) });
      });
    }
  }

  destroy(): void {
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    this.hint?.remove();
    this.hint = null;
  }
}

const focusModePlugin = ViewPlugin.fromClass(FocusModePlugin, {
  decorations: (plugin) => plugin.decorations,
});

export const focusMode: Extension = [focusModeField, focusModePlugin];
