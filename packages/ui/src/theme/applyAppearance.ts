import {
  APPEARANCE_STORAGE_KEY,
  ACCENTS,
  BASE_FONT_SIZE,
  BASE_LINE_HEIGHT,
  DEFAULT_APPEARANCE,
  DEFAULT_EDITOR_PREFERENCES,
  EDITOR_COLUMN_WIDTHS,
  EDITOR_FONT_SIZES,
  EDITOR_LINE_HEIGHTS,
  THEME_PREFERENCES,
  migrateAccent,
  migrateTheme,
  resolveTheme,
  type AppearanceState,
  type Theme,
} from './types';

const includes = <T extends readonly unknown[]>(list: T, value: unknown): value is T[number] =>
  list.includes(value as T[number]);

/** Терпимый разбор сохранённого состояния: любое повреждение → значение по умолчанию. */
export function parseAppearance(raw: unknown): AppearanceState {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_APPEARANCE;
  const src = raw as Record<string, unknown>;
  const editorSrc = (typeof src['editor'] === 'object' && src['editor'] !== null
    ? src['editor']
    : {}) as Record<string, unknown>;

  /* Отменённые имена переносятся на нынешние ДО разбора: иначе выбор
     человека молча превратился бы в значение по умолчанию (см. types.ts). */
  const theme = migrateTheme(src['theme']);
  const accent = migrateAccent(src['accent']);

  return {
    theme: includes(THEME_PREFERENCES, theme) ? theme : DEFAULT_APPEARANCE.theme,
    accent: includes(ACCENTS, accent) ? accent : DEFAULT_APPEARANCE.accent,
    editor: {
      fontSize: includes(EDITOR_FONT_SIZES, editorSrc['fontSize'])
        ? editorSrc['fontSize']
        : DEFAULT_EDITOR_PREFERENCES.fontSize,
      lineHeight: includes(EDITOR_LINE_HEIGHTS, editorSrc['lineHeight'])
        ? editorSrc['lineHeight']
        : DEFAULT_EDITOR_PREFERENCES.lineHeight,
      columnWidth: includes(EDITOR_COLUMN_WIDTHS, editorSrc['columnWidth'])
        ? editorSrc['columnWidth']
        : DEFAULT_EDITOR_PREFERENCES.columnWidth,
      typeface: editorSrc['typeface'] === 'serif' ? 'serif' : 'sans',
      compact: editorSrc['compact'] === true,
      typewriter: editorSrc['typewriter'] === true,
      moveDone: editorSrc['moveDone'] === true,
      spellcheck: editorSrc['spellcheck'] === true,
      mode: editorSrc['mode'] === 'pro' ? 'pro' : 'simple',
    },
  };
}

export function readStoredAppearance(storage?: Storage | null): AppearanceState {
  const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  if (!store) return DEFAULT_APPEARANCE;
  try {
    const raw = store.getItem(APPEARANCE_STORAGE_KEY);
    return raw ? parseAppearance(JSON.parse(raw)) : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function writeStoredAppearance(state: AppearanceState, storage?: Storage | null): void {
  const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  if (!store) return;
  try {
    store.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* приватный режим / переполнение — молча живём с дефолтом */
  }
}

/** Множители над базовыми токенами, а не отдельные наборы значений. */
export function editorCssVariables(state: AppearanceState): Record<string, string> {
  const { editor } = state;
  return {
    '--editor-font-scale': String(round(editor.fontSize / BASE_FONT_SIZE)),
    '--editor-line-scale': String(round(editor.lineHeight / BASE_LINE_HEIGHT)),
    '--editor-measure':
      editor.columnWidth === 'full' ? 'none' : `${round(editor.columnWidth / BASE_FONT_SIZE)}rem`,
  };
}

const round = (n: number): number => Math.round(n * 100000) / 100000;

export interface ApplyOptions {
  /** Результат `matchMedia('(prefers-color-scheme: dark)')`. */
  prefersDark?: boolean;
}

/**
 * Пишет состояние на корневой элемент. Только атрибуты и CSS-переменные —
 * ни одного ререндера React, поэтому смена темы не стоит ничего.
 */
export function applyAppearance(
  root: HTMLElement,
  state: AppearanceState,
  options: ApplyOptions = {},
): Theme {
  const theme = resolveTheme(state.theme, options.prefersDark ?? false);
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-accent', state.accent);
  root.setAttribute('data-density', state.editor.compact ? 'compact' : 'comfortable');
  root.setAttribute('data-typeface', state.editor.typeface);
  for (const [name, value] of Object.entries(editorCssVariables(state))) {
    root.style.setProperty(name, value);
  }
  return theme;
}
