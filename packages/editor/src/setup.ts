/**
 * Готовая сборка редактора для тех, кому нужен CodeMirror напрямую,
 * без React (ARCHITECTURE §5: публичный API — только через `src/index.ts`).
 *
 * ```ts
 * new EditorView({
 *   state: EditorState.create({ doc, extensions: zapiskiEditor({ runtime }) }),
 *   parent,
 * });
 * ```
 */

import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { closeSearchPanel } from '@codemirror/search';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import type { LanguageDescription } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { drawSelection, dropCursor, EditorView, keymap, placeholder } from '@codemirror/view';

import { editorRuntime, noopRuntime } from './runtime.js';
import { collapsible } from './live-preview/collapsed.js';
import type { EditorRuntime } from './runtime.js';
import { editorStrings, ru } from './i18n.js';
import type { EditorStrings } from './i18n.js';
import { zapiskiBaseTheme } from './theme/base-theme.js';
import { zapiskiCodeHighlight } from './theme/highlight.js';
import { zapiskiMarkdown } from './syntax/language.js';
import { livePreview } from './live-preview/plugin.js';
import { tableAutoFormat } from './live-preview/table-format.js';
import { markupInteractions } from './live-preview/interactions.js';
import { autoformat } from './input/autoformat.js';
import { smartPaste } from './paste/smart-paste.js';
import { tagCompletionSource, wikiCompletionSource, COMPLETION_LIMIT } from './completion/sources.js';
import { findPanel } from './search/panel.js';
import { focusMode, exitFocusMode } from './focus/focus-mode.js';
import { autosave } from './save/autosave.js';
import { typography, defaultTypography } from './typography.js';
import type { TypographySettings } from './typography.js';
import { zapiskiKeymap } from './commands/keymap.js';
import { taskOrder } from './input/task-order.js';
import { editorMode, type EditorMode } from './live-preview/editor-mode.js';

export interface ZapiskiEditorOptions {
  /** Всё, что редактор просит у приложения. По умолчанию — заглушки. */
  runtime?: EditorRuntime;
  /** Каталог строк (`ru` по умолчанию). */
  strings?: EditorStrings;
  /** Настройки типографики пользователя. */
  typography?: TypographySettings;
  /** «Переносить выполненные вниз» (ITERATION-1 §3). По умолчанию выключено. */
  moveDoneToBottom?: boolean;
  /**
   * Режим показа разметки (ITERATION-1 §8). По умолчанию профессиональный —
   * прежнее поведение редактора; «простой для новых людей» задаёт приложение.
   */
  mode?: EditorMode;
  /** Языки подсветки кода; по умолчанию курируемые ~20. */
  codeLanguages?: LanguageDescription[];
  /** Только чтение — например, витринная заметка или зашифрованная. */
  readOnly?: boolean;
}

export function zapiskiEditor(options: ZapiskiEditorOptions = {}): Extension[] {
  const strings = options.strings ?? ru;
  return [
    editorRuntime.of(options.runtime ?? noopRuntime),
    editorStrings.of(strings),

    zapiskiBaseTheme,
    typography(options.typography ?? defaultTypography),
    taskOrder(options.moveDoneToBottom ?? false),
    editorMode,

    options.codeLanguages
      ? zapiskiMarkdown({ codeLanguages: options.codeLanguages })
      : zapiskiMarkdown(),
    syntaxHighlighting(zapiskiCodeHighlight),

    livePreview,
    /* Какие сворачиваемые блоки свёрнуты. Поле, а не правка текста:
       в файле `<details>` всегда записан целиком (замечание 12). */
    collapsible,
    /* Таблица встаёт ровно, когда курсор из неё уходит: markdown держит
       колонки пробелами, и от одного дописанного слова они разъезжаются. */
    tableAutoFormat,
    markupInteractions,
    autoformat,
    smartPaste,
    findPanel,
    focusMode,
    autosave,

    autocompletion({
      override: [tagCompletionSource, wikiCompletionSource],
      // Список открывается по мере ввода; Esc закрывает, стрелки водят
      // по нему, Enter/Tab подставляют (BEHAVIOR §2.4).
      activateOnTyping: true,
      maxRenderedOptions: COMPLETION_LIMIT,
      icons: false,
      closeOnBlur: true,
    }),

    history(),
    EditorView.lineWrapping,
    drawSelection(),
    dropCursor(),
    placeholder(strings.editor.placeholder),
    EditorState.readOnly.of(options.readOnly ?? false),

    zapiskiKeymap,
    keymap.of([
      // Esc по очереди: закрыть подсказку → закрыть поиск → выйти из фокуса →
      // упростить выделение. Каждая команда возвращает false, когда ей нечего
      // делать, поэтому цепочка не «съедает» чужой Esc (BEHAVIOR §7).
      ...completionKeymap,
      { key: 'Escape', run: closeSearchPanel },
      { key: 'Escape', run: exitFocusMode },
      ...historyKeymap,
      ...defaultKeymap,
    ]),
  ];
}
