/**
 * Диалоги папок: ввод имени и удаление.
 *
 * До этого файла требование BEHAVIOR про дерево папок существовало на экране в
 * виде надписей — «Новая подпапка» звала создание ЗАМЕТКИ, а «Переименовать»
 * имела пустой обработчик `() => undefined`. Пользователь на живом Windows это
 * и обнаружил: «Папки нельзя создать».
 *
 * Удаление папки намеренно НЕ диалог подтверждения (`ConfirmDialog`): там
 * человек подтверждает одно действие, а здесь выбирает между двумя, и оба
 * сохраняют текст. Список мест с подтверждением закрыт типом и расширению не
 * подлежит — BEHAVIOR §0.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Modal, TextField } from '@zapiski/ui';
import { useStrings } from '../state/context.js';

export interface FolderNameDialogProps {
  open: boolean;
  /** Начальное значение: пусто для создания, текущее имя для переименования. */
  initial: string;
  title: string;
  confirmLabel: string;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export function FolderNameDialog({
  open,
  initial,
  title,
  confirmLabel,
  onConfirm,
  onClose,
}: FolderNameDialogProps): ReactNode {
  const strings = useStrings();
  const [name, setName] = useState(initial);

  /* Каждое открытие начинается с чистого значения, иначе диалог покажет
     остаток от прошлого раза. */
  useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    onConfirm(trimmed);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <TextField
        /* Диалог с одним полем, в котором надо ещё раз щёлкнуть, раздражает. */
        autoFocus
        label={strings.library.folderNamePrompt}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          /* Enter — обычный способ закончить ввод в диалоге с одним полем. */
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="za-row-between">
        <Button variant="text" onClick={onClose}>
          {strings.app.cancel}
        </Button>
        <Button onClick={submit} disabled={name.trim() === ''}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export interface FolderDeleteSheetProps {
  open: boolean;
  /** Имя папки — для вопроса. */
  name: string;
  /** Сколько заметок внутри: от этого зависит, есть ли вообще выбор. */
  count: number;
  onDelete: (mode: 'notes-to-trash' | 'notes-to-parent') => void;
  onClose: () => void;
}

export function FolderDeleteSheet({
  open,
  name,
  count,
  onDelete,
  onClose,
}: FolderDeleteSheetProps): ReactNode {
  const strings = useStrings();
  const choose = (mode: 'notes-to-trash' | 'notes-to-parent') => () => {
    onDelete(mode);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={strings.library.deleteFolder}>
      <p className="za-muted">{strings.library.deleteFolderQuestion(name, count)}</p>
      {/* Пустую папку удалять «с заметками» не из чего — выбор был бы враньём. */}
      {count > 0 ? (
        <Button variant="secondary" fullWidth onClick={choose('notes-to-parent')}>
          {strings.library.deleteFolderOnly}
        </Button>
      ) : null}
      <Button variant="destructive" fullWidth onClick={choose('notes-to-trash')}>
        {count > 0 ? strings.library.deleteFolderWithNotes : strings.library.deleteFolder}
      </Button>
      <Button variant="text" fullWidth onClick={onClose}>
        {strings.app.cancel}
      </Button>
    </Modal>
  );
}
