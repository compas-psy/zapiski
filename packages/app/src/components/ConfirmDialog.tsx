/**
 * Диалог подтверждения.
 *
 * BEHAVIOR §0: разрешён РОВНО в трёх местах — очистка корзины, снятие
 * шифрования, отвязка облачного аккаунта. Тип `ConfirmReason` закрыт: четвёртое
 * место просто не скомпилируется. Всё остальное деструктивное — ОО-тост.
 *
 * Удаление папки из BEHAVIOR §3 диалогом не является: там пользователь выбирает
 * одно из двух действий, а не подтверждает одно — см. `FolderDeleteSheet`.
 */
import type { ReactNode } from 'react';
import { Button, Modal } from '@zapiski/ui';
import { useStrings } from '../state/context.js';

export type ConfirmReason = 'purge-trash' | 'remove-encryption' | 'unlink-account';

export interface ConfirmDialogProps {
  reason: ConfirmReason;
  open: boolean;
  title: string;
  question: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  question,
  confirmLabel,
  onConfirm,
  onClose,
}: ConfirmDialogProps): ReactNode {
  const strings = useStrings();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={strings.app.close}
      footer={
        <>
          <Button variant="text" onClick={onClose}>
            {strings.app.cancel}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="za-muted">{question}</p>
    </Modal>
  );
}
