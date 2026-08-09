/**
 * Плагин live-preview: связывает построитель декораций с защитой от IME.
 *
 * Два правила, ради которых он существует:
 *   1. Декорации считаются только по видимым диапазонам (ARCHITECTURE §4).
 *   2. Пока идёт композиция IME, набор декораций НЕ пересчитывается —
 *      только сдвигается по изменениям документа (BEHAVIOR §2.1,
 *      регрессионный тест-кейс №1).
 */

import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { buildLivePreview } from './decorations.js';
import { rawMode, rawModeField, setRawMode } from './raw-mode.js';
import { imeSupport, isComposing, noteDeferral, redecorateEffect } from '../ime/composition.js';

class LivePreviewPlugin {
  decorations: DecorationSet;
  /** Пересчёт, отложенный из-за композиции: выполнить сразу после её конца. */
  private pending = false;

  constructor(view: EditorView) {
    this.decorations = this.compute(view);
  }

  private compute(view: EditorView): DecorationSet {
    if (view.state.field(rawModeField, false)) return Decoration.none;
    return buildLivePreview(view.state, view.visibleRanges);
  }

  update(update: ViewUpdate): void {
    // ── IME: композиция никогда не прерывается декорациями ──────────────────
    if (isComposing(update.view)) {
      if (update.docChanged) this.decorations = this.decorations.map(update.changes);
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.pending = true;
        noteDeferral(update.view);
      }
      return;
    }

    const forced = update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(redecorateEffect) || e.is(setRawMode)),
    );
    // Разбор большого документа идёт порциями: когда дерево доросло до
    // вьюпорта, декорации надо пересобрать, даже если ничего не менялось.
    const treeGrew = syntaxTree(update.state) !== syntaxTree(update.startState);

    if (
      this.pending ||
      forced ||
      treeGrew ||
      update.docChanged ||
      update.viewportChanged ||
      update.selectionSet
    ) {
      this.pending = false;
      this.decorations = this.compute(update.view);
    }
  }
}

const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (plugin) => plugin.decorations,
});

/**
 * Live-preview целиком: разметка, чекбоксы, картинки, raw-режим и защита IME.
 * Это то, что подключают те, кому нужен голый CodeMirror без React.
 */
export const livePreview: Extension = [rawMode, imeSupport, livePreviewPlugin];
