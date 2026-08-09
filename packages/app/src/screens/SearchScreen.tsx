/**
 * Поиск — SCREENS §6, BEHAVIOR §4.
 *
 * Debounce 120 мс, запрос <2 символов не ищется, операторы и чипы-фильтры
 * ВСЕГДА синхронны (чип дописывает оператор в строку, снятие чипа убирает его),
 * при пустом запросе — «НЕДАВНИЕ» и «ПОСЛЕДНИЕ ОТКРЫТЫЕ».
 */
import { useMemo, useState, type ReactNode } from 'react';
import { formatQuery, parseQuery, type SearchFilters, type SearchHit } from '@zapiski/core';
import { Button, ChipRow, FilterChip, IconClock, SearchField } from '@zapiski/ui';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { EmptyBlock, Section } from '../components/ScreenStates.js';
import { shortDate } from '../lib/format.js';

export function SearchScreen(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const [focusHint, setFocusHint] = useState(true);

  const parsed = useMemo(() => parseQuery(state.query), [state.query]);
  const screenState = app.screenState('search', state.results.length === 0);

  /** Тап по чипу дописывает оператор в строку — строка и чипы синхронны. */
  const toggleFilter = (patch: Partial<SearchFilters>, active: boolean): void => {
    const filters: SearchFilters = { ...parsed.filters };
    for (const [key, value] of Object.entries(patch)) {
      const field = key as keyof SearchFilters;
      if (active) delete filters[field];
      else (filters as Record<string, unknown>)[field] = value;
    }
    app.setQuery(formatQuery({ text: parsed.text, filters }));
  };

  const activeFilters = describeFilters(parsed.filters);
  const empty = state.query.trim() === '';

  return (
    <div className="za-bottom__host">
      <div className="za-search__head">
        <SearchField
          label={strings.search.title}
          placeholder={strings.search.placeholder}
          value={state.query}
          autoFocus={focusHint}
          onFocus={() => setFocusHint(false)}
          onChange={(event) => app.setQuery(event.target.value)}
          onClear={() => app.setQuery('')}
          clearLabel={strings.app.close}
          onKeyDown={(event) => {
            if (event.key === 'Enter') app.rememberQuery(state.query);
            if (event.key === 'Escape') app.back();
          }}
        />
        <Button variant="text" onClick={() => app.back()}>
          {strings.app.cancel}
        </Button>
      </div>

      {/* Чипы-фильтры: визуальный эквивалент операторов (BEHAVIOR §4). */}
      <ChipRow className="za-search__filters" label={strings.search.filters.tag}>
        {state.tags.slice(0, 6).map(({ tag }) => {
          const active = (parsed.filters.tag ?? []).includes(tag);
          return (
            <FilterChip
              key={tag}
              active={active}
              onClick={() => toggleFilter({ tag: [tag] }, active)}
            >
              #{tag}
            </FilterChip>
          );
        })}
        {(['image', 'file', 'todo', 'link'] as const).map((value) => {
          const active = (parsed.filters.has ?? []).includes(value);
          return (
            <FilterChip
              key={value}
              active={active}
              onClick={() => toggleFilter({ has: [value] }, active)}
            >
              {strings.search.hasValues[value]}
            </FilterChip>
          );
        })}
      </ChipRow>

      <div className="za-scroll">
        {empty ? (
          <>
            {state.recentQueries.length > 0 ? (
              <>
                <Section>{strings.search.recent}</Section>
                {state.recentQueries.map((query) => (
                  <button
                    key={query}
                    type="button"
                    className="za-nav__item"
                    onClick={() => app.setQuery(query)}
                  >
                    <IconClock size={15} />
                    {query}
                  </button>
                ))}
              </>
            ) : null}
            <Section>{strings.search.lastOpened}</Section>
            {state.lastOpened.map((path) => {
              const note = state.notes.find((item) => item.path === path);
              if (!note) return null;
              return (
                <button
                  key={path}
                  type="button"
                  className="za-nav__item"
                  onClick={() => app.openNote(path)}
                >
                  {note.title || strings.notes.untitled}
                </button>
              );
            })}
          </>
        ) : screenState === 'empty' ? (
          <EmptyBlock
            title={strings.empty.search}
            description={
              activeFilters.length > 0
                ? `${strings.search.emptyHintPrefix} ${activeFilters.join(', ')}`
                : undefined
            }
          />
        ) : (
          state.results.map((hit) => <Hit key={hit.note.path} hit={hit} />)
        )}
      </div>
    </div>
  );

  function Hit({ hit }: { hit: SearchHit }): ReactNode {
    return (
      <button
        type="button"
        className="za-row"
        onClick={() => {
          app.rememberQuery(state.query);
          app.openNote(hit.note.path);
        }}
      >
        <span className="za-row__body">
          <span className="za-row__title">{hit.note.title || strings.notes.untitled}</span>
          {/* Зашифрованные: «содержимое не ищется» (BEHAVIOR §4). */}
          {hit.encryptedPlaceholder ? (
            <span className="za-row__snippet za-row__snippet--muted">
              {strings.notes.encryptedPlaceholder}
            </span>
          ) : (
            hit.fragments.map((fragment, index) => (
              <span key={index} className="za-hit__fragment">
                {highlight(fragment.text, fragment.ranges)}
              </span>
            ))
          )}
          <span className="za-row__meta">
            {hit.note.path} · {shortDate(hit.note.updatedAt)}
          </span>
        </span>
      </button>
    );
  }

  /** Активные фильтры перечисляются в подсказке пустой выдачи (BEHAVIOR §4). */
  function describeFilters(filters: SearchFilters): string[] {
    const parts: string[] = [];
    for (const tag of filters.tag ?? []) parts.push(`${strings.search.filters.tag}: #${tag}`);
    for (const folder of filters.folder ?? []) {
      parts.push(`${strings.search.filters.folder}: ${folder}`);
    }
    for (const has of filters.has ?? []) {
      parts.push(`${strings.search.filters.has}: ${strings.search.hasValues[has]}`);
    }
    if (filters.before !== undefined || filters.after !== undefined) {
      parts.push(strings.search.filters.period);
    }
    return parts;
  }
}

/** Подсветка всех вхождений: фон accent-soft, текст accent-on-soft. */
function highlight(text: string, ranges: ReadonlyArray<[number, number]>): ReactNode {
  if (ranges.length === 0) return text;
  const pieces: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) pieces.push(text.slice(cursor, start));
    pieces.push(
      <mark key={index} className="za-hit__mark">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return pieces;
}
