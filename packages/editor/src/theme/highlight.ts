/**
 * Подсветка кода в ```-блоках (DESIGN_TOKENS §1).
 *
 * Одна `HighlightStyle` на обе темы: цвета заданы переменными, поэтому
 * переключение темы — это переключение значений `--code-*`, без пересборки
 * расширений и без «белой вспышки» (DESIGN_TOKENS §4).
 */

import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { codeColor } from './tokens.js';

export const zapiskiCodeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: codeColor.keyword },
  { tag: [t.moduleKeyword, t.definitionKeyword], color: codeColor.keyword },
  { tag: [t.string, t.special(t.string), t.regexp], color: codeColor.string },
  { tag: [t.number, t.bool, t.null, t.atom], color: codeColor.number },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: codeColor.comment, fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: codeColor.function },
  { tag: [t.typeName, t.className, t.namespace], color: codeColor.function },
  { tag: [t.propertyName, t.attributeName], color: 'var(--text)' },
  { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--text)' },
  { tag: [t.tagName, t.angleBracket], color: codeColor.keyword },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.derefOperator], color: 'var(--text-secondary)' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--text-tertiary)' },
  { tag: t.escape, color: codeColor.number },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.invalid, color: 'var(--text)', textDecoration: 'underline wavy' },
  { tag: t.inserted, color: codeColor.string },
  { tag: t.deleted, color: 'var(--text-secondary)', textDecoration: 'line-through' },
]);
