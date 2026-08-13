/**
 * Место панели форматирования (ITERATION-1 §4).
 *
 * ── Что было не так ─────────────────────────────────────────────────────────
 *
 * Панель стояла между шапкой редактора и названием заметки — то есть отнимала
 * полосу у текста и разрывала связку «хлебные крошки → название». Заказчик:
 * «Меню форматирования отображается фиксированно над заголовком, отнимая место
 * у области редактирования. На дизайнах заголовок заметки должен быть уместно
 * вверху под хлебными крошками».
 *
 * ── Что теперь ──────────────────────────────────────────────────────────────
 *
 * Место выбирает человек, и по умолчанию оно внизу по центру: там панель
 * ничего не отнимает у текста, а рука на телефоне до неё дотягивается. Третий
 * вариант — плавающая: её перетаскивают и она остаётся там, где оставили.
 *
 * Положение запоминается ОТ БЛИЖАЙШИХ КРАЁВ, а не в координатах. Так делают
 * все, кто держит перетаскиваемый элемент поверх меняющегося окна (пузырь
 * звонка в Android, AssistiveTouch): запоминается сторона и отступ от неё —
 * тогда при изменении размера окна панель остаётся у того же края, а не
 * уезжает за пределы экрана вслед за абсолютной координатой.
 *
 * Тащат за ручку, а не за саму панель: у кнопок свои нажатия, и отбирать у них
 * касание ради перетаскивания значило бы менять одну неработающую кнопку на
 * другую.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { PanelPlacement, PanelSpot } from '@zapiski/ui';

import { useStrings } from '../state/context.js';

export interface FormatPanelSlotProps {
  placement: PanelPlacement;
  spot: PanelSpot | null;
  /** Панель поставили на новое место — это уходит в настройки. */
  onMove: (spot: PanelSpot) => void;
  /** Телефон: панель прижимается к верхней кромке клавиатуры. */
  mobile: boolean;
  children: ReactNode;
}

/** Сколько панель отступает от края области при первом появлении. */
const MARGIN = 16;
/** Шаг перемещения с клавиатуры — стрелками, для тех, кто без мыши. */
const STEP = 16;

export function FormatPanelSlot({
  placement,
  spot,
  onMove,
  mobile,
  children,
}: FormatPanelSlotProps): ReactNode {
  const strings = useStrings();
  const box = useRef<HTMLDivElement>(null);
  /** Размеры области редактора и самой панели — от них считаются края. */
  const [size, setSize] = useState<{ host: DOMRect; panel: DOMRect } | null>(null);
  /** Пока тащат — живые координаты от левого верхнего угла области. */
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);
  const origin = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const measure = useCallback(() => {
    const node = box.current;
    const host = node?.offsetParent;
    if (!node || !(host instanceof HTMLElement)) return;
    setSize({ host: host.getBoundingClientRect(), panel: node.getBoundingClientRect() });
  }, []);

  /* Размеры нужны до первой отрисовки на месте: иначе панель успевает
     мелькнуть в углу и только потом встать куда просили. */
  useLayoutEffect(() => {
    if (placement !== 'floating') return;
    measure();
  }, [placement, measure]);

  useEffect(() => {
    if (placement !== 'floating' || typeof ResizeObserver === 'undefined') return;
    const node = box.current;
    const host = node?.offsetParent;
    if (!node || !(host instanceof HTMLElement)) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(host);
    observer.observe(node);
    return () => observer.disconnect();
  }, [placement, measure]);

  if (placement !== 'floating') {
    /* Прижатие к клавиатуре — только у нижнего места: оно для того и нужно.
       Верхнее человек выбирает как раз затем, чтобы панель стояла на месте. */
    const keyboard = mobile && placement === 'bottom' ? ' za-editor__panel--keyboard' : '';
    return <div className={`za-editor__panel za-editor__panel--${placement}${keyboard}`}>{children}</div>;
  }

  const style = floatingStyle(spot, size, dragging);

  const startDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const node = box.current;
    const host = node?.offsetParent;
    if (!node || !(host instanceof HTMLElement)) return;
    const rect = node.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    origin.current = {
      px: event.clientX,
      py: event.clientY,
      x: rect.left - hostRect.left,
      y: rect.top - hostRect.top,
    };
    setSize({ host: hostRect, panel: rect });
    setDragging({ x: origin.current.x, y: origin.current.y });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const from = origin.current;
    if (!from || !size) return;
    setDragging(
      clampSpot(
        from.x + (event.clientX - from.px),
        from.y + (event.clientY - from.py),
        size,
      ),
    );
  };

  const endDrag = (): void => {
    if (!origin.current || !dragging || !size) return;
    origin.current = null;
    onMove(spotFrom(dragging, size));
    setDragging(null);
  };

  /** Стрелками — для тех, у кого мыши нет вовсе. */
  const nudge = (dx: number, dy: number): void => {
    const node = box.current;
    const host = node?.offsetParent;
    if (!node || !(host instanceof HTMLElement)) return;
    const rect = node.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const measured = { host: hostRect, panel: rect };
    const next = clampSpot(rect.left - hostRect.left + dx, rect.top - hostRect.top + dy, measured);
    onMove(spotFrom(next, measured));
  };

  return (
    <div ref={box} className="za-editor__panel za-editor__panel--float" style={style}>
      <button
        type="button"
        className="za-editor__grip"
        aria-label={strings.settings.editor.panelMove}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(event) => {
          const shift: Record<string, [number, number]> = {
            ArrowLeft: [-STEP, 0],
            ArrowRight: [STEP, 0],
            ArrowUp: [0, -STEP],
            ArrowDown: [0, STEP],
          };
          const move = shift[event.key];
          if (!move) return;
          event.preventDefault();
          nudge(move[0], move[1]);
        }}
      >
        <GripGlyph />
      </button>
      {children}
    </div>
  );
}

/** Куда встать: из запомненных краёв либо из живых координат перетаскивания. */
function floatingStyle(
  spot: PanelSpot | null,
  size: { host: DOMRect; panel: DOMRect } | null,
  dragging: { x: number; y: number } | null,
): CSSProperties {
  if (dragging) return { left: `${dragging.x}px`, top: `${dragging.y}px` };
  if (!spot) {
    /* Ещё не ставили — там же, где стояла бы обычная панель: внизу по центру.
       Первое появление не должно выглядеть как сбой раскладки. */
    return { left: '50%', bottom: `${MARGIN}px`, transform: 'translateX(-50%)' };
  }
  /* Отступы ужимаются под нынешний размер области: окно могло стать меньше с
     прошлого раза, и панель иначе оказалась бы за краем. */
  const free = size ? Math.max(0, size.host.width - size.panel.width) : Infinity;
  const freeBlock = size ? Math.max(0, size.host.height - size.panel.height) : Infinity;
  const inline = `${Math.min(spot.inline, free)}px`;
  const offset = `${Math.min(spot.offset, freeBlock)}px`;
  return {
    ...(spot.side === 'start' ? { left: inline } : { right: inline }),
    ...(spot.block === 'start' ? { top: offset } : { bottom: offset }),
  };
}

/** Не дать панели уехать за пределы области редактора. */
function clampSpot(
  x: number,
  y: number,
  size: { host: DOMRect; panel: DOMRect },
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, size.host.width - size.panel.width)),
    y: Math.min(Math.max(0, y), Math.max(0, size.host.height - size.panel.height)),
  };
}

/** Координаты → ближайшие края. Это и запоминается. */
function spotFrom(
  at: { x: number; y: number },
  size: { host: DOMRect; panel: DOMRect },
): PanelSpot {
  const centerX = at.x + size.panel.width / 2;
  const centerY = at.y + size.panel.height / 2;
  const side = centerX < size.host.width / 2 ? 'start' : 'end';
  const block = centerY < size.host.height / 2 ? 'start' : 'end';
  return {
    side,
    block,
    inline: Math.round(
      side === 'start' ? at.x : Math.max(0, size.host.width - (at.x + size.panel.width)),
    ),
    offset: Math.round(
      block === 'start' ? at.y : Math.max(0, size.host.height - (at.y + size.panel.height)),
    ),
  };
}

/** Шесть точек — общепринятый знак «меня можно тащить». */
function GripGlyph(): ReactNode {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
      {[4, 8, 12].map((y) =>
        [3, 7].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.1" fill="currentColor" />),
      )}
    </svg>
  );
}
