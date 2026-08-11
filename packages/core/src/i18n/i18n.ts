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

/**
 * Язык интерфейса — русский, пока человек явно не выбрал другой
 * (ITERATION-1 §2). По локали ОС язык НЕ выбирается, и это не упущение:
 * продукт русскоязычный, а Windows с английской локалью — обычное дело в
 * России. Прежнее правило «идти за ОС» открывало приложение на английском у
 * людей, которые английского не спрашивали.
 *
 * Аргумент — сохранённый выбор из настроек, любого типа: значение приходит из
 * хранилища предпочтений и доверия к нему нет.
 */
export function storedLocale(value: unknown): Locale {
  return typeof value === 'string' && isLocale(value) ? value : DEFAULT_LOCALE;
}

export { ru, en };
export type { Catalog };
