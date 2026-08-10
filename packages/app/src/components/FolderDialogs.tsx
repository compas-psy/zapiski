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
import type { FolderNode } from '@zapiski/core';
import { Button, Modal, TextField } from '@zapiski/ui';
import { useStrings } from '../state/context.js';

/**
 * Плоский список путей всех папок — для выбора получателя при переносе.
 * Лежит здесь, а не в экране: получателя выбирают и для папки, и для заметки.
 */
export function flattenFolders(nodes: readonly FolderNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly FolderNode[]): void => {
    for (const node of list) {
      out.push(node.path);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

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

export interface FolderPickerDialogProps {
  open: boolean;
  /**
   * Перемещаемая ПАПКА: она сама и её поддерево из списка исключаются.
   * Для заметки — пустая строка: заметке любое поддерево подходит.
   */
  source?: string;
  /** Где объект лежит сейчас — туда переносить некуда, пункта нет. */
  current: string;
  /** Плоский список путей всех папок хранилища. */
  folders: readonly string[];
  onPick: (parent: string) => void;
  onClose: () => void;
}

/**
 * Выбор папки-получателя для «Переместить» (BEHAVIOR §3).
 *
 * Список плоский, с полными путями: дерево внутри дерева читается хуже, а путь
 * снимает вопрос «которая из двух „Супервизии“».
 *
 * Себя и своё поддерево в списке нет: положить папку внутрь себя — значит
 * отрезать её от хранилища. Ядро такую попытку и так отклоняет, но показывать
 * заведомо нерабочий пункт нельзя — это обещание, которое не будет исполнено.
 */
export function FolderPickerDialog({
  open,
  source = '',
  current,
  folders,
  onPick,
  onClose,
}: FolderPickerDialogProps): ReactNode {
  const strings = useStrings();
  const targets = folders.filter(
    (path) =>
      path !== current &&
      (source === '' || (path !== source && !path.startsWith(`${source}/`))),
  );

  const choose = (target: string) => () => {
    onPick(target);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={strings.library.moveFolderTitle}>
      {/* «В корень» не показывается, когда объект уже в корне. */}
      {current === '' ? null : (
        <Button variant="secondary" fullWidth onClick={choose('')}>
          {strings.library.moveToRoot}
        </Button>
      )}
      {targets.map((path) => (
        <Button key={path} variant="secondary" fullWidth onClick={choose(path)}>
          {path}
        </Button>
      ))}
      <Button variant="text" fullWidth onClick={onClose}>
        {strings.app.cancel}
      </Button>
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
