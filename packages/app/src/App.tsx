/**
 * `<App/>` — единственная точка монтирования продукта.
 *
 * Оболочки (`apps/web`, `apps/desktop`, `apps/mobile`) не рисуют НИЧЕГО: они
 * создают `AppHost` и монтируют этот компонент (ARCHITECTURE §1). Всё, что
 * ниже, — каркас из SCREENS «Каркас»: четыре раскладки по брейкпоинтам
 * 600 / 900 / 1200, маршрутизация, оверлеи и карта хоткеев BEHAVIOR §7.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SharedPayload, VaultPath } from "@zapiski/core";
/* `@zapiski/ui` подключает токены и стили компонентов сам (side effect). */
import {
  Button,
  Drawer,
  IconPen,
  ThemeProvider,
  ToastProvider,
} from "@zapiski/ui";
import "./styles/app.css";
import type { AppHost, Layout } from "./contract.js";
import type { Locale } from "./i18n/index.js";
import {
  AppProvider,
  useApp,
  useAppState,
  useLayout,
  useStrings,
} from "./state/context.js";
import { useKeyboardInset } from "./lib/keyboard.js";
import type { AppController } from "./state/store.js";
import { flushActiveEditor } from "./state/active-editor.js";
import { IconBug } from "./components/icons.js";
import { EmptyBlock } from "./components/ScreenStates.js";
import { ScreenBoundary } from "./components/ScreenBoundary.js";
import { CommandPalette } from "./screens/CommandPalette.js";
import { DebugMenu } from "./screens/DebugMenu.js";
import { LibraryPanel } from "./screens/LibraryPanel.js";
import { NoteListScreen } from "./screens/NoteListScreen.js";
import { NoteScreen } from "./screens/NoteScreen.js";
import { OnboardingScreen } from "./screens/OnboardingScreen.js";
import { TitleBar } from "./components/TitleBar.js";
import { SearchScreen } from "./screens/SearchScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { SignInScreen } from "./screens/SignInScreen.js";
import { PaywallScreen } from "./screens/PaywallScreen.js";
import { ImportScreen } from "./screens/ImportScreen.js";
import { ArchiveScreen } from "./screens/ArchiveScreen.js";
import { TrashScreen } from "./screens/TrashScreen.js";
import { VersionsScreen } from "./screens/VersionsScreen.js";
import { HelpScreen } from "./screens/HelpScreen.js";
import { ShareSheet } from "./screens/ShareSheet.js";

export interface AppProps {
  host: AppHost;
  /** Язык интерфейса. По умолчанию — русский (ТЗ §6). */
  locale?: Locale;
}

export function App({ host, locale }: AppProps): ReactNode {
  return (
    /* Тема применяется до первого кадра: атрибуты уже стоят из themeInitScript. */
    <ThemeProvider>
      {/* Один тост одновременно, живёт 6 секунд (BEHAVIOR §0). */}
      <ToastProvider>
        <AppProvider host={host} {...(locale ? { locale } : {})}>
          <AppShell />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

/**
 * 600–900 в landscape ведёт себя как две панели (SCREENS «Каркас»).
 * Ширины хватает не всегда, поэтому ориентацию спрашиваем отдельно.
 */
function useSideBySide(layout: Layout): boolean {
  const [landscape, setLandscape] = useState(false);
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return;
    const query = window.matchMedia("(orientation: landscape)");
    setLandscape(query.matches);
    const handler = (event: MediaQueryListEvent): void =>
      setLandscape(event.matches);
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  }, []);
  if (layout === "dual" || layout === "triple") return true;
  return layout === "compact" && landscape;
}

function AppShell(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const layout = useLayout();
  const sideBySide = useSideBySide(layout);
  /* Высота экранной клавиатуры в `--z-keyboard`: без неё тулбар редактора
     остаётся ПОД клавиатурой, что заказчик и увидел на Android. */
  useKeyboardInset();
  const [shared, setShared] = useState<SharedPayload | null>(null);
  /** Что показывает панель редактора, когда маршрут — список (desktop). */
  const [lastNote, setLastNote] = useState<VaultPath | null>(null);

  useEffect(() => {
    if (state.route.name === "note") setLastNote(state.route.id);
  }, [state.route]);

  /* Share-target: ОС передала контент — лист поверх, приложение не открываем. */
  useEffect(() => {
    const provider = app.host.platform.shareTarget;
    if (!provider) return;
    return provider.onShare((payload) => {
      setShared(payload);
      app.toggleShare(true);
    });
  }, [app]);

  /* Глобальный хоткей быстрой заметки — только там, где порт есть. */
  useEffect(() => {
    const hotkey = app.host.platform.globalHotkey;
    if (!hotkey) return;
    const accelerator = "Ctrl+Alt+N";
    void hotkey.register(accelerator, () => void app.createNote());
    return () => void hotkey.unregister(accelerator);
  }, [app]);

  /* Карта хоткеев оболочки (BEHAVIOR §7). Команды текста — в редакторе:
     если он их уже обработал, событие приходит с defaultPrevented. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (key === "escape") {
        if (state.paletteOpen) app.togglePalette(false);
        else if (state.focusMode) app.toggleFocusMode(false);
        else if (state.libraryOpen) app.toggleLibrary(false);
        return;
      }
      if (!mod) return;

      const handled = (): void => event.preventDefault();
      if (key === "n" && event.shiftKey) {
        handled();
        void app.createNote(state.folder ?? undefined);
      } else if (key === "n") {
        handled();
        void app.createNote();
      } else if (key === "k" || (key === "p" && !event.shiftKey)) {
        handled();
        app.togglePalette();
      } else if (key === "s" && event.shiftKey) {
        handled();
        app.navigate({ name: "search" });
      } else if (key === "\\") {
        handled();
        app.toggleLibrary();
      } else if (key === ",") {
        handled();
        app.openSettings();
      } else if (key === "f" && event.shiftKey) {
        handled();
        app.toggleFocusMode();
      } else if (key === "e" && event.shiftKey) {
        handled();
        app.navigate({ name: "settings", section: "transfer" });
      } else if (key === "e") {
        handled();
        app.toggleRawMode();
      } else if (key === "p" && event.shiftKey) {
        handled();
        const path = state.route.name === "note" ? state.route.id : null;
        const note = path
          ? state.notes.find((item) => item.path === path)
          : undefined;
        if (note) void app.setPinned(note.path, !note.pinned);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    app,
    state.focusMode,
    state.folder,
    state.libraryOpen,
    state.notes,
    state.paletteOpen,
    state.route,
  ]);

  /* Сворачивание вкладки — принудительное сохранение (BEHAVIOR §0). */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onHidden = (): void => {
      if (document.visibilityState === "hidden") flushActiveEditor();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, []);

  const notePath =
    state.route.name === "note" ? state.route.id : sideBySide ? lastNote : null;
  /**
   * Ключ — «какая заметка», а не «какой у неё сейчас путь».
   *
   * Путь меняется у ТОЙ ЖЕ заметки при переименовании по заголовку
   * (BEHAVIOR §2.2). С `key={notePath}` React считал это другим экраном и
   * пересоздавал его целиком: редактор размонтировался, фокус уходил в
   * `body`, и всё, что человек печатал дальше, пропадало молча. Ровно на это
   * пришла жалоба «просто набираешь текст…».
   *
   * Поэтому ключ живёт до тех пор, пока заметка та же, и меняется только при
   * переходе к другой. Проверено прогоном в браузере: без этого фокус после
   * переименования — `BODY`, с этим — остаётся в редакторе.
   */
  const noteKey = useNoteKey(app, notePath);

  const overlays = (
    <>
      <CommandPalette />
      <DebugMenu />
      <ShareSheet
        open={state.shareOpen}
        payload={shared}
        onClose={() => {
          app.toggleShare(false);
          setShared(null);
        }}
      />
      {/* Библиотека — выезжающая панель везде, кроме трёхпанельной раскладки. */}
      {layout !== "triple" ? (
        <Drawer
          open={state.libraryOpen}
          onClose={() => app.toggleLibrary(false)}
          label={strings.library.label}
        >
          <LibraryPanel />
        </Drawer>
      ) : null}
      {/* Возврат из принудительного состояния матрицы §12 — в один тап. */}
      {state.debug.forceState !== null ? (
        <button
          type="button"
          className="za-debug-fab za-nav__item"
          aria-label={strings.debug.title}
          onClick={() => app.toggleDebug(true)}
        >
          <IconBug size={16} />
          {strings.debug.states[state.debug.forceState]}
        </button>
      ) : null}
    </>
  );

  /* Экраны вне каркаса: занимают окно целиком на всех раскладках. */
  const solo = ((): ReactNode => {
    switch (state.route.name) {
      case "onboarding":
        return <OnboardingScreen step={state.route.step} />;
      case "signin":
        return <SignInScreen />;
      case "import":
        return <ImportScreen />;
      case "paywall":
        return <PaywallScreen />;
      case "settings":
        return <SettingsScreen section={state.route.section} />;
      case "versions":
        return <VersionsScreen noteId={state.route.noteId} />;
      /* Справка — полноэкранная, как настройки: у неё своя шапка с «Назад».
         Экран был написан и покрыт тестом, но НИКУДА не подключён — ни импорта,
         ни `case`. Маршрут переключался, `solo` возвращал `null`, и на месте
         справки оставался список заметок. Тест был зелёный, потому что
         монтировал экран напрямую: дорогу к экрану он проверить не мог. */
      case "help":
        return <HelpScreen />;
      /* Поиск полноэкранный (SCREENS §6) — в том числе на desktop. */
      case "search":
        return <SearchScreen />;
      default:
        return null;
    }
  })();

  /* Ключ сброса границы: уход с упавшего экрана обязан её «расколдовать». */
  const routeKey = `${state.route.name}:${"id" in state.route ? state.route.id : ""}`;

  if (solo !== null) {
    return (
      <div className="za-app">
        <TitleBar />
        <ScreenBoundary strings={strings} resetKey={routeKey}>
          {solo}
        </ScreenBoundary>
        {overlays}
      </div>
    );
  }

  /* Границы стоят вокруг СОДЕРЖИМОГО панелей, а не вокруг всего окна: упавший
     экран не должен уносить с собой навигацию, иначе человек остаётся в тупике
     без единой кнопки. */
  const listPane = (
    <ScreenBoundary strings={strings} resetKey={routeKey}>
      {((): ReactNode => {
        switch (state.route.name) {
          case "archive":
            return <ArchiveScreen />;
          case "trash":
            return <TrashScreen />;
          default:
            return (
              <NoteListScreen embedded={sideBySide} compactRows={sideBySide} />
            );
        }
      })()}
    </ScreenBoundary>
  );

  const notePane = (
    <ScreenBoundary strings={strings} resetKey={routeKey}>
      {notePath !== null ? (
        <NoteScreen key={noteKey} path={notePath} />
      ) : (
      /*
        REBUILD §1.9: без выбранной заметки здесь было белое поле на 70%
        ширины без единого элемента. Теперь пустое состояние по образцу `1n`:
        круг, «Выберите заметку», подпись и одна кнопка — по центру области.
      */
      <div className="za-editor">
        <div className="za-editor__surface za-editor__surface--empty">
          <EmptyBlock
            title={strings.notePane.title}
            description={strings.notePane.subtitle}
            icon={<IconPen size={24} />}
            action={
              <Button onClick={() => void app.createNote()}>
                {strings.list.newNote}
              </Button>
            }
          />
        </div>
      </div>
      )}
    </ScreenBoundary>
  );

  /* Режим фокуса: хром скрыт полностью, остаётся только редактор (SCREENS §4). */
  if (state.focusMode && notePath !== null) {
    return (
      <div className="za-app">
        <TitleBar />
        <div className="za-frame za-frame--focus">
          <div className="za-pane">{notePane}</div>
        </div>
        {overlays}
      </div>
    );
  }

  /* Mobile и compact-portrait — один столбец: список ⟷ заметка. */
  if (!sideBySide) {
    return (
      <div className="za-app">
        <TitleBar />
        <div className="za-frame">
          <div className="za-pane">
            {state.route.name === "note" ? notePane : listPane}
          </div>
        </div>
        {overlays}
      </div>
    );
  }

  return (
    <div className="za-app">
      <TitleBar />
      <div className={`za-frame za-frame--${layout}`}>
        {/* ≥1200: библиотека — постоянная панель 224, а не оверлей. */}
        {layout === "triple" ? (
          <div className="za-pane za-pane--library">
            <LibraryPanel />
          </div>
        ) : null}
        <div className="za-pane za-pane--list">{listPane}</div>
        <div className="za-pane">{notePane}</div>
      </div>
      {overlays}
    </div>
  );
}

/**
 * Устойчивый ключ экрана заметки.
 *
 * Возвращает одно и то же значение, пока открыта та же заметка, — даже если
 * её путь сменился переименованием. Меняется только при переходе к другой
 * заметке: тогда экран и должен пересоздаться, чтобы не унаследовать чужое
 * состояние.
 */
function useNoteKey(app: AppController, path: VaultPath | null): string {
  const key = useRef(0);
  const previous = useRef<VaultPath | null>(null);
  if (path !== previous.current) {
    if (!app.movedFrom(previous.current, path ?? "")) key.current += 1;
    previous.current = path;
  }
  return `note-${key.current}`;
}
