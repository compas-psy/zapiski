/**
 * Автодополнение тегов и wiki-ссылок (BEHAVIOR §2.4, §2.5).
 *
 * Источники данных приходят снаружи, через `EditorRuntime`: редактор не знает
 * ни про индекс, ни про vault (ARCHITECTURE §5).
 */

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import { editorRuntime } from '../runtime.js';
import { rankByFuzzy } from './fuzzy.js';

/** До 8 совпадений — и у тегов, и у заметок (BEHAVIOR §2.4, §2.5). */
export const COMPLETION_LIMIT = 8;

/** Внутри кода подсказки не нужны. */
const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText']);

function insideCode(context: CompletionContext): boolean {
  let node = syntaxTree(context.state).resolveInner(context.pos, -1);
  for (let cur: typeof node | null = node; cur; cur = cur.parent) {
    if (CODE_NODES.has(cur.name)) return true;
  }
  return false;
}

/**
 * Теги: открывается на `#` + минимум 1 символ, до 8 совпадений,
 * сортировка по частоте использования, вложенные показываются целиком.
 * Пробел завершает тег — за это отвечает `validFor`.
 */
export function tagCompletionSource(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/#[\p{L}\p{N}_/-]+/u);
  if (!match) return null;
  if (insideCode(context)) return null;

  const prefix = match.text.slice(1);
  if (prefix.length < 1) return null;

  const runtime = context.state.facet(editorRuntime);
  const query = prefix.toLowerCase();
  const options: Completion[] = runtime
    .tags(prefix)
    .filter((t) => t.tag.toLowerCase().includes(query))
    // Сортировка по частоте использования — прямое требование BEHAVIOR §2.4.
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ru'))
    .slice(0, COMPLETION_LIMIT)
    .map((t) => ({
      label: `#${t.tag}`,
      apply: `#${t.tag}`,
      type: 'keyword',
      detail: String(t.count),
      boost: 0,
    }));

  if (!options.length) return null;
  return {
    from: match.from,
    options,
    // Свой порядок: фильтрация и ранжирование уже сделаны выше.
    filter: false,
    validFor: /^#[\p{L}\p{N}_/-]*$/u,
  };
}

function applyWikiTarget(title: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number): void => {
    const closing = view.state.sliceDoc(to, to + 2) === ']]';
    const insert = closing ? title : `${title}]]`;
    const end = from + insert.length + (closing ? 2 : 0);
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: end },
      userEvent: 'input.complete',
      scrollIntoView: true,
    });
  };
}

/**
 * Wiki-ссылки: открывается на `[[`, fuzzy по заголовкам, до 8 результатов,
 * первым — точное совпадение (BEHAVIOR §2.5).
 */
export function wikiCompletionSource(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\[\[[^\]\n|]*/);
  if (!match) return null;
  if (insideCode(context)) return null;

  const query = match.text.slice(2);
  const runtime = context.state.facet(editorRuntime);
  const notes = runtime.notes(query);
  const ranked = rankByFuzzy(notes, query, (n) => n.title, COMPLETION_LIMIT);

  const options: Completion[] = ranked.map((note) => ({
    label: note.title,
    detail: note.path,
    type: 'text',
    apply: applyWikiTarget(note.title),
  }));

  if (!options.length) return null;
  return {
    from: match.from + 2,
    options,
    filter: false,
    validFor: /^[^\]\n|]*$/,
  };
}
