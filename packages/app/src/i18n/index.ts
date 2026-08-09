/**
 * Строки приложения = каталог экранов (`ru`/`en` этого пакета) + реестр ошибок
 * и системных сообщений из `@zapiski/core/i18n`.
 *
 * Реестр BEHAVIOR §11 не копируется и не переписывается: приёмочный критерий
 * C11 требует посимвольного совпадения, поэтому единственный его экземпляр
 * живёт в ядре.
 */
import { catalog as coreCatalog, DEFAULT_LOCALE, type Catalog, type Locale } from '@zapiski/core';
import { en } from './en.js';
import { ru, type AppCatalog } from './ru.js';

export type { AppCatalog, Locale };
export { plural } from './ru.js';

const CATALOGS: Record<Locale, AppCatalog> = { ru, en };

/** Полный набор строк, который получает экран. */
export interface Strings extends AppCatalog {
  /** Реестр BEHAVIOR §11 — как есть из ядра. */
  errors: Catalog['errors'];
  actions: Catalog['actions'];
  notes: Catalog['notes'];
  empty: Catalog['empty'];
  syncState: Catalog['sync'];
}

export function strings(locale: Locale = DEFAULT_LOCALE): Strings {
  const core = coreCatalog(locale);
  const app = CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE];
  return {
    ...app,
    errors: core.errors,
    actions: core.actions,
    notes: core.notes,
    empty: core.empty,
    syncState: core.sync,
  };
}

export { ru, en, DEFAULT_LOCALE };
