/**
 * Переключение raw ↔ live-preview по Ctrl+E (BEHAVIOR §7).
 *
 * Реализовано полем состояния, а не переконфигурацией: переключение должно
 * быть мгновенным и не терять ни историю, ни позицию курсора.
 */

import { StateEffect, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Command } from '@codemirror/view';

export const setRawMode = StateEffect.define<boolean>();

export const rawModeField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setRawMode)) return effect.value;
    return value;
  },
});

/** Включён ли режим «сырого» markdown. */
export function isRawMode(state: { field: (f: typeof rawModeField, req?: false) => boolean | undefined }): boolean {
  return state.field(rawModeField, false) ?? false;
}

/** Ctrl+E — raw-режим ↔ live-preview. */
export const toggleRawMode: Command = (view) => {
  const next = !(view.state.field(rawModeField, false) ?? false);
  view.dispatch({ effects: setRawMode.of(next) });
  return true;
};

/** В raw-режиме текст показывается моноширинным — как в любом текстовом редакторе. */
const rawAttributes = EditorView.contentAttributes.compute([rawModeField], (state) =>
  state.field(rawModeField, false) ? { class: 'cm-z-raw' } : ({} as Record<string, string>),
);

export const rawMode: Extension = [rawModeField, rawAttributes];
