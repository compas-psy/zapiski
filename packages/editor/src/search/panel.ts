/**
 * Поиск и замена внутри заметки (BEHAVIOR §4, хоткеи §7).
 *
 * Узкая панель поверх редактора, счётчик «3 из 12», Enter/Shift+Enter —
 * переходы, Esc — закрыть с сохранением позиции. Замена — Ctrl+H.
 *
 * Штатная панель `@codemirror/search` не годится: у неё англоязычные подписи,
 * нет счётчика и своя вёрстка. Берём её состояние и команды, рисуем своё.
 */

import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import type { Extension } from '@codemirror/state';
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Command, Panel, ViewUpdate } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import { editorStrings } from '../i18n.js';

/** Показывать ли строку замены — Ctrl+H против Ctrl+F. */
const setReplaceVisible = StateEffect.define<boolean>();

/** Сколько совпадений всего и каким по счёту идёт текущее. */
export function matchStats(
  view: EditorView,
): { current: number; total: number } {
  const query = getSearchQuery(view.state);
  if (!query.valid) return { current: 0, total: 0 };
  const cursor = query.getCursor(view.state);
  const head = view.state.selection.main.from;
  let total = 0;
  let current = 0;
  for (;;) {
    const next = cursor.next();
    if (next.done) break;
    total++;
    if (current === 0 && next.value.from >= head) current = total;
  }
  if (current === 0 && total > 0) current = total;
  return { current, total };
}

class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private readonly searchInput: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly replaceButton: HTMLButtonElement;
  private readonly replaceAllButton: HTMLButtonElement;
  private readonly counter: HTMLElement;

  constructor(private readonly view: EditorView) {
    const strings = view.state.facet(editorStrings);
    const dom = document.createElement('div');
    dom.className = 'cm-z-find';
    dom.setAttribute('role', 'search');

    this.searchInput = document.createElement('input');
    this.searchInput.type = 'text';
    this.searchInput.placeholder = strings.find.placeholder;
    this.searchInput.setAttribute('main-field', 'true');
    this.searchInput.setAttribute('aria-label', strings.find.placeholder);
    this.searchInput.value = getSearchQuery(view.state).search;

    this.counter = document.createElement('span');
    this.counter.className = 'cm-z-find-count';

    this.replaceInput = document.createElement('input');
    this.replaceInput.type = 'text';
    this.replaceInput.placeholder = strings.find.replacePlaceholder;
    this.replaceInput.setAttribute('aria-label', strings.find.replacePlaceholder);

    const prev = this.button(strings.find.previous, () => findPrevious(view));
    const next = this.button(strings.find.next, () => findNext(view));
    this.replaceButton = this.button(strings.find.replace, () => replaceNext(view));
    this.replaceAllButton = this.button(strings.find.replaceAll, () => replaceAll(view));
    const close = this.button(strings.find.close, () => closeSearchPanel(view));

    const commit = (): void => this.commit();
    this.searchInput.addEventListener('input', commit);
    this.replaceInput.addEventListener('input', commit);

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) findPrevious(view);
        else findNext(view);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeSearchPanel(view);
      }
    };
    this.searchInput.addEventListener('keydown', onKey);
    this.replaceInput.addEventListener('keydown', onKey);

    dom.append(
      this.searchInput,
      this.counter,
      prev,
      next,
      this.replaceInput,
      this.replaceButton,
      this.replaceAllButton,
      close,
    );
    this.dom = dom;
    this.setReplaceVisible(false);
  }

  private button(label: string, run: () => void): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.addEventListener('click', (event) => {
      event.preventDefault();
      run();
      this.view.focus();
    });
    return el;
  }

  private commit(): void {
    const query = new SearchQuery({
      search: this.searchInput.value,
      replace: this.replaceInput.value,
      caseSensitive: false,
      literal: true,
    });
    if (!query.eq(getSearchQuery(this.view.state))) {
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
    this.renderCounter();
  }

  private renderCounter(): void {
    const strings = this.view.state.facet(editorStrings);
    const query = getSearchQuery(this.view.state);
    if (!query.valid) {
      this.counter.textContent = '';
      return;
    }
    const { current, total } = matchStats(this.view);
    this.counter.textContent = total === 0 ? strings.find.empty : strings.find.count(current, total);
  }

  private setReplaceVisible(visible: boolean): void {
    const display = visible ? '' : 'none';
    this.replaceInput.style.display = display;
    this.replaceButton.style.display = display;
    this.replaceAllButton.style.display = display;
  }

  mount(): void {
    this.searchInput.focus();
    this.searchInput.select();
    this.renderCounter();
  }

  update(update: ViewUpdate): void {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setReplaceVisible)) this.setReplaceVisible(effect.value);
        if (effect.is(setSearchQuery) && effect.value.search !== this.searchInput.value) {
          this.searchInput.value = effect.value.search;
        }
      }
    }
    if (update.docChanged || update.selectionSet || update.transactions.length) {
      this.renderCounter();
    }
  }
}

/** Ctrl+F — поиск в заметке. */
export const openFind: Command = (view) => {
  view.dispatch({ effects: setReplaceVisible.of(false) });
  return openSearchPanel(view);
};

/** Ctrl+H — замена в заметке. */
export const openReplace: Command = (view) => {
  const opened = openSearchPanel(view);
  view.dispatch({ effects: setReplaceVisible.of(true) });
  return opened;
};

export const findPanel: Extension = search({
  top: true,
  literal: true,
  createPanel: (view) => new FindPanel(view),
});
