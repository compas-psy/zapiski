import { useEffect, useId, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export interface OverlayOptions {
  open: boolean;
  onClose: () => void;
  /** Esc закрывает (COMPONENTS.md §6 — «все оверлеи закрываются по Esc»). */
  closeOnEscape?: boolean;
  /** Ловушка фокуса внутри слоя. */
  trapFocus?: boolean;
  /** Вернуть фокус на вызвавший элемент при закрытии. */
  restoreFocus?: boolean;
  /** Фокус на первый интерактивный элемент при открытии. */
  autoFocus?: boolean;
}

/**
 * Общая механика модальных слоёв: Esc, ловушка фокуса, возврат фокуса.
 * Используется BottomSheet / Modal / Drawer — поведение одинаково у всех.
 */
export function useOverlay<T extends HTMLElement>({
  open,
  onClose,
  closeOnEscape = true,
  trapFocus = true,
  restoreFocus = true,
  autoFocus = true,
}: OverlayOptions): { ref: React.RefObject<T | null>; titleId: string; descriptionId: string } {
  const ref = useRef<T>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const rawId = useId();
  const titleId = `z-overlay-title-${rawId}`;
  const descriptionId = `z-overlay-desc-${rawId}`;

  /* Запоминаем вызвавший элемент до того, как фокус уедет внутрь слоя. */
  useEffect(() => {
    if (!open) return;
    invoker.current = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      if (!restoreFocus) return;
      const target = invoker.current;
      invoker.current = null;
      if (target && document.contains(target)) target.focus({ preventScroll: true });
    };
  }, [open, restoreFocus]);

  useEffect(() => {
    if (!open || !autoFocus) return;
    const container = ref.current;
    if (!container) return;
    const first = focusableWithin(container)[0];
    (first ?? container).focus({ preventScroll: true });
  }, [open, autoFocus]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (closeOnEscape && event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (!trapFocus || event.key !== 'Tab') return;
      const container = ref.current;
      if (!container) return;
      const items = focusableWithin(container);
      if (items.length === 0) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose, closeOnEscape, trapFocus]);

  return { ref, titleId, descriptionId };
}
