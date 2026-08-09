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

import { autocompletion, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import type { LanguageDescription } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { drawSelection, dropCursor, EditorView, keymap, placeholder } from '@codemirror/view';

import { editorRuntime, noopRuntime } from './runtime.js';
import type { EditorRuntime } from './runtime.js';
import { editorStrings, ru } from './i18n.js';
import type { EditorStrings } from './i18n.js';
import { zapiskiBaseTheme } from './theme/base-theme.js';
import { zapiskiCodeHighlight } from './theme/highlight.js';
import { zapiskiMarkdown } from './syntax/language.js';
import { livePreview } from './live-preview/plugin.js';
import { markupInteractions } from './live-preview/interactions.js';
import { autoformat } from './input/autoformat.js';
import { smartPaste } from './paste/smart-paste.js';
import { tagCompletionSource, wikiCompletionSource, COMPLETION_LIMIT } from './completion/sources.js';
import { findPanel } from './search/panel.js';
import { focusMode } from './focus/focus-mode.js';
import { autosave } from './save/autosave.js';
import { typography, defaultTypography } from './typography.js';
import type { TypographySettings } from './typography.js';
import { zapiskiKeymap } from './commands/keymap.js';

export interface ZapiskiEditorOptions {
  /** Всё, что редактор просит у приложения. По умолчанию — заглушки. */
  runtime?: EditorRuntime;
  /** Каталог строк (`ru` по умолчанию). */
  strings?: EditorStrings;
  /** Настройки типографики пользователя. */
  typography?: TypographySettings;
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

    options.codeLanguages
      ? zapiskiMarkdown({ codeLanguages: options.codeLanguages })
      : zapiskiMarkdown(),
    syntaxHighlighting(zapiskiCodeHighlight),

    livePreview,
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
    keymap.of([...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, ...defaultKeymap]),
  ];
}
