import {
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { cx } from '../../internal/cx';
import { IconChevronRight } from '../../icons';
import './Special.css';

export interface TreeNode {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  /** Счётчик — моно 11, без бейджей-кружков. */
  count?: ReactNode;
  /**
   * Служебный узел: строка приглушена.
   *
   * Заведено для папок вложений (`Images`, `Audio`, `Other files`) — их создаёт
   * приложение, и в дереве они не должны выглядеть наравне с папками человека.
   */
  muted?: boolean;
  /**
   * Строка видна и раскрывается как обычно, но её саму выбрать нельзя —
   * `onSelect` для неё не вызывается.
   *
   * Заведено для FolderPicker: текущее место переносимого объекта остаётся в
   * дереве структурным родителем (иначе его дети либо пропадают из вида, либо
   * поднимаются на чужой уровень и путаются с одноимёнными папками в другой
   * ветке) — но выбрать «перенести в то же самое место» бессмысленно.
   */
  disabled?: boolean;
  children?: readonly TreeNode[];
}

export interface TreeProps {
  nodes: readonly TreeNode[];
  /** Подпись дерева для скринридера. */
  label: string;
  selectedId?: string;
  onSelect?: (id: string) => void;
  /** Управляемое раскрытие. Без него состояние внутреннее. */
  expandedIds?: readonly string[];
  onToggle?: (id: string, expanded: boolean) => void;
  defaultExpandedIds?: readonly string[];
  /**
   * Дополнительные атрибуты на строку узла.
   *
   * Через этот шов приложение вешает долгое нажатие: BEHAVIOR §3 открывает
   * меню папки и тега именно им, а таймер жеста живёт в `@zapiski/app`
   * (`useLongPress`), куда дизайн-системе ходить нельзя — зависимость идёт в
   * обратную сторону. Дублировать жест здесь значило бы завести вторую
   * реализацию с собственным сроком удержания.
   *
   * Собственные `onClick` и `onKeyDown` дерева заданы ПОСЛЕ распаковки и
   * поэтому не перебиваются: выбор узла и стрелки остаются за деревом.
   */
  nodeProps?: (id: string) => Partial<ButtonHTMLAttributes<HTMLButtonElement>>;
  className?: string;
}

/** Дерево папок/тегов: отступ 14 px на уровень, шеврон 13 поворачивается 200 мс. */
export function Tree({
  nodes,
  label,
  selectedId,
  onSelect,
  expandedIds,
  onToggle,
  defaultExpandedIds = [],
  nodeProps,
  className,
}: TreeProps): ReactNode {
  const [internal, setInternal] = useState<Set<string>>(() => new Set(defaultExpandedIds));
  const expanded = expandedIds ? new Set(expandedIds) : internal;

  const toggle = (id: string): void => {
    const next = !expanded.has(id);
    if (!expandedIds) {
      setInternal((prev) => {
        const copy = new Set(prev);
        if (next) copy.add(id);
        else copy.delete(id);
        return copy;
      });
    }
    onToggle?.(id, next);
  };

  const renderNodes = (items: readonly TreeNode[], level: number): ReactNode =>
    items.map((node) => {
      const hasChildren = Boolean(node.children && node.children.length > 0);
      const isOpen = hasChildren && expanded.has(node.id);
      const isSelected = node.id === selectedId;
      return (
        <div className="z-tree__group" key={node.id} role="none">
          <button
            {...nodeProps?.(node.id)}
            type="button"
            role="treeitem"
            aria-level={level + 1}
            aria-expanded={hasChildren ? isOpen : undefined}
            aria-selected={node.disabled ? undefined : isSelected}
            aria-disabled={node.disabled || undefined}
            className={cx(
              'z-tree__item',
              isSelected && !node.disabled && 'z-tree__item--selected',
              node.muted && 'z-tree__item--muted',
              node.disabled && 'z-tree__item--disabled',
            )}
            style={{ '--z-tree-level': level } as CSSProperties}
            onClick={(event) => {
              /*
                Шеврон раскрывает узел и НИЧЕГО больше.

                Прежде вся строка делала два дела разом: раскрывала папку и
                выбирала её. На телефоне это означало, что подпапку нельзя
                открыть вообще: выбор папки закрывает библиотеку (ящик уезжает,
                показывается список её заметок), и раскрытые дети исчезали
                вместе с ним — увидеть их было негде. Заказчик: «подпапки не
                открываются по тапу».

                Теперь у жеста два места: шеврон — раскрыть или свернуть,
                остальная строка — открыть папку. Строка при этом ещё и
                раскрывает узел, но не сворачивает: выбирая папку, человек
                просит показать её содержимое, а не спрятать.
              */
              if (
                hasChildren &&
                event.target instanceof Element &&
                event.target.closest('.z-tree__chevron') !== null
              ) {
                toggle(node.id);
                return;
              }
              if (hasChildren && !isOpen) toggle(node.id);
              /* Раскрытие срабатывает даже для disabled — только выбор гасится:
                 запрещённая для выбора папка (например, текущее место
                 переносимого объекта) остаётся доступна для просмотра детей. */
              if (node.disabled) return;
              onSelect?.(node.id);
            }}
            onKeyDown={(event) => {
              if (!hasChildren) return;
              if (event.key === 'ArrowRight' && !isOpen) {
                event.preventDefault();
                toggle(node.id);
              } else if (event.key === 'ArrowLeft' && isOpen) {
                event.preventDefault();
                toggle(node.id);
              }
            }}
          >
            <span
              className={cx('z-tree__chevron', isOpen && 'z-tree__chevron--open')}
              aria-hidden="true"
            >
              {hasChildren ? <IconChevronRight size={13} /> : null}
            </span>
            {node.icon ? <span className="z-tree__icon">{node.icon}</span> : null}
            <span className="z-tree__label">{node.label}</span>
            {node.count !== undefined ? <span className="z-tree__count">{node.count}</span> : null}
          </button>
          {isOpen && node.children ? (
            <div role="group">{renderNodes(node.children, level + 1)}</div>
          ) : null}
        </div>
      );
    });

  return (
    <div className={cx('z-tree', className)} role="tree" aria-label={label}>
      {renderNodes(nodes, 0)}
    </div>
  );
}
