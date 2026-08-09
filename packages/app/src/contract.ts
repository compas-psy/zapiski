/**
 * Контракт приложения КОМПАС.ЗАПИСКИ.
 *
 * `packages/app` содержит ВСЕ экраны и ВСЁ поведение. Платформенные оболочки
 * (`apps/web`, `apps/desktop`, `apps/mobile`) обязаны быть тонкими: они только
 * создают `AppHost` и монтируют `<App host={...} />`.
 *
 * Если оболочке понадобилось отрисовать что-то своё — это ошибка проектирования
 * (docs/ARCHITECTURE.md §1): значит, у `AppHost` не хватает порта, и добавлять
 * нужно порт, а не экран.
 */

import type {
  PdfRenderer,
  PlatformCapabilities,
  VaultStorage,
  SyncBackend,
} from '@zapiski/core/contract';

/** Всё, что приложение получает от платформы. Больше ему ничего не нужно. */
export interface AppHost {
  readonly platform: PlatformCapabilities;

  /**
   * Хранилище последнего открытого vault'а, если оно уже известно
   * (например, восстановлено из permission handle в вебе). `null` — покажем
   * онбординг с выбором места хранения (SCREENS §1, шаг 2).
   */
  restoreVault(): Promise<VaultStorage | null>;

  /** Настройки приложения вне vault'а: тема, акцент, язык, выбранный backend. */
  readonly prefs: PreferencesStore;

  /** Открыть ссылку во внешнем браузере (deep link в КОМПАС.Дневник и т.п.). */
  openExternal(url: string): Promise<void>;

  /** Базовый URL KompasCloud. Отличается только в дев-режиме. */
  readonly cloudBaseUrl: string;
}

export interface PreferencesStore {
  get<T>(key: string, fallback: T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
  /** Реактивная подписка — смена темы применяется мгновенно, без перезагрузки. */
  subscribe(key: string, handler: (value: unknown) => void): () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Внешний вид (DESIGN_TOKENS §1, SCREENS §8 «Внешний вид», макет 4i)
// ─────────────────────────────────────────────────────────────────────────────

export type ThemeChoice = 'system' | 'paper' | 'graphite' | 'ink';
export type AccentChoice =
  | 'garnet'
  | 'pine'
  | 'gold'
  | 'blueberry'
  | 'heather'
  | 'slate';

export interface Appearance {
  theme: ThemeChoice;
  accent: AccentChoice;
  /** 5 ступеней (DESIGN_TOKENS §2). */
  fontSize: 14 | 15 | 16 | 18 | 20;
  lineHeight: 1.45 | 1.65 | 1.85;
  columnWidth: 640 | 720 | 'full';
  serif: boolean;
  compact: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Маршруты (SCREENS)
// ─────────────────────────────────────────────────────────────────────────────

export type Route =
  | { name: 'onboarding'; step: 1 | 2 | 3 }
  | { name: 'list'; folder?: string; tag?: string }
  | { name: 'note'; id: string }
  | { name: 'search' }
  | { name: 'archive' }
  | { name: 'trash' }
  | { name: 'settings'; section: SettingsSection }
  | { name: 'paywall' }
  | { name: 'signin' }
  | { name: 'import' }
  | { name: 'versions'; noteId: string };

export type SettingsSection =
  | 'appearance'
  | 'editor'
  | 'sync'
  | 'security'
  | 'transfer'
  | 'storage'
  | 'account'
  | 'plus';

// ─────────────────────────────────────────────────────────────────────────────
// Состояния экрана — матрица BEHAVIOR §12.
// Каждая ячейка обязана быть воспроизводима в отладочном меню
// (приёмочный критерий №10).
// ─────────────────────────────────────────────────────────────────────────────

export type ScreenState =
  | 'normal'
  | 'empty'
  | 'loading'
  | 'offline'
  | 'error'
  | 'locked';

/** Отладочное меню: принудительно показать любую ячейку матрицы §12. */
export interface DebugOverrides {
  forceState: ScreenState | null;
  forceSyncBackend: SyncBackend['id'] | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Адаптив (SCREENS «Каркас»): брейкпоинты 600 / 900 / 1200
// ─────────────────────────────────────────────────────────────────────────────

export type Layout =
  /** <600: один столбец, библиотека — выезжающая панель, поиск и FAB снизу */
  | 'mobile'
  /** 600–900: как mobile, в landscape список и редактор рядом */
  | 'compact'
  /** 900–1200: две панели, библиотека — оверлей по кнопке */
  | 'dual'
  /** ≥1200: три панели — библиотека 224 | список 288 | редактор */
  | 'triple';

// ─────────────────────────────────────────────────────────────────────────────
// Дополнение контракта (добавлено реализацией, строго в конец файла).
// Ничего выше не изменено: два порта ниже прирастают к `AppHost` слиянием
// объявлений, поэтому существующие оболочки продолжают компилироваться.
//
// Оба нужны экспорту (BEHAVIOR §9): ядро готовит печатный документ и байты
// файла, но записать их наружу может только платформа.
// ─────────────────────────────────────────────────────────────────────────────

export interface AppHost {
  /**
   * Растеризация печатного HTML в PDF. `null` — платформа печатать не умеет,
   * и пункт «PDF» в экспорте СКРЫТ, а не выключен (ARCHITECTURE §2).
   */
  readonly pdf: PdfRenderer | null;

  /** Отдать готовый файл пользователю: «Скачать» в вебе, диалог в desktop. */
  saveFile(name: string, data: Uint8Array, mime: string): Promise<void>;
}
