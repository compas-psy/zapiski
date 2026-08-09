import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../internal/cx';
import './Overlay.css';

/** Тост живёт 6 секунд (COMPONENTS.md §6, ARCHITECTURE §3.8 — «Отменить»). */
export const TOAST_DURATION_MS = 6000;

export interface ToastOptions {
  /** Текст тоста. Приходит пропсом — ни одной строки внутри компонента. */
  message: ReactNode;
  /** Подпись действия («Отменить»). */
  actionLabel?: ReactNode;
  onAction?: () => void;
  /** Мс жизни; по умолчанию 6000. */
  duration?: number;
}

export interface ToastApi {
  /** Показать тост. Один тост одновременно: новый вытесняет предыдущий. */
  show: (options: ToastOptions) => void;
  dismiss: () => void;
  current: ToastOptions | null;
}

const ToastContext = createContext<ToastApi | null>(null);

export interface ToastProviderProps {
  children: ReactNode;
  /** Куда портировать слой. По умолчанию document.body. */
  container?: HTMLElement | null;
}

export function ToastProvider({ children, container }: ToastProviderProps): ReactNode {
  const [toast, setToast] = useState<ToastOptions | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clear();
    setToast(null);
  }, [clear]);

  const show = useCallback(
    (options: ToastOptions) => {
      clear();
      setToast(options);
      timer.current = setTimeout(() => {
        timer.current = null;
        setToast(null);
      }, options.duration ?? TOAST_DURATION_MS);
    },
    [clear],
  );

  useEffect(() => clear, [clear]);

  /* Esc закрывает — как и любой другой оверлей. */
  useEffect(() => {
    if (!toast) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [toast, dismiss]);

  const api = useMemo<ToastApi>(() => ({ show, dismiss, current: toast }), [show, dismiss, toast]);
  const host = container ?? (typeof document === 'undefined' ? null : document.body);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toast && host
        ? createPortal(
            <div className="z-toast-layer">
              <Toast
                {...toast}
                onAction={
                  toast.onAction
                    ? () => {
                        toast.onAction?.();
                        dismiss();
                      }
                    : undefined
                }
              />
            </div>,
            host,
          )
        : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast() требует <ToastProvider>');
  return api;
}

export interface ToastProps extends ToastOptions {
  className?: string;
}

/** Сам тост. Обычно не используется напрямую — через useToast(). */
export function Toast({ message, actionLabel, onAction, className }: ToastProps): ReactNode {
  return (
    <div className={cx('z-toast', className)} role="status" aria-live="polite">
      <span>{message}</span>
      {actionLabel ? (
        <button type="button" className="z-toast__action" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
