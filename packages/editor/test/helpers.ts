/**
 * Общие помощники тестов редактора.
 */

import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { zapiskiEditor } from '../src/setup.js';
import { noopRuntime } from '../src/runtime.js';
import type { EditorRuntime } from '../src/runtime.js';
import { buildLivePreview } from '../src/live-preview/decorations.js';

export function runtimeOf(overrides: Partial<EditorRuntime> = {}): EditorRuntime {
  return { ...noopRuntime, ...overrides };
}

export interface StateOptions {
  runtime?: Partial<EditorRuntime>;
  selection?: { anchor: number; head?: number };
  extra?: Extension;
}

/** Состояние с полностью разобранным деревом — иначе декораций просто нет. */
export function makeState(doc: string, options: StateOptions = {}): EditorState {
  const state = EditorState.create({
    doc,
    ...(options.selection ? { selection: options.selection } : {}),
    extensions: [
      ...zapiskiEditor({ runtime: runtimeOf(options.runtime) }),
      ...(options.extra ? [options.extra] : []),
    ],
  });
  ensureSyntaxTree(state, state.doc.length, 30_000);
  return state;
}

export interface DecoInfo {
  from: number;
  to: number;
  class: string | null;
  widget: string | null;
}

/** Плоский список декораций по всему документу. */
export function decorationsOf(state: EditorState): DecoInfo[] {
  const { decorations } = buildLivePreview(state, [{ from: 0, to: state.doc.length }]);
  const out: DecoInfo[] = [];
  const iter = decorations.iter();
  while (iter.value) {
    const spec = iter.value.spec as { class?: string; widget?: { constructor: { name: string } } };
    out.push({
      from: iter.from,
      to: iter.to,
      class: spec.class ?? null,
      widget: spec.widget ? spec.widget.constructor.name : null,
    });
    iter.next();
  }
  return out;
}

/**
 * Схлопнутые символы разметки — те, что курсор обязан перешагивать целиком.
 * Возвращает их границы в порядке появления.
 */
export function hiddenRanges(state: EditorState): Array<{ from: number; to: number }> {
  const { atomic } = buildLivePreview(state, [{ from: 0, to: state.doc.length }]);
  const out: Array<{ from: number; to: number }> = [];
  const iter = atomic.iter();
  while (iter.value) {
    out.push({ from: iter.from, to: iter.to });
    iter.next();
  }
  return out;
}

export function classesAt(state: EditorState, from: number, to: number): string[] {
  return decorationsOf(state)
    .filter((d) => d.from === from && d.to === to)
    .map((d) => d.class ?? '');
}

/** Смонтированный редактор в jsdom. Не забывать `view.destroy()`. */
export function makeView(doc: string, options: StateOptions = {}): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state: makeState(doc, options), parent });
  ensureSyntaxTree(view.state, view.state.doc.length, 30_000);
  return view;
}
