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
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { FolderNode } from '@zapiski/core';
import { Button, IconFolder, Modal, TextField, Tree, type TreeNode } from '@zapiski/ui';
import { useStrings } from '../state/context.js';
import type { Strings } from '../i18n/index.js';

/**
 * Плоский список путей всех папок — для выбора получателя при переносе.
 * Лежит здесь, а не в экране: получателя выбирают и для папки, и для заметки.
 *
 * Служебные папки вложений (`Images`, `Audio`, `Other files`) в список не
 * попадают: они для файлов, а не для заметок, и предлагать их как место для
 * заметки значит предлагать заведомо неудачный выбор.
 */
export function flattenFolders(nodes: readonly FolderNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly FolderNode[]): void => {
    for (const node of list) {
      if (node.system) continue;
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
  /** Подсказка в пустом поле. */
  placeholder?: string;
  title: string;
  confirmLabel: string;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export function FolderNameDialog({
  open,
  initial,
  placeholder,
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
        /* REBUILD §1.4: видимой подписи над полем нет — при одном поле она
           только повторяет заголовок. Для скринридера имя остаётся. */
        aria-label={strings.library.folderNamePrompt}
        {...(placeholder ? { placeholder } : {})}
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

/**
 * Значение `current` для объекта, у которого места в хранилище ЕЩЁ нет
 * (файл ассоциации `.md`, «Открыть с помощью», «Поделиться»).
 *
 * Пустая строка как `current` означает «объект уже в корне», и ровно поэтому
 * прячет кнопку «В корень» — переносить в корень уже лежащий там объект
 * нечего предлагать. У входящего файла корня-по-умолчанию нет вовсе: корень
 * для него такой же выбор, как любая папка, и на пустом хранилище без единой
 * папки это вообще единственный выбор. Значение нарочно не пустая строка и не
 * реальный путь — ни с чем в списке не совпадёт.
 */
export const NO_CURRENT_LOCATION = '\u0000';

/**
 * Дерево доступных папок-получателей — чистая функция (BEHAVIOR MVP §19).
 *
 * Два правила, в порядке применения:
 *  - системные папки вложений (`Images`, `Audio`, `Other files`) не место
 *    для заметок — исключаются всегда, независимо от `source`/`current`;
 *  - перемещаемая ПАПКА (`source`) и всё её поддерево исключаются целиком:
 *    положить папку внутрь себя — отрезать её от хранилища.
 *
 * Текущее место объекта (`current`) в дереве ОСТАЁТСЯ — просто не как выбор:
 * `toPickerTree` ниже помечает этот единственный узел `disabled`. Первая
 * редакция вместо этого убирала узел `current` и поднимала его детей на его
 * место — и ровно этим ломала структуру: подпапка «Архив» внутри «Работы»
 * поднималась в корень и переставала отличаться от точно такой же «Архив» из
 * «Личного», хотя пользователь их прекрасно различал по вложенности до
 * переноса. Сохранение узла — единственный способ остаться структурным:
 * дети видны там же, где были, и подписаны тем же родителем.
 *
 * `source` пустой строкой значит «заметка», а не папка: у заметки нет
 * собственного поддерева, которое надо было бы исключать.
 */
export function buildFolderDestinationTree(
  nodes: readonly FolderNode[],
  options: { source?: string; current: string },
): FolderNode[] {
  const source = options.source ?? '';
  const isSourceOrDescendant = (path: string): boolean =>
    source !== '' && (path === source || path.startsWith(`${source}/`));

  const walk = (list: readonly FolderNode[]): FolderNode[] => {
    const out: FolderNode[] = [];
    for (const node of list) {
      if (node.system) continue;
      if (isSourceOrDescendant(node.path)) continue;
      const children = walk(node.children);
      out.push(children === node.children ? node : { ...node, children });
    }
    return out;
  };

  return walk(nodes);
}

/**
 * `FolderNode[]` → `TreeNode[]` для показа: текущее место объекта помечается
 * `disabled` (видно, раскрывается, не выбирается) и получает суффикс в
 * подписи — иначе строка, на которую нажатие ничего не делает, выглядит как
 * молчаливая поломка, а не как обозначенная граница.
 */
function toPickerTree(nodes: readonly FolderNode[], current: string, strings: Strings): TreeNode[] {
  const convert = (node: FolderNode): TreeNode => {
    const isCurrent = node.path === current;
    return {
      id: node.path,
      label: isCurrent ? `${node.name} · ${strings.library.currentLocationSuffix}` : node.name,
      icon: <IconFolder size={15} />,
      ...(isCurrent ? { disabled: true } : {}),
      ...(node.children.length > 0 ? { children: node.children.map(convert) } : {}),
    };
  };
  return nodes.map(convert);
}

/** Все id узлов дерева, плоским списком — раскрыть дерево целиком по умолчанию. */
function allIds(nodes: readonly TreeNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    out.push(node.id);
    if (node.children) out.push(...allIds(node.children));
  }
  return out;
}

export interface FolderPickerDialogProps {
  open: boolean;
  /**
   * Перемещаемая ПАПКА: она сама и её поддерево из списка исключаются.
   * Для заметки — пустая строка: заметке любое поддерево подходит.
   */
  source?: string;
  /**
   * Где объект лежит сейчас — туда переносить некуда, пункта нет. Пустая
   * строка — корень. Для объекта без места в хранилище — `NO_CURRENT_LOCATION`.
   */
  current: string;
  /** Дерево папок хранилища — то же самое, что показывает Библиотека. */
  folders: readonly FolderNode[];
  /**
   * Заголовок диалога. По умолчанию — «Переместить»: у диалога один
   * заголовок на всех, кто просто переносит существующий объект. Файл,
   * пришедший извне (ассоциация `.md`, «Открыть с помощью», «Поделиться»),
   * ничего не переносит — он ещё не заметка, — и заголовок должен говорить
   * «куда сохранить», а не «куда переместить».
   */
  title?: string;
  onPick: (parent: string) => void;
  onClose: () => void;
}

/**
 * Выбор папки-получателя для «Переместить» (BEHAVIOR §3, MVP P0 §16-21).
 *
 * До этого компонента диалог получал `flattenFolders()` — плоский список
 * `readonly string[]` — и показывал каждый путь отдельной одинаковой большой
 * кнопкой: «Работа», «Работа/Клиенты», «Работа/Клиенты/Иван» в одну ленту.
 * Заказчик увидел в этом «максимально уродливый и неструктурированный список
 * папок». Дерево здесь — тот же самый `@zapiski/ui` `Tree`, которым уже
 * рисует свои папки `LibraryPanel` (MVP §17: не заводить второй `FolderTree`),
 * поэтому раскрытие/схлопывание, `role=tree`/`treeitem`, клавиатура
 * (ArrowRight/ArrowLeft раскрывают/сворачивают, Enter/Space — родное поведение
 * кнопки) и «клик по названию выбирает, шеврон только раскрывает» достаются
 * бесплатно, а не переписываются заново.
 *
 * Себя и своё поддерево (при переносе папки) в дереве нет — см.
 * `buildFolderDestinationTree`. Раскрыто по умолчанию целиком: это диалог
 * выбора, а не постоянная панель навигации, и лишний клик по каждому шеврону
 * ради того, чтобы просто ОБНАРУЖИТЬ вложенную папку, был бы шагом назад
 * относительно прежнего плоского списка, где всё было видно сразу.
 */
export function FolderPickerDialog({
  open,
  source = '',
  current,
  folders,
  title,
  onPick,
  onClose,
}: FolderPickerDialogProps): ReactNode {
  const strings = useStrings();
  const nodes = useMemo(
    () => toPickerTree(buildFolderDestinationTree(folders, { source, current }), current, strings),
    [folders, source, current, strings],
  );
  const expandedIds = useMemo(() => allIds(nodes), [nodes]);
  const dialogTitle = title ?? strings.library.moveFolderTitle;

  const choose = (target: string): void => {
    onPick(target);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={dialogTitle}>
      {/* «В корень» не показывается, когда объект уже в корне. */}
      {current === '' ? null : (
        <Button variant="secondary" fullWidth onClick={() => choose('')}>
          {strings.library.moveToRoot}
        </Button>
      )}
      {nodes.length > 0 ? (
        <Tree
          nodes={nodes}
          label={dialogTitle}
          defaultExpandedIds={expandedIds}
          onSelect={choose}
        />
      ) : null}
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
