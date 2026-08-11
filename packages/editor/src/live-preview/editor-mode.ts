/**
 * Два режима редактора (ITERATION-1 §8).
 *
 * **Простой** — по умолчанию. Разметка не видна НИКОГДА: ни `**`, ни `#`, ни
 * `>`, даже когда курсор стоит внутри узла. Текст выглядит как результат, а
 * форматируют его панелью (§4) и хоткеями. Raw-режим и wiki-ссылки из
 * интерфейса убраны.
 *
 * **Профессиональный** — нынешнее поведение: разметка проявляется у курсора,
 * доступен raw по Ctrl+E, есть wiki-ссылки и сноски.
 *
 * Режим — поле состояния, а не пересборка расширений: переключение обязано
 * быть мгновенным и не терять ни историю отмены, ни позицию курсора (§8).
 * Файл он не меняет вовсе — это только способ показа: в `.md` на диске
 * markdown как был, так и остаётся, и заметка, набранная в простом режиме,
 * открывается в чужом редакторе ровно так же.
 */
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';

export type EditorMode = 'simple' | 'pro';

export const setEditorMode = StateEffect.define<EditorMode>();

export const editorModeField = StateField.define<EditorMode>({
  /* Умолчание библиотеки — профессиональный, то есть прежнее поведение
     редактора. Продуктовое умолчание «простой для новых людей» живёт не
     здесь, а в настройках приложения (`DEFAULT_EDITOR_PREFERENCES.mode`):
     решать за всех, кто подключит редактор, библиотека не должна. */
  create: () => 'pro',
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setEditorMode)) return effect.value;
    return value;
  },
});

/** Режим показа. Без поля — профессиональный: так ведёт себя голый редактор. */
export function editorModeOf(state: EditorState): EditorMode {
  return state.field(editorModeField, false) ?? 'pro';
}

/** Скрывать ли разметку безусловно — то есть включён ли простой режим. */
export function hidesMarkup(state: EditorState): boolean {
  return editorModeOf(state) === 'simple';
}

export const editorMode: Extension = [editorModeField];
