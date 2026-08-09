/**
 * Контекстное меню long-press (BEHAVIOR §1.1) и меню «⋯» в шапках.
 * На mobile — bottom sheet, на desktop — модалка: обе формы уже есть в ui.
 */
import type { ReactNode } from 'react';
import { BottomSheet, Modal } from '@zapiski/ui';
import { useLayout, useStrings } from '../state/context.js';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  /** Пункт скрывается целиком, если возможности нет (ARCHITECTURE §2). */
  hidden?: boolean;
  onSelect: () => void;
}

export interface ContextMenuProps {
  open: boolean;
  onClose: () => void;
  title: string;
  items: readonly MenuItem[];
}

export function ContextMenu({ open, onClose, title, items }: ContextMenuProps): ReactNode {
  const layout = useLayout();
  const strings = useStrings();
  const visible = items.filter((item) => !item.hidden);

  const body = (
    <div className="za-menu" role="menu">
      {visible.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`za-menu__item${item.danger ? ' za-menu__item--danger' : ''}`}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );

  if (layout === 'mobile' || layout === 'compact') {
    return (
      <BottomSheet open={open} onClose={onClose} title={title}>
        {body}
      </BottomSheet>
    );
  }
  return (
    <Modal open={open} onClose={onClose} title={title} closeLabel={strings.app.close}>
      {body}
    </Modal>
  );
}
