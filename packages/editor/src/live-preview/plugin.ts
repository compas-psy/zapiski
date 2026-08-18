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
import { buildLivePreview, type LivePreviewSets } from './decorations.js';
import { listMarkTint } from './list-mark-tint.js';
import { rawMode, rawModeField, setRawMode } from './raw-mode.js';
import { toggleCollapsed } from './collapsed.js';
import { imageSelection, selectImage } from './image-select.js';
import { tableView } from './table-view.js';
import { imeSupport, isComposing, noteDeferral, redecorateEffect } from '../ime/composition.js';

const EMPTY: LivePreviewSets = { decorations: Decoration.none, atomic: Decoration.none };

class LivePreviewPlugin {
  decorations: DecorationSet;
  /**
   * Схлопнутые символы разметки. Курсор перешагивает их целиком, иначе он
   * встаёт между двумя `*`, где нет ни одного пикселя, и набранное дальше
   * уезжает внутрь жирного фрагмента.
   */
  atomic: DecorationSet;
  /** Пересчёт, отложенный из-за композиции: выполнить сразу после её конца. */
  private pending = false;

  constructor(view: EditorView) {
    const sets = this.compute(view);
    this.decorations = sets.decorations;
    this.atomic = sets.atomic;
  }

  private compute(view: EditorView): LivePreviewSets {
    if (view.state.field(rawModeField, false)) return EMPTY;
    return buildLivePreview(view.state, view.visibleRanges);
  }

  update(update: ViewUpdate): void {
    // ── IME: композиция никогда не прерывается декорациями ──────────────────
    if (isComposing(update.view)) {
      if (update.docChanged) {
        this.decorations = this.decorations.map(update.changes);
        this.atomic = this.atomic.map(update.changes);
      }
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.pending = true;
        noteDeferral(update.view);
      }
      return;
    }

    /*
     * Эффекты, после которых декорации обязаны пересобраться.
     *
     * `toggleCollapsed` попал сюда не сразу, и стоило это заказчику
     * впечатления «сворачиваемый блок не сворачивается»: поле состояния
     * менялось, а плагин про этот эффект не знал и оставлял прежние
     * декорации — на экране ничего не происходило. Любое новое поле,
     * влияющее на показ, обязано появиться и в этом списке.
     */
    const forced = update.transactions.some((tr) =>
      tr.effects.some(
        (e) =>
          e.is(redecorateEffect) ||
          e.is(setRawMode) ||
          e.is(toggleCollapsed) ||
          e.is(selectImage),
      ),
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
      const sets = this.compute(update.view);
      this.decorations = sets.decorations;
      this.atomic = sets.atomic;
    }
  }
}

const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (plugin) => plugin.decorations,
  /* Неделимые диапазоны отдаются отдельно от рисуемых: если объявить
     неделимым весь набор, курсор перестанет ходить по обычному тексту внутри
     жирного, а надо перешагивать только невидимые маркеры. */
  provide: (plugin) =>
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
});

/**
 * Live-preview целиком: разметка, чекбоксы, картинки, raw-режим и защита IME.
 * Это то, что подключают те, кому нужен голый CodeMirror без React.
 *
 * `listMarkTint` стоит рядом намеренно: в режиме «Разметка» набор декораций
 * выше отдаёт пустоту целиком, а цвет маркера списка — настройка оформления и
 * обязан действовать в обоих режимах.
 */
export const livePreview: Extension = [
  rawMode,
  imeSupport,
  imageSelection,
  /* Таблица заменяется настоящей `<table>` — блочной заменой, а такую
     CodeMirror принимает только напрямую от поля состояния, не от плагина
     (`EditorView.decorations`). Отсюда и отдельное расширение рядом. Стоит
     ПОСЛЕ `rawMode`: поле читает его значение. */
  tableView,
  livePreviewPlugin,
  listMarkTint,
];
