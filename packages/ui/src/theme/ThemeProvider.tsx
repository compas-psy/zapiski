import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_APPEARANCE,
  resolveTheme,
  type Accent,
  type AppearanceState,
  type EditorPreferences,
  type Theme,
  type ThemePreference,
} from './types';
import { applyAppearance, readStoredAppearance, writeStoredAppearance } from './applyAppearance';

const DARK_QUERY = '(prefers-color-scheme: dark)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
/** Длительность кроссфейда при смене темы/акцента — 200 мс (--dur-base). */
const CROSSFADE_MS = 200;

export interface ThemeContextValue {
  /** Что выбрал пользователь: system | paper | graphite | ink. */
  preference: ThemePreference;
  /** Что реально применено к DOM (system уже разрешён). */
  theme: Theme;
  accent: Accent;
  editor: EditorPreferences;
  prefersDark: boolean;
  prefersReducedMotion: boolean;
  setTheme: (preference: ThemePreference) => void;
  setAccent: (accent: Accent) => void;
  setEditor: (patch: Partial<EditorPreferences>) => void;
  reset: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/* Тема применяется ДО первого кадра — иначе первый кадр мигает светлым.
   На сервере layout-эффекта нет, там за это отвечает themeInitScript. */
const useApplyEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

function matches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

function subscribe(query: string, listener: (matched: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(query);
  const handler = (event: MediaQueryListEvent): void => listener(event.matches);
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}

export interface ThemeProviderProps {
  children: ReactNode;
  /** Начальное состояние; по умолчанию — прочитанное из localStorage. */
  initial?: AppearanceState;
  /** Куда писать атрибуты. По умолчанию — <html>. */
  rootElement?: HTMLElement | null;
  /** Отключить запись в localStorage (например, в тестах). */
  persist?: boolean;
  storage?: Storage | null;
}

export function ThemeProvider({
  children,
  initial,
  rootElement,
  persist = true,
  storage,
}: ThemeProviderProps): ReactNode {
  const [state, setState] = useState<AppearanceState>(
    () => initial ?? readStoredAppearance(storage),
  );
  const [prefersDark, setPrefersDark] = useState<boolean>(() => matches(DARK_QUERY));
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(() =>
    matches(REDUCED_MOTION_QUERY),
  );
  const firstApply = useRef(true);
  const crossfadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => subscribe(DARK_QUERY, setPrefersDark), []);
  useEffect(() => subscribe(REDUCED_MOTION_QUERY, setPrefersReducedMotion), []);

  const root = useMemo(() => {
    if (rootElement !== undefined) return rootElement;
    return typeof document === 'undefined' ? null : document.documentElement;
  }, [rootElement]);

  /* Применение состояния к DOM. Никакого ререндера дерева: меняются только
     атрибуты и переменные на корне, каскад делает остальное. */
  useApplyEffect(() => {
    if (!root) return;
    const isFirst = firstApply.current;
    firstApply.current = false;

    /* Кроссфейд 200 мс — только на пользовательскую смену, не на монтирование
       (иначе первый кадр «наезжает» на разметку), и не при reduce-motion. */
    if (!isFirst && !prefersReducedMotion) {
      root.setAttribute('data-theme-crossfade', '');
      if (crossfadeTimer.current) clearTimeout(crossfadeTimer.current);
      crossfadeTimer.current = setTimeout(() => {
        root.removeAttribute('data-theme-crossfade');
        crossfadeTimer.current = null;
      }, CROSSFADE_MS);
    }

    applyAppearance(root, state, { prefersDark });
  }, [root, state, prefersDark, prefersReducedMotion]);

  useEffect(
    () => () => {
      if (crossfadeTimer.current) clearTimeout(crossfadeTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (persist) writeStoredAppearance(state, storage);
  }, [persist, state, storage]);

  const setTheme = useCallback((preference: ThemePreference) => {
    setState((prev) => ({ ...prev, theme: preference }));
  }, []);

  const setAccent = useCallback((accent: Accent) => {
    setState((prev) => ({ ...prev, accent }));
  }, []);

  const setEditor = useCallback((patch: Partial<EditorPreferences>) => {
    setState((prev) => ({ ...prev, editor: { ...prev.editor, ...patch } }));
  }, []);

  const reset = useCallback(() => setState(DEFAULT_APPEARANCE), []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference: state.theme,
      theme: resolveTheme(state.theme, prefersDark),
      accent: state.accent,
      editor: state.editor,
      prefersDark,
      prefersReducedMotion,
      setTheme,
      setAccent,
      setEditor,
      reset,
    }),
    [state, prefersDark, prefersReducedMotion, setTheme, setAccent, setEditor, reset],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme() требует <ThemeProvider>');
  return value;
}

/** Тема без падения, если провайдера нет (для изолированных виджетов). */
export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext);
}
