/**
 * Контекст приложения: контроллер + подписка на состояние + строки + раскладка.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useToast } from '@zapiski/ui';
import type { AppHost, Layout } from '../contract.js';
import { strings as buildStrings, type Locale, type Strings } from '../i18n/index.js';
import { AppController, type AppState } from './store.js';

const ControllerContext = createContext<AppController | null>(null);

export interface AppProviderProps {
  host: AppHost;
  locale?: Locale;
  children: ReactNode;
  /** Готовый контроллер — используется тестами и отладкой. */
  controller?: AppController;
}

export function AppProvider({ host, locale, children, controller }: AppProviderProps): ReactNode {
  const toast = useToast();
  const app = useMemo(
    () => controller ?? new AppController(host, () => {}, locale),
    [controller, host, locale],
  );

  /* Тосты идут через ToastProvider из @zapiski/ui: один тост одновременно,
     живёт 6 секунд, новый вытесняет предыдущий (BEHAVIOR §0). */
  useEffect(() => {
    app.setToastSink((request) => {
      toast.show({
        message: request.message,
        ...(request.actionLabel ? { actionLabel: request.actionLabel } : {}),
        ...(request.onAction ? { onAction: () => void request.onAction?.() } : {}),
      });
    });
  }, [app, toast]);

  useEffect(() => {
    void app.boot();
    return () => app.dispose();
  }, [app]);

  /* Оффлайн — нормальный режим, а не сбой (SCREENS §10). */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = (): void => app.setOnline(navigator.onLine !== false);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [app]);

  /* Сворачивание приложения — немедленный замок (BEHAVIOR §5.3). */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') app.lockAll();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [app]);

  /*
   * Возвращение к приложению — момент пересмотреть папку.
   *
   * Заказчик: «если приложение ЗАПИСКИ открыто, то добавленные папки
   * отображаются сразу, а файлы только после перезагрузки приложения». Файлы
   * приезжали из индекса в памяти, а он собирается один раз, при открытии
   * хранилища. Следить за папкой постоянно нельзя — ни в вебе, ни за
   * системным провайдером Android уведомлений об изменениях нет, — но есть
   * ровно тот момент, когда пересмотр и нужен: человек скопировал дерево
   * файловым менеджером и вернулся сюда.
   *
   * Оба события, а не одно: `visibilitychange` ловит переключение задач на
   * телефоне, `focus` — переключение окон на Windows, где вкладка видима
   * всё время.
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onBack = (): void => {
      if (document.visibilityState === 'hidden') return;
      /* Заодно досылаем накопленное: пока приложение спало, правки могли
         остаться неотправленными, а события «сеть вернулась» на телефоне
         может не случиться вовсе. */
      void app.rescanVault().then(() => app.resumeSync());
    };
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);
    return () => {
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('focus', onBack);
    };
  }, [app]);

  return <ControllerContext.Provider value={app}>{children}</ControllerContext.Provider>;
}

export function useApp(): AppController {
  const app = useContext(ControllerContext);
  if (!app) throw new Error('useApp() требует <AppProvider>');
  return app;
}

export function useAppState(): AppState {
  const app = useApp();
  return useSyncExternalStore(app.subscribe, app.getState, app.getState);
}

export function useStrings(): Strings {
  const { locale } = useAppState();
  return useMemo(() => buildStrings(locale), [locale]);
}

/**
 * Раскладка по брейкпоинтам 600 / 900 / 1200 (SCREENS «Каркас»).
 * 600–900 в landscape ведёт себя как две панели — это и есть `compact`.
 */
export function useLayout(): Layout {
  const [layout, setLayout] = useState<Layout>(() => layoutFor(viewportWidth()));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = (): void => setLayout(layoutFor(window.innerWidth));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return layout;
}

function viewportWidth(): number {
  return typeof window === 'undefined' ? 1280 : window.innerWidth;
}

export function layoutFor(width: number): Layout {
  if (width < 600) return 'mobile';
  if (width < 900) return 'compact';
  if (width < 1200) return 'dual';
  return 'triple';
}

/** `prefers-reduced-motion` — анимации не проигрываются (критерий №9). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const handler = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener('change', handler);
    return () => query.removeEventListener('change', handler);
  }, []);
  return reduced;
}
