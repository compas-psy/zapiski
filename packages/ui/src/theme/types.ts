/**
 * Модель темизации — tz/ZAPISKI_TZ_1_Design.md §1–§2.
 * Два независимых измерения (тема × акцент) + пользовательские настройки
 * редактора, которые работают как МНОЖИТЕЛИ над базовыми токенами.
 */

/**
 * `paper` — «Бумага», светлая и базовая; `graphite` — «Графит», обычная
 * тёмная; `ink` — «Чернила», OLED. Состав и значения — §1 и §2 мастер-ТЗ.
 */
export const THEMES = ['paper', 'graphite', 'ink'] as const;
export type Theme = (typeof THEMES)[number];

/** Что выбирает пользователь. По умолчанию — `system` (следует за ОС). */
export const THEME_PREFERENCES = ['system', ...THEMES] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/**
 * Три пресета акцента вместо шести (§1.6). Причина в самом ТЗ и она
 * арифметическая: «3 темы × 6 акцентов = 18 комбинаций, которые пришлось бы
 * регрессить на каждом релизе». Гранат — базовый, он же цвет иконки (Р5).
 */
export const ACCENTS = ['garnet', 'blueberry', 'slate'] as const;
export type Accent = (typeof ACCENTS)[number];

/**
 * Выбор, сохранённый предыдущей версией приложения.
 *
 * Отменённых имён восемь: тема `simpas` и шесть акцентов чужой дизайн-системы
 * плюс `heather` из самой первой редакции. Без карты каждый из них попал бы в
 * общий «не знаю — значит по умолчанию»: человек, однажды выбравший светлую
 * тему руками, получил бы после обновления `system` и тёмный экран вечером.
 * Поэтому тема переносится точно, а акцент — по ближайшему тону: серый в
 * «Грифель», синеватый в «Чернику», остальное в базовый «Гранат».
 */
const LEGACY_THEMES: Record<string, ThemePreference> = { simpas: 'paper' };
const LEGACY_ACCENTS: Record<string, Accent> = {
  granite: 'slate',
  clay: 'garnet',
  dusk: 'blueberry',
  heather: 'blueberry',
  pine: 'garnet',
  forest: 'garnet',
  gold: 'garnet',
};

/** Отменённое имя → нынешнее. Незнакомое имя оставляем как есть: разберётся разбор. */
export const migrateTheme = (value: unknown): unknown =>
  typeof value === 'string' && value in LEGACY_THEMES ? LEGACY_THEMES[value] : value;

export const migrateAccent = (value: unknown): unknown =>
  typeof value === 'string' && value in LEGACY_ACCENTS ? LEGACY_ACCENTS[value] : value;

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
  /** «Гранат» — акцент по умолчанию во всех темах (Р5). */
  accent: 'garnet',
  editor: DEFAULT_EDITOR_PREFERENCES,
};

/** Ключ в localStorage. Выбор пользователя переживает перезапуск. */
export const APPEARANCE_STORAGE_KEY = 'zapiski.appearance';

/** `system` → конкретная тема: светлая ОС → «Бумага», тёмная → «Графит». */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): Theme {
  if (preference !== 'system') return preference;
  return prefersDark ? 'graphite' : 'paper';
}
