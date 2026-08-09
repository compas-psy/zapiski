/**
 * Строки поверхностей, которые рисует сама Windows: меню иконки в трее и
 * системный диалог согласия на обновление.
 *
 * Почему каталог локальный, а не из `packages/app`. Инвариант ARCHITECTURE §3
 * №5 запрещает зашитые строки — но не запрещает каталоги, и вот этих девяти
 * строк в каталоге приложения нет: они не принадлежат ни одному экрану.
 * Экранов у оболочки нет вовсе, а меню трея и `MessageBox` рисует сама ОС.
 * `@zapiski/app` экспортирует `strings()`, но там есть только `quickNote` как
 * описание хоткея — ни подписей меню трея, ни диалога обновления.
 *
 * Как только владелец каталога приложения заведёт эти ключи, файл удаляется,
 * а не дополняется: два источника правды для перевода хуже, чем один
 * неудобный.
 */
import { DEFAULT_LOCALE, isLocale, type Locale } from '@zapiski/core';

export interface PlatformStrings {
  tray: {
    quickNote: string;
    open: string;
    autostart: string;
    quit: string;
    tooltip: string;
  };
  update: {
    title: string;
    /** `version` — номер найденной версии. */
    question: (version: string) => string;
    install: string;
    later: string;
  };
  dialog: {
    /** Заголовок системного выбора папки vault'а (SCREENS §1, шаг 2). */
    pickVault: string;
  };
}

const CATALOGS: Record<Locale, PlatformStrings> = {
  ru: {
    tray: {
      quickNote: 'Быстрая заметка',
      open: 'Открыть КОМПАС.ЗАПИСКИ',
      autostart: 'Запускать при входе в систему',
      quit: 'Выйти',
      tooltip: 'КОМПАС.ЗАПИСКИ',
    },
    update: {
      title: 'КОМПАС.ЗАПИСКИ',
      question: (version) => `Вышла версия ${version}. Обновить сейчас?`,
      install: 'Обновить',
      later: 'Позже',
    },
    dialog: {
      pickVault: 'Где хранить заметки',
    },
  },
  en: {
    tray: {
      quickNote: 'Quick note',
      open: 'Open KOMPAS.NOTES',
      autostart: 'Launch at sign-in',
      quit: 'Quit',
      tooltip: 'KOMPAS.NOTES',
    },
    update: {
      title: 'KOMPAS.NOTES',
      question: (version) => `Version ${version} is available. Update now?`,
      install: 'Update',
      later: 'Later',
    },
    dialog: {
      pickVault: 'Where to keep your notes',
    },
  },
};

export function platformStrings(locale: Locale = DEFAULT_LOCALE): PlatformStrings {
  return CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE];
}

/** Язык оболочки: выбор пользователя, иначе язык системы, иначе русский. */
export function resolveShellLocale(stored: unknown): Locale {
  if (typeof stored === 'string' && isLocale(stored)) return stored;
  const preferred = typeof navigator === 'undefined' ? [] : [...navigator.languages];
  for (const item of preferred) {
    const short = item.slice(0, 2).toLowerCase();
    if (isLocale(short)) return short;
  }
  return DEFAULT_LOCALE;
}
