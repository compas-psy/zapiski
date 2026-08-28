/**
 * `<App/>` — единственная точка монтирования продукта.
 *
 * Оболочки (`apps/web`, `apps/desktop`, `apps/mobile`) не рисуют НИЧЕГО: они
 * создают `AppHost` и монтируют этот компонент (ARCHITECTURE §1). Всё, что
 * ниже, — каркас из SCREENS «Каркас»: четыре раскладки по брейкпоинтам
 * 600 / 900 / 1200, маршрутизация, оверлеи и карта хоткеев BEHAVIOR §7.
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { SharedPayload, VaultPath } from "@zapiski/core";
/* `@zapiski/ui` подключает токены и стили компонентов сам (side effect). */
import {
  Button,
  Drawer,
  IconPen,
  PANE_LIMITS,
  ThemeProvider,
  ToastProvider,
  useTheme,
} from "@zapiski/ui";
import "./styles/app.css";
import type { AppHost, AppIntent, Layout } from "./contract.js";
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
import { PaneResizer } from "./components/PaneResizer.js";
import {
  flattenFolders,
  FolderPickerDialog,
  NO_CURRENT_LOCATION,
} from "./components/FolderDialogs.js";
import { CommandPalette } from "./screens/CommandPalette.js";
import { RemoveEncryptionSheet } from "./screens/NoteMenu.js";
import { DebugMenu } from "./screens/DebugMenu.js";
import { LibraryPanel } from "./screens/LibraryPanel.js";
import { NoteListScreen } from "./screens/NoteListScreen.js";
import { NoteScreen } from "./screens/NoteScreen.js";
import { OnboardingScreen } from "./screens/OnboardingScreen.js";
import { TitleBar } from "./components/TitleBar.js";
import { SearchScreen } from "./screens/SearchScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { SignInScreen } from "./screens/SignInScreen.js";
import { BILLING_ENABLED } from "@zapiski/core";
import { PaywallScreen } from "./screens/PaywallScreen.js";
import { ImportScreen } from "./screens/ImportScreen.js";
import { ArchiveScreen } from "./screens/ArchiveScreen.js";
import { TrashScreen } from "./screens/TrashScreen.js";
import { VersionsScreen } from "./screens/VersionsScreen.js";
import { HelpScreen } from "./screens/HelpScreen.js";
import { FeedbackScreen } from "./screens/FeedbackScreen.js";
import { FeedbackPrompt } from "./components/FeedbackPrompt.js";
import { ShareSheet } from "./screens/ShareSheet.js";
import { QuickNoteSheet } from "./screens/QuickNoteSheet.js";

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

/**
 * Каркас приложения — всё, что ниже провайдеров.
 *
 * Экспортируется намеренно: `App` создаёт контроллер сам, и тест, которому
 * нужен СВОЙ контроллер (перехваченная сеть, заданные настройки) или свой порт
 * намерений ОС, иначе не может смонтировать настоящий каркас — а значит не
 * может проверить дорогу от нажатия до экрана. Ровно эта дыра однажды
 * пропустила Справку, которая была готова и никуда не подключена.
 */
export function AppShell(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const layout = useLayout();
  const theme = useTheme();
  const sideBySide = useSideBySide(layout);
  /** Ширина панели, пока её тянут. `null` — никто ничего не тянет. */
  const [draggingPane, setDraggingPane] = useState<{
    key: "library" | "list";
    width: number;
  } | null>(null);
  /* Высота экранной клавиатуры в `--z-keyboard`: без неё тулбар редактора
     остаётся ПОД клавиатурой, что заказчик и увидел на Android. */
  useKeyboardInset();
  const [shared, setShared] = useState<SharedPayload | null>(null);
  /** Файл ассоциации `.md`, дожидающийся выбора папки (ТЗ §5.4). */
  const [openFile, setOpenFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
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

  /*
    Системное «назад» — кнопка и жест Android.

    Подписка живёт здесь, а не в оболочке, потому что решение «куда назад»
    продуктовое: контроллер разбирает слои поверх экрана, потом историю
    экранов, потом фильтр списка. Оболочка только приносит нажатие и уносит
    ответ: `false` означает «идти некуда» — и тогда система уводит из
    приложения, как и должна на корневом экране.
  */
  useEffect(() => {
    return app.host.onSystemBack?.(() => app.handleSystemBack());
  }, [app]);

  /* Глобальный хоткей быстрой заметки — только там, где порт есть. */
  useEffect(() => {
    const hotkey = app.host.platform.globalHotkey;
    if (!hotkey) return;
    const accelerator = "Ctrl+Alt+N";
    void hotkey.register(accelerator, () => app.openQuickNote());
    return () => void hotkey.unregister(accelerator);
  }, [app]);

  /*
    Намерения ОС: плитка в шторке, виджет «Записать», ассоциация `.md`.

    Порт был объявлен в контракте и не подключён НИ С ОДНОЙ стороны: событие
    доезжало до оболочки и упиралось в комментарий «намеренно пусто»
    (`apps/mobile/src/main.tsx`). То есть плитка и виджет, которые в системе
    выглядели рабочими, не делали ничего — человек нажимал и получал просто
    запущенное приложение.

    Разбирается намерение здесь, потому что это продуктовое решение: платформа
    знает, что нажали, а что показать — знает продукт. «Записать» открывает
    лист быстрой записки, а не пустой редактор: плитку жмут на ходу.

    Начальное намерение забирается ОДИН раз — иначе следующий запуск
    переоткрывал бы вчерашнее.
  */
  useEffect(() => {
    const handle = (intent: AppIntent): void => {
      switch (intent.kind) {
        case "new-note":
          app.openQuickNote();
          return;
        case "open-note":
          app.openNote(intent.id);
          return;
        case "open-file":
          void openIncomingFile(intent.path);
          return;
        default:
          /* `toggle-todo` живёт в оболочке, которая его шлёт; молча
             игнорировать неизвестное здесь правильнее, чем падать. */
          return;
      }
    };
    /**
     * Файл ассоциации `.md`: читает байты оболочка (путь снаружи хранилища,
     * вебу такого файла не видно), а куда его положить — спрашивает уже
     * продукт (BEHAVIOR §8, ТЗ §5.4).
     */
    const openIncomingFile = async (path: string): Promise<void> => {
      const bytes = await app.host.readOpenedFile?.(path);
      if (!bytes) {
        app.toast({ message: strings.library.openFileUnavailable });
        return;
      }
      const name = path.split(/[/\\]/).pop() ?? path;
      setOpenFile({ name, bytes });
    };
    void app.host.takeInitialIntent?.().then((intent) => {
      if (intent) handle(intent);
    });
    return app.host.onIntent?.(handle);
  }, [app, strings]);

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
      } else if (key === "k") {
        /* Ctrl+K — поиск, а не палитра. Так его читают Linear, Notion и Slack,
           и так он подписан у поля поиска в колонке списка. Палитра осталась
           на Ctrl+P и Ctrl+Shift+P: она никуда не делась, просто перестала
           занимать сочетание, которое все ищут для поиска. */
        handled();
        app.navigate({ name: "search" });
      } else if (key === "p" && !event.shiftKey) {
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
      {/*
        Быстрая записка. Оверлей, а не маршрут: она приходит поверх того, что
        человек делал, и обязана вернуть его туда же. Плитка в шторке, виджет
        на рабочем столе и Ctrl+Alt+N зовут её одним и тем же намерением.
      */}
      <QuickNoteSheet />
      {/*
        Снятие шифрования — единственный лист на всё приложение.

        Вход в операцию два (меню строки списка и меню открытой заметки), а
        место подтверждения одно: инвариант BEHAVIOR §0 считает места, и
        держать по листу в каждом экране значило бы завести второе.
      */}
      <RemoveEncryptionSheet
        reason="remove-encryption"
        open={state.decrypting !== null}
        path={state.decrypting ?? ""}
        onClose={() => app.askRemoveEncryption(null)}
      />
      <DebugMenu />
      <ShareSheet
        open={state.shareOpen}
        payload={shared}
        onClose={() => {
          app.toggleShare(false);
          setShared(null);
        }}
      />
      {/*
        Файл ассоциации `.md`: байты уже прочитаны оболочкой (эффект выше),
        остаётся спросить папку — тем же диалогом, что и «Переместить», но со
        своим заголовком: файл ещё не заметка, значит не «переместить».
      */}
      <FolderPickerDialog
        open={openFile !== null}
        current={NO_CURRENT_LOCATION}
        folders={flattenFolders(state.folders)}
        title={
          openFile ? strings.library.openFileFolderTitle(openFile.name) : ""
        }
        onPick={(folder) => {
          if (!openFile) return;
          void app
            .importOpenedFile(openFile.name, openFile.bytes, folder)
            .then((path) => {
              if (path) app.openNote(path);
            });
          setOpenFile(null);
        }}
        onClose={() => setOpenFile(null)}
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

  /*
   * Веб: без аккаунта дальше не пускаем.
   *
   * ── Почему только веб ────────────────────────────────────────────────────
   *
   * В оболочках человек сам выбрал папку и видит её: заметки лежат на этом
   * устройстве, и это понятно без объяснений. В браузере папки нет — заметки
   * живут в самом браузере. Зашёл с телефона, потом с ноутбука — списки
   * разные, причём каждый по-своему полный. Со стороны это неотличимо от
   * «данные пропали», и объяснять человеку устройство хранилища браузера
   * поздно и бессмысленно.
   *
   * Поэтому в вебе аккаунт — условие входа, а не украшение: он и есть то, что
   * связывает устройства. Решение заказчика, и оно про доверие к продукту, а
   * не про сбор адресов.
   *
   * Пока идёт загрузка, ворот нет: сессия читается из настроек асинхронно, и
   * показать экран входа человеку, который уже вошёл, значило бы соврать.
   */
  const needsAccount =
    app.host.platform.kind === "web" && !state.booting && state.account === null;

  if (needsAccount) {
    return (
      <div className="za-app">
        <TitleBar />
        <ScreenBoundary strings={strings} resetKey="gate">
          <SignInScreen gate />
        </ScreenBoundary>
        {overlays}
      </div>
    );
  }

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
        /* Экран цел и покрыт тестами; пока оплата выключена, он просто не
           показывается — заказчик просил спрятать тарифы, а не удалять их.
           `null` здесь означает «solo-экрана нет», и остаётся обычная
           библиотека, а не пустое окно. */
        return BILLING_ENABLED ? <PaywallScreen /> : null;
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
      /* Обращение из беты — тоже полноэкранное: человек в этот момент
         рассказывает о сбое, и делить экран со списком заметок ему незачем. */
      case "feedback":
        return <FeedbackScreen />;
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
        <FeedbackPrompt />
        <div className="za-frame">
          <div className="za-pane">
            {state.route.name === "note" ? notePane : listPane}
          </div>
        </div>
        {overlays}
      </div>
    );
  }

  /*
   * Ширины панелей — переменными CSS, а не классами: их значения приходят от
   * мыши и могут быть любыми. Во время перетаскивания берётся черновик, чтобы
   * ширина менялась под указателем, а в оформление она попадает один раз, на
   * отпускании (см. `PaneResizer`).
   */
  const paneWidths = {
    library: draggingPane?.key === "library" ? draggingPane.width : theme.panes.library,
    list: draggingPane?.key === "list" ? draggingPane.width : theme.panes.list,
  };

  return (
    <div className="za-app">
      <TitleBar />
      <FeedbackPrompt />
      <div
        className={`za-frame za-frame--${layout}`}
        style={
          {
            "--za-pane-library": `${paneWidths.library}px`,
            "--za-pane-list": `${paneWidths.list}px`,
          } as CSSProperties
        }
      >
        {/* ≥1200: библиотека — постоянная панель, а не оверлей. */}
        {layout === "triple" ? (
          <div className="za-pane za-pane--library">
            <LibraryPanel />
            <PaneResizer
              width={paneWidths.library}
              min={PANE_LIMITS.library.min}
              max={PANE_LIMITS.library.max}
              label={strings.app.resizeLibrary}
              onPreview={(width) => setDraggingPane({ key: "library", width })}
              onCommit={(width) => {
                setDraggingPane(null);
                theme.setPanes({ library: width });
              }}
            />
          </div>
        ) : null}
        <div className="za-pane za-pane--list">
          {listPane}
          <PaneResizer
            width={paneWidths.list}
            min={PANE_LIMITS.list.min}
            max={PANE_LIMITS.list.max}
            label={strings.app.resizeList}
            onPreview={(width) => setDraggingPane({ key: "list", width })}
            onCommit={(width) => {
              setDraggingPane(null);
              theme.setPanes({ list: width });
            }}
          />
        </div>
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
