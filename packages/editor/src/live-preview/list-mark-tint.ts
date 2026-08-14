/**
 * Цвет маркера списка в режиме «Разметка».
 *
 * ── Что сказал заказчик ─────────────────────────────────────────────────────
 *
 * «В настройках стоит, что маркер списка должен быть акцентным по цвету, но он
 * то ли приглушённый, то ли как текст».
 *
 * ── Почему так выходило ─────────────────────────────────────────────────────
 *
 * Класс `cm-z-list-mark`, к которому привязан цвет из настроек, вешали
 * декорации живого предпросмотра. А в режиме «Разметка» предпросмотр отдаёт
 * пустой набор декораций целиком (`plugin.ts`: `if (rawModeField) return
 * EMPTY`) — правильно для предпросмотра и неправильно для цвета. Маркер
 * оставался на подсветке синтаксиса, где `ListMark` помечен общим тегом
 * `processingInstruction` вместе с `#`, `>` и `[` — то есть третичным серым.
 * Настройку при этом можно было переключать сколько угодно.
 *
 * Цвет маркера — оформление, а не предпросмотр: он обязан работать в обоих
 * режимах. Поэтому здесь отдельное маленькое расширение, которое красит
 * маркеры ровно тогда, когда предпросмотр этого не делает, — и ни разу не
 * дублирует его работу.
 */
import { syntaxTree } from '@codemirror/language';
import type { Extension, Range } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';

import { rawModeField } from './raw-mode.js';

const listMark = Decoration.mark({ class: 'cm-z-list-mark' });

function build(view: EditorView): DecorationSet {
  /* Живой предпросмотр красит сам — второй раз не надо. */
  if (!(view.state.field(rawModeField, false) ?? false)) return Decoration.none;

  const marks: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'ListMark') return;
        marks.push(listMark.range(node.from, node.to));
      },
    });
  }
  return Decoration.set(marks, true);
}

/**
 * Красит `-`, `*`, `+` и номера списков в режиме «Разметка».
 *
 * Обходится только видимая часть документа: заметка на тысячу строк не должна
 * перебираться на каждое нажатие клавиши.
 */
export const listMarkTint: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate): void {
      const switched =
        (update.state.field(rawModeField, false) ?? false) !==
        (update.startState.field(rawModeField, false) ?? false);
      if (update.docChanged || update.viewportChanged || switched) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
