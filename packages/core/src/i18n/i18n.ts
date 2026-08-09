/**
 * i18n-архитектура с первого дня (ТЗ §6): ВСЕ пользовательские строки берутся
 * отсюда, ни одной зашитой в код (ARCHITECTURE §3, инвариант 5).
 */
import { en } from './en.js';
import { ru, type Catalog } from './ru.js';

export type Locale = 'ru' | 'en';

const CATALOGS: Record<Locale, Catalog> = { ru, en };

/** Основной язык — русский (ТЗ §6). */
export const DEFAULT_LOCALE: Locale = 'ru';

export function catalog(locale: Locale = DEFAULT_LOCALE): Catalog {
  return CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE];
}

export function isLocale(value: string): value is Locale {
  return value === 'ru' || value === 'en';
}

/** Выбор языка по списку из ОС/браузера с откатом на русский. */
export function resolveLocale(preferred: readonly string[]): Locale {
  for (const item of preferred) {
    const short = item.slice(0, 2).toLowerCase();
    if (isLocale(short)) return short;
  }
  return DEFAULT_LOCALE;
}

export { ru, en };
export type { Catalog };
