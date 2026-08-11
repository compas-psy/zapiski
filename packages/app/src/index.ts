/**
 * `@zapiski/app` — ВСЕ экраны и всё поведение продукта.
 *
 * Публичный API пакета — только этот файл (ARCHITECTURE §5). Оболочке из
 * `apps/*` нужно ровно два имени: `App` и `AppHost`. Всё остальное здесь —
 * для тестов приёмки и отладочных инструментов; ни одна оболочка не должна
 * собирать экран сама (ARCHITECTURE §1).
 */

export { App, type AppProps } from './App.js';

// ── Контракт с платформой ───────────────────────────────────────────────────
export type {
  Appearance,
  AccentChoice,
  AppHost,
  AppIntent,
  AuthCallback,
  DebugOverrides,
  Layout,
  PreferencesStore,
  Route,
  ScreenState,
  SettingsSection,
  ThemeChoice,
  WidgetSnapshot,
} from './contract.js';

// ── Возврат после входа: разбор адреса и очистка адресной строки ────────────
// Оболочка получает ссылку своим механизмом, но разбирает её общим кодом —
// иначе три платформы разошлись бы в трактовке одного и того же адреса.
export {
  AUTH_CALLBACK_PARAMS,
  hasAuthCallback,
  parseAuthCallback,
  stripAuthParams,
  takeAuthFromAddressBar,
  type AddressBar,
  type AddressBarOptions,
} from './lib/auth-callback.js';

// ── Состояние и строки ──────────────────────────────────────────────────────
export {
  AppController,
  MATRIX,
  type AccountState,
  type AppState,
  type ListScope,
  type MatrixScreen,
  type SortMode,
  type ToastRequest,
} from './state/store.js';
export {
  AUTH_PREF,
  AuthError,
  SessionStore,
  type AuthErrorCode,
  type CloudSession,
} from './state/session.js';
export { createCloudBackend, originOf, type CloudBackendOptions } from './state/cloud.js';
export {
  AppProvider,
  layoutFor,
  useApp,
  useAppState,
  useLayout,
  useReducedMotion,
  useStrings,
  type AppProviderProps,
} from './state/context.js';
export { activeEditor, flushActiveEditor, setActiveEditor } from './state/active-editor.js';
export { DEFAULT_LOCALE, plural, strings, type AppCatalog, type Locale, type Strings } from './i18n/index.js';

// ── Механика жестов и списка — то, что проверяют приёмочные тесты ───────────
export {
  LONG_PRESS_MS,
  PULL_TO_SEARCH_PX,
  SWIPE_THRESHOLD_PX,
  SWIPE_VELOCITY_PX_PER_MS,
  useLongPress,
  usePull,
  useSwipe,
  type SwipeConfig,
  type SwipeState,
} from './lib/gestures.js';
export {
  ROW_HEIGHT,
  ROW_HEIGHT_COMPACT,
  VIRTUALIZE_FROM,
  useVirtualWindow,
} from './lib/virtual.js';
export {
  buildSections,
  flatten,
  selectNotes,
  sortNotes,
  type ListItem,
  type ListSection,
} from './lib/list.js';
export {
  clockTime,
  formatBytes,
  monthKey,
  monthSection,
  readingMinutes,
  relativeTime,
  shortDate,
} from './lib/format.js';

// ── Экраны (для витрины приёмки и отладочных сборок) ────────────────────────
export { ArchiveScreen } from './screens/ArchiveScreen.js';
export { CommandPalette, displayHotkey, editorHotkey } from './screens/CommandPalette.js';
export { DebugMenu } from './screens/DebugMenu.js';
export { EncryptSheet } from './screens/EncryptSheet.js';
export { ImportScreen } from './screens/ImportScreen.js';
export { InfoPanel } from './screens/InfoPanel.js';
export { LibraryPanel } from './screens/LibraryPanel.js';
export { LockScreen } from './screens/LockScreen.js';
export { NoteListScreen } from './screens/NoteListScreen.js';
export { NoteScreen } from './screens/NoteScreen.js';
export { OnboardingScreen } from './screens/OnboardingScreen.js';
export { PaywallScreen } from './screens/PaywallScreen.js';
export { SearchScreen } from './screens/SearchScreen.js';
export { SettingsScreen } from './screens/SettingsScreen.js';
export { ShareSheet, sharedText } from './screens/ShareSheet.js';
export { SignInScreen } from './screens/SignInScreen.js';
export { TrashScreen } from './screens/TrashScreen.js';
export { VersionsScreen } from './screens/VersionsScreen.js';
