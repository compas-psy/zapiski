import { useState, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../../internal/cx';
import { IconChevronRight } from '../../icons';
import './Special.css';

export interface TreeNode {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  /** Счётчик — моно 11, без бейджей-кружков. */
  count?: ReactNode;
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
            type="button"
            role="treeitem"
            aria-level={level + 1}
            aria-expanded={hasChildren ? isOpen : undefined}
            aria-selected={isSelected}
            className={cx('z-tree__item', isSelected && 'z-tree__item--selected')}
            style={{ '--z-tree-level': level } as CSSProperties}
            onClick={() => {
              if (hasChildren) toggle(node.id);
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
