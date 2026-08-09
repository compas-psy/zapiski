/**
 * Модель темизации — DESIGN_TOKENS.md §1–§2.
 * Два независимых измерения (тема × акцент) + пользовательские настройки
 * редактора, которые работают как МНОЖИТЕЛИ над базовыми токенами.
 */

export const THEMES = ['paper', 'graphite', 'ink'] as const;
export type Theme = (typeof THEMES)[number];

/** Что выбирает пользователь. По умолчанию — `system` (следует за ОС). */
export const THEME_PREFERENCES = ['system', ...THEMES] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const ACCENTS = ['garnet', 'pine', 'gold', 'blueberry', 'heather', 'slate'] as const;
export type Accent = (typeof ACCENTS)[number];

/** Размер текста в редакторе — 5 ступеней (DESIGN_TOKENS.md §2). */
export const EDITOR_FONT_SIZES = [14, 15, 16, 18, 20] as const;
export type EditorFontSize = (typeof EDITOR_FONT_SIZES)[number];

/** Интерлиньяж — 3 ступени. */
export const EDITOR_LINE_HEIGHTS = [1.45, 1.65, 1.85] as const;
export type EditorLineHeight = (typeof EDITOR_LINE_HEIGHTS)[number];

/** Ширина колонки: 640 / 720 / вся ширина. */
export const EDITOR_COLUMN_WIDTHS = [640, 720, 'full'] as const;
export type EditorColumnWidth = (typeof EDITOR_COLUMN_WIDTHS)[number];

export type Typeface = 'sans' | 'serif';
export type Density = 'comfortable' | 'compact';

/** База, относительно которой считаются множители (см. tokens.css §1). */
export const BASE_FONT_SIZE = 16;
export const BASE_LINE_HEIGHT = 1.65;

export interface EditorPreferences {
  fontSize: EditorFontSize;
  lineHeight: EditorLineHeight;
  columnWidth: EditorColumnWidth;
  typeface: Typeface;
  /** Компактный режим: плотные строки списка + текст 14.5/1.5. */
  compact: boolean;
}

export interface AppearanceState {
  theme: ThemePreference;
  accent: Accent;
  editor: EditorPreferences;
}

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  fontSize: 16,
  lineHeight: 1.65,
  columnWidth: 640,
  typeface: 'sans',
  compact: false,
};

export const DEFAULT_APPEARANCE: AppearanceState = {
  theme: 'system',
  accent: 'garnet',
  editor: DEFAULT_EDITOR_PREFERENCES,
};

/** Ключ в localStorage. Выбор пользователя переживает перезапуск. */
export const APPEARANCE_STORAGE_KEY = 'zapiski.appearance';

/** `system` → конкретная тема: светлая ОС → paper, тёмная → graphite. */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): Theme {
  if (preference !== 'system') return preference;
  return prefersDark ? 'graphite' : 'paper';
}
