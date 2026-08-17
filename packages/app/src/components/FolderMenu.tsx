/**
 * Выбор папки всплывашкой — с вложенностью.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * В листе быстрой записки стоял обычный `<select>`. Заказчик: «окно выбора
 * папок — системное и выглядит очень неаккуратно и не учитывает вложенность.
 * Лучше всплывашку аккуратную, как в контекстном меню меню форматирования».
 *
 * Он прав дважды. Системный список на Android рисуется поверх всего своим
 * шрифтом и своими отступами — из аккуратного листа человек попадает в чужой
 * интерфейс. И, что важнее, `<option>` — плоская строка: дерево папок
 * «Практика/Супервизии» в нём выглядит одноуровневым перечислением, и выбрать
 * осознанно нельзя.
 *
 * ── Почему портал и Floating UI, а не `position: absolute` ──────────────────
 *
 * Ровно та ошибка, которая однажды сделала меню панели форматирования
 * недостижимым: у листа снизу стоит `overflow-y: auto`, а по CSS Overflow 3
 * скролл-контейнер обрезает всё абсолютно позиционированное внутри себя.
 * Меню, нарисованное «рядом с кнопкой», в таком листе не видно НИ ОДНИМ
 * пикселем. Поэтому всплывашка уезжает порталом в `document.body`, а место ей
 * считает Floating UI: `flip` перекидывает её вверх, когда снизу нет места
 * (лист стоит у клавиатуры — это норма, а не край), `shift` прижимает к
 * вьюпорту, `size` ограничивает высоту доступным просветом.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useFloating,
  type Placement,
} from '@floating-ui/react-dom';

export interface FolderMenuItem {
  /** Путь папки; пустая строка — корень хранилища. */
  path: string;
  /** Что показать: имя папки, а не весь путь. */
  label: string;
  /** Глубина вложенности — ею и рисуется дерево. */
  depth: number;
}

export interface FolderMenuProps {
  open: boolean;
  onClose: () => void;
  /** Кнопка, у которой всплывашка живёт. */
  anchor: HTMLElement | null;
  items: FolderMenuItem[];
  /** Что выбрано сейчас — у него галочка. */
  value: string;
  onPick: (path: string) => void;
  label: string;
  placement?: Placement;
}

export function FolderMenu({
  open,
  onClose,
  anchor,
  items,
  value,
  onPick,
  label,
  placement = 'top-start',
}: FolderMenuProps): ReactNode {
  const list = useRef<HTMLDivElement | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const { refs, floatingStyles } = useFloating({
    placement,
    /* Порядок middleware обязателен именно такой: `size` считает просвет уже
       после того, как `flip` выбрал сторону. Иначе высота считается для той
       стороны, где меню в итоге не окажется. */
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply: ({ availableHeight }) => setMaxHeight(Math.max(120, availableHeight)),
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    refs.setReference(anchor);
  }, [anchor, refs]);

  /* Закрытие: нажатие мимо и Esc. `pointerdown` — один поток для мыши, пера и
     пальца: на `mousedown` тач попадает только совместимостным событием, то
     есть через раз. */
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (list.current?.contains(target) === true) return;
      if (anchor?.contains(target) === true) return;
      onClose();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [anchor, onClose, open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={(node) => {
        list.current = node;
        refs.setFloating(node);
      }}
      className="za-folder-menu"
      role="listbox"
      aria-label={label}
      style={{ ...floatingStyles, ...(maxHeight === null ? {} : { maxBlockSize: maxHeight }) }}
    >
      {items.map((item) => (
        <button
          key={item.path}
          type="button"
          role="option"
          aria-selected={item.path === value}
          className="za-folder-menu__row"
          /* Вложенность — отступом, а не дефисами в тексте: дерево должно
             читаться глазом, а не разбираться по символам. */
          style={{ paddingInlineStart: `calc(var(--sp-12) + ${item.depth} * var(--sp-16))` }}
          onClick={() => {
            onPick(item.path);
            onClose();
          }}
        >
          <span className="za-folder-menu__mark" aria-hidden="true">
            {item.path === value ? '✓' : ''}
          </span>
          <span className="za-folder-menu__label">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

/**
 * Дерево папок в плоский список с глубиной.
 *
 * Дерево строится по путям, а не по вложенным узлам состояния: список папок
 * приходит путями («Практика/Супервизии»), и глубина в них уже записана — она
 * равна числу слэшей. Своя рекурсия здесь была бы вторым представлением одного
 * и того же.
 */
export function folderMenuItems(paths: string[], rootLabel: string): FolderMenuItem[] {
  const sorted = [...paths].sort((a, b) => a.localeCompare(b, 'ru'));
  return [
    { path: '', label: rootLabel, depth: 0 },
    ...sorted.map((path) => ({
      path,
      label: path.split('/').pop() ?? path,
      depth: path.split('/').length - 1,
    })),
  ];
}
