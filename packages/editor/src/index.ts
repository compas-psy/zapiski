/**
 * `@zapiski/editor` — публичный API.
 *
 * ARCHITECTURE §5: глубокие импорты запрещены, всё наружу идёт отсюда.
 *
 * Два способа использования:
 *   1. React — компонент `<Editor/>` с явными пропсами;
 *   2. чистый CodeMirror — `zapiskiEditor()` возвращает массив расширений,
 *      который можно положить в свой `EditorState.create`.
 */

// ── React ────────────────────────────────────────────────────────────────────
export { Editor } from './react/Editor.js';
/* Размер картинки в заметке (замечание 2): подпись `![…|400]`. */
export { imageWidthOf, setImageWidth } from './commands/image.js';
export type { EditorProps, EditorHandle } from './react/Editor.js';
export { FormatPanel, type FormatPanelProps } from './react/FormatPanel.js';
export {
  blockStyleAt,
  inlineActiveAt,
  listStyleAt,
  type BlockStyle,
  type ListStyle,
} from './commands/block-state.js';
export { insertCallout, insertCollapsible, insertSmall } from './commands/blocks.js';
export {
  alignColumn,
  insertColumn,
  insertRow,
  removeColumn,
  removeRow,
  renderTable,
  tableAt,
  tableChange,
  toggleHeader,
  type ColumnAlign,
  type TableModel,
} from './commands/table.js';
export {
  editorMode,
  editorModeField,
  editorModeOf,
  hidesMarkup,
  setEditorMode,
  type EditorMode,
} from './live-preview/editor-mode.js';
export { applyTaskOrder, moveDoneToBottom, reorderTasks, taskOrder } from './input/task-order.js';
export { Toolbar } from './react/Toolbar.js';
export type { ToolbarProps } from './react/Toolbar.js';

// ── Готовая сборка расширений ────────────────────────────────────────────────
export { zapiskiEditor } from './setup.js';
export type { ZapiskiEditorOptions } from './setup.js';

// ── Рантайм и строки ─────────────────────────────────────────────────────────
export { editorRuntime, noopRuntime } from './runtime.js';
export type { EditorRuntime, TagSuggestion, NoteSuggestion } from './runtime.js';
export { editorStrings, ru, en } from './i18n.js';
export type { EditorStrings } from './i18n.js';

// ── Отдельные расширения, если нужна своя сборка ──────────────────────────────
export { livePreview } from './live-preview/plugin.js';
export { buildLivePreview } from './live-preview/decorations.js';
export { markupInteractions, toggleTaskAt, toggleTaskAtCursor, wikiTargetAt } from './live-preview/interactions.js';
export { rawMode, rawModeField, setRawMode, toggleRawMode, isRawMode } from './live-preview/raw-mode.js';
export { TaskBoxWidget, ImageWidget } from './live-preview/widgets.js';

export { imeSupport, isComposing, compositionDeferrals, redecorateEffect } from './ime/composition.js';

export { zapiskiMarkdown, codeLanguages, allCodeLanguages } from './syntax/language.js';
export type { MarkdownLanguageOptions } from './syntax/language.js';
export {
  zapiskiMarkdownExtensions,
  HighlightExtension,
  WikiLinkExtension,
  TagExtension,
  FootnoteExtension,
} from './syntax/markdown-ext.js';

export { zapiskiBaseTheme } from './theme/base-theme.js';
export { zapiskiCodeHighlight } from './theme/highlight.js';
export {
  REQUIRED_SURFACE_TOKENS,
  REQUIRED_CODE_TOKENS,
  REQUIRED_FONT_TOKENS,
} from './theme/tokens.js';

export { autoformat, checkboxShortcut, completeFencedCode, completeDivider } from './input/autoformat.js';
export { caretAtTail, enterAtBlockStart, tailClick } from './input/block-start.js';
export {
  indentListItem,
  dedentListItem,
  listNewline,
  listBackspace,
  MAX_LIST_DEPTH,
} from './input/lists.js';

export { smartPaste, plainPaste } from './paste/smart-paste.js';
export { htmlToMarkdown } from './paste/html-to-markdown.js';

export { tagCompletionSource, wikiCompletionSource, COMPLETION_LIMIT } from './completion/sources.js';
export { fuzzyScore, rankByFuzzy } from './completion/fuzzy.js';

export { findPanel, openFind, openReplace, matchStats } from './search/panel.js';

export {
  focusMode,
  focusModeField,
  setFocusMode,
  toggleFocusMode,
  exitFocusMode,
  setTypewriterScroll,
} from './focus/focus-mode.js';
export type { FocusModeState } from './focus/focus-mode.js';

export { autosave, flushAutosave, AUTOSAVE_DEBOUNCE_MS } from './save/autosave.js';

export { typography, applyTypography, typographyStyle, defaultTypography } from './typography.js';
export type {
  TypographySettings,
  FontSizeStep,
  LineHeightStep,
  ColumnWidth,
} from './typography.js';

export {
  toggleWrap,
  toggleBold,
  toggleItalic,
  toggleHighlight,
  toggleStrike,
  toggleUnderline,
  toggleInlineCode,
  bulletListWith,
  toggleBulletList,
  toggleOrderedList,
  toggleTaskList,
  toggleQuote,
  setHeading,
  cycleHeading,
  insertCodeBlock,
  insertLink,
  insertWikiLink,
  insertTable,
  insertDivider,
  insertFootnote,
  insertImage,
  isImagesOnlyLine,
  splitLine,
} from './commands/formatting.js';
export type { LineParts } from './commands/formatting.js';
export { applyLink, linkDraft, type LinkDraft } from './commands/link.js';
export { zapiskiKeymap, editorCommands, toolbarCommands } from './commands/keymap.js';
export type { EditorCommandSpec } from './commands/keymap.js';

export type { HapticStrength, VaultPath } from './contract-types.js';
