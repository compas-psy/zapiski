/**
 * Библиотека — SCREENS §5, BEHAVIOR §3.
 *
 * Разделы «Все заметки» / «Закреплённые», деревья папок и тегов со счётчиками
 * (моно, без бейджей-кружков), внизу за разделителем — «Архив» и «Корзина».
 */
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { isMarkdownFile, type FolderNode, type VaultPath } from '@zapiski/core';
import {
  Button,
  IconFolder,
  IconHash,
  IconPin,
  IconTrash,
  ServiceMark,
  Tree,
  type TreeNode,
} from '@zapiski/ui';
import { IconArchive, IconFeedback, IconHelp, IconSettings } from '../components/icons.js';
import { useLongPress } from '../lib/gestures.js';
import { useApp, useAppState, useLayout, useStrings } from '../state/context.js';
import { Section, TreeSkeleton } from '../components/ScreenStates.js';
import { ContextMenu } from '../components/ContextMenu.js';
import {
  flattenFolders,
  FolderDeleteSheet,
  FolderNameDialog,
  FolderPickerDialog,
} from '../components/FolderDialogs.js';
import { SyncIndicator } from '../components/SyncIndicator.js';

/**
 * Чем помечена заметка, которую тащат.
 *
 * Свой тип, а не `text/plain`: чужие обработчики — вставка файла в редактор,
 * поле ввода — не должны принимать нашу строку за текст или файл.
 */
export const NOTE_DRAG_TYPE = 'application/x-zapiski-note';

/**
 * Чем помечена папка, которую тащат.
 *
 * Отдельный тип от заметки: цели у них разные. Заметку принимает и папка, и
 * корень; папку нельзя уронить в саму себя и в собственную подпапку, и решать
 * это надо ещё до броска — пока указатель летит над деревом.
 */
export const FOLDER_DRAG_TYPE = 'application/x-zapiski-folder';

/**
 * Можно ли уронить папку `from` в папку `to`.
 *
 * Три отказа, и каждый — не формальность:
 *   · сама в себя — бессмыслица;
 *   · в свою же подпапку — ветка уехала бы внутрь себя, и путь потерялся бы;
 *   · в собственного родителя — она уже там, перенос ничего не изменит.
 *
 * Проверяется ЗАРАНЕЕ, чтобы такая цель не подсвечивалась вовсе: подсветка —
 * обещание, что бросок сработает.
 */
export function canDropFolder(from: string | null, to: string): boolean {
  if (from === null || from === '') return false;
  if (to === from || to.startsWith(`${from}/`)) return false;
  const slash = from.lastIndexOf('/');
  return (slash === -1 ? '' : from.slice(0, slash)) !== to;
}

export function LibraryPanel(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const layout = useLayout();
  const isMobile = layout === 'mobile' || layout === 'compact';
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [tagMenu, setTagMenu] = useState<string | null>(null);
  /** Куда создаём папку: путь родителя. `null` — диалог закрыт. */
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  /** Какую папку переименовываем. `null` — диалог закрыт. */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Какую папку удаляем. `null` — лист закрыт. */
  const [deleting, setDeleting] = useState<string | null>(null);
  /** Какую папку переносим. `null` — диалог закрыт. */
  const [moving, setMoving] = useState<string | null>(null);
  /** Какой тег переименовываем. `null` — диалог закрыт. */
  const [renamingTag, setRenamingTag] = useState<string | null>(null);

  /**
   * Долгое нажатие по узлу дерева — единственный путь к меню папки и тега
   * (BEHAVIOR §3: «Long-press — меню: Новая подпапка · Переименовать ·
   * Переместить · Удалить»).
   *
   * Без этих строк меню существовало, но открыть его было НЕЧЕМ: `setFolderMenu`
   * и `setTagMenu` вызывались только с `null` из `onClose`. Три пункта меню
   * папки и переименование тега были недостижимы из интерфейса — тот самый
   * класс «код есть, кнопки нет», за который заказчик уже спрашивал.
   *
   * Идентификатор узла запоминается на нажатии: `useLongPress` — хук, звать его
   * в цикле по узлам нельзя, поэтому обработчик один на всё дерево, а узел он
   * узнаёт из ссылки, выставленной в момент касания.
   */
  const haptic = app.host.platform.haptics
    ? app.host.platform.haptics.impact.bind(app.host.platform.haptics)
    : undefined;
  /** Папка под указателем при переносе — она подсвечивается. */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** Папка, которую сейчас тащат: во время `dragover` данных переноса не видно. */
  const [dragging, setDragging] = useState<string | null>(null);
  const pressedFolder = useRef<string | null>(null);
  const pressedTag = useRef<string | null>(null);
  /** Пути служебных папок вложений — их создаёт приложение. */
  const systemFolders = useMemo(
    () => new Set(state.folders.filter((node) => node.system).map((node) => node.path)),
    [state.folders],
  );
  /*
    Меню папки вложений не открывается вовсе. «Переименовать» и «Переместить»
    там означали бы разрыв: новые файлы всё равно лягут в `Images`, а ссылки в
    заметках указывают на прежний путь. Спрятать такую папку можно настройкой —
    это обратимо и ничего не ломает.
  */
  const openFolderMenu = useCallback(() => {
    const path = pressedFolder.current;
    if (path === null || systemFolders.has(path)) return;
    setFolderMenu(path);
  }, [systemFolders]);
  const openTagMenu = useCallback(() => setTagMenu(pressedTag.current), []);
  const folderPress = useLongPress(openFolderMenu, haptic);
  const tagPress = useLongPress(openTagMenu, haptic);

  const nodePropsFor = (
    remember: typeof pressedFolder,
    press: typeof folderPress,
  ): ((id: string) => Record<string, unknown>) => (id) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      remember.current = id;
      press.onPointerDown(event);
    },
    onPointerUp: press.onPointerUp,
    onPointerLeave: press.onPointerLeave,
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      remember.current = id;
      press.onContextMenu(event);
    },
  });

  /**
   * Что именно летит над папкой — и примет ли она это.
   *
   * Во время `dragover` содержимое переноса прочитать нельзя: браузер отдаёт
   * только СПИСОК ТИПОВ, сами данные появятся в `drop`. Поэтому путь тащимой
   * папки живёт в состоянии (`dragging`) — без него нельзя решить, что цель
   * недопустима, и подсветка обещала бы перенос, которого не будет.
   */
  const dropKind = (
    event: ReactDragEvent<HTMLElement>,
    folder: string,
  ): 'note' | 'folder' | 'files' | null => {
    const types = event.dataTransfer.types;
    if (types.includes(NOTE_DRAG_TYPE)) return 'note';
    if (types.includes(FOLDER_DRAG_TYPE)) return canDropFolder(dragging, folder) ? 'folder' : null;
    if (types.includes('Files')) return 'files';
    return null;
  };

  /**
   * Файлы, брошенные на папку: заметки ложатся в неё и открываются.
   *
   * Заказчик: «Если перетаскиваю, наводя на конкретную папку в меню, то записка
   * копируется в неё и сразу открывается в редакторе, а фокус в меню переходит
   * на папку, куда перетащен документ». Порядок здесь ровно этот: сначала
   * фокус на папку, потом открытие заметки, — иначе список успевает показать
   * прежнюю папку поверх только что открытой заметки.
   */
  const dropFilesInto = async (files: File[], folder: string): Promise<void> => {
    const notes = files.filter((file) => isMarkdownFile(file.name));
    if (notes.length === 0) {
      app.toast({ message: strings.library.droppedNotNotes });
      return;
    }
    const paths = await app.importDroppedNotes(notes, folder);
    app.openFolder(folder);
    const first = paths[0];
    if (first !== undefined) app.openNote(first);
  };

  /**
   * Папка принимает то, что на неё тащат: заметку, другую папку или файл.
   *
   * Заказчик: «я не могу перетягивать записки в папки», позже — «я в меню
   * „взял“ мышкой папку и перетянул в другую папку → должно подсвечиваться,
   * куда сейчас перетягиваю + папка физически перемещается».
   *
   * `preventDefault` в `dragover` — не формальность: без него браузер считает,
   * что бросать сюда нельзя, и `drop` не приходит вовсе. Подсветка цели
   * держится в состоянии, а не классом на событии: иначе она остаётся гореть
   * на папке, из которой указатель ушёл боком.
   */
  const dropPropsFor = (folder: string): Record<string, unknown> => ({
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      const kind = dropKind(event, folder);
      if (kind === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = kind === 'files' ? 'copy' : 'move';
      if (dropTarget !== folder) setDropTarget(folder);
    },
    onDragLeave: () => setDropTarget((current) => (current === folder ? null : current)),
    /*
     * В `drop` решаем по САМИМ ДАННЫМ, а не по списку типов: здесь они уже
     * доступны, и запомненный путь тащимой папки для решения больше не нужен —
     * он приходит в переносе. Список типов остаётся только там, где иначе
     * нельзя, — в `dragover`.
     */
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      setDropTarget(null);
      setDragging(null);
      const note = event.dataTransfer.getData(NOTE_DRAG_TYPE);
      if (note) {
        event.preventDefault();
        void app.move(note as VaultPath, folder);
        return;
      }
      const dragged = event.dataTransfer.getData(FOLDER_DRAG_TYPE);
      if (dragged) {
        if (!canDropFolder(dragged, folder)) return;
        event.preventDefault();
        void app.moveFolder(dragged, folder);
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;
      event.preventDefault();
      void dropFilesInto(files, folder);
    },
    'data-drop-target': dropTarget === folder ? 'true' : undefined,
  });

  /**
   * Папку можно взять мышью. На телефоне — нет: там у строки уже есть долгое
   * нажатие (меню папки), и перетаскивание отобрало бы его себе.
   */
  const dragPropsFor = (folder: string): Record<string, unknown> => ({
    draggable: true,
    onDragStart: (event: ReactDragEvent<HTMLElement>) => {
      event.dataTransfer.setData(FOLDER_DRAG_TYPE, folder);
      event.dataTransfer.effectAllowed = 'move';
      setDragging(folder);
    },
    /* Бросок мимо цели — тоже конец переноса: без этого подсветка и
       запомненный путь остались бы висеть до следующего переноса. */
    onDragEnd: () => {
      setDragging(null);
      setDropTarget(null);
    },
  });

  const screenState = app.screenState('library', state.folders.length === 0);

  /*
    Служебные папки вложений можно спрятать (заказчик: «должно быть можно
    скрыть»). Прячется только показ в дереве: файлы остаются на месте, вложения
    в заметках продолжают открываться, папки видны в файловом менеджере.
  */
  const showAttachmentFolders = app.attachmentFoldersShownValue();
  const folderNodes = useMemo(
    () =>
      state.folders
        .filter((node) => showAttachmentFolders || !node.system)
        .map(toTreeNode),
    [state.folders, showAttachmentFolders],
  );
  const folderPaths = useMemo(() => flattenFolders(state.folders), [state.folders]);
  const tagNodes = useMemo(() => buildTagTree(state.tags), [state.tags]);

  const activeNotes = state.notes.filter((note) => !note.archived);
  const pinnedCount = activeNotes.filter((note) => note.pinned).length;

  return (
    <div className="za-library">
      <div className="za-library__head">
        {/* Знак сервиса в шапке — одно из четырёх мест, где терракота
            допустима внутри продукта (DS-ALIGNMENT §9). */}
        <span className="za-brand">
          <ServiceMark size={22} />
          <span className="za-wordmark">{strings.app.wordmark}</span>
        </span>
        <SyncIndicator />
      </div>

      <div className="za-nav">
        <button
          type="button"
          className={`za-nav__item${state.scope === 'all' && !state.folder && !state.tag ? ' za-nav__item--active' : ''}`}
          onClick={() => {
            app.setScope('all');
            app.navigate({ name: 'list' });
          }}
          /* «Все заметки» — это корень хранилища, и он тоже принимает
             перенос: иначе заметку, положенную в папку, нельзя вернуть
             обратно перетаскиванием. */
          {...dropPropsFor('')}
        >
          {strings.library.all}
          {/* REBUILD §1.12: ноль не отображается вовсе — ни в навигации, ни в
              бейджах. Он печатался наравне с числами и притягивал внимание к
              пустоте. Место счётчика просто остаётся пустым. */}
          {activeNotes.length > 0 ? (
            <span className="za-nav__count">{activeNotes.length}</span>
          ) : null}
        </button>
        <button
          type="button"
          className={`za-nav__item${state.scope === 'pinned' ? ' za-nav__item--active' : ''}`}
          onClick={() => {
            app.setScope('pinned');
            app.navigate({ name: 'list' });
          }}
        >
          <IconPin size={15} />
          {strings.library.pinned}
          {pinnedCount > 0 ? <span className="za-nav__count">{pinnedCount}</span> : null}
        </button>
      </div>

      {screenState === 'loading' ? (
        <TreeSkeleton />
      ) : screenState === 'empty' && tagNodes.length === 0 ? (
        /*
          REBUILD §1.3: навигация — не контент, и права показывать иллюстрацию
          и CTA у неё нет. Здесь стояло полноценное пустое состояние: круг,
          заголовок и две кнопки. Теперь одна строка и обычный пункт списка
          с «+» — в общем ритме, не отдельной кнопкой.

          Пункт «Новая папка» остаётся: без него первую папку создать нечем
          вообще, меню открывается долгим нажатием НА ПАПКУ.
        */
        <>
          <p className="za-nav__hint">{strings.library.emptyFolders}</p>
          <div className="za-nav">
            <button
              type="button"
              className="za-nav__item za-nav__item--action"
              onClick={() => setCreatingIn('')}
            >
              <span aria-hidden="true">+</span>
              {strings.library.newFolder}
            </button>
          </div>
        </>
      ) : (
        <>
          {folderNodes.length > 0 ? (
            <>
              <Section>{strings.library.folders}</Section>
              <Tree
                nodes={folderNodes}
                label={strings.library.folders}
                selectedId={state.folder ?? undefined}
                /* Раскрытие держит контроллер: на телефоне выбор папки
                   закрывает ящик, а с ним размонтируется и дерево — своё
                   состояние оно бы потеряло, и подпапка исчезала бы сразу
                   после того, как её раскрыли. */
                expandedIds={state.expandedFolders}
                onToggle={(id, expanded) => app.toggleFolderExpanded(id, expanded)}
                onSelect={(id) => app.openFolder(id)}
                nodeProps={(id) => ({
                  ...nodePropsFor(pressedFolder, folderPress)(id),
                  /* Папку вложений не тащат и не принимают: её создаёт
                     приложение, новые файлы всё равно лягут в `Images`, а
                     заметка внутри потерялась бы среди вложений. */
                  ...(systemFolders.has(id) ? {} : dropPropsFor(id)),
                  ...(systemFolders.has(id) || isMobile ? {} : dragPropsFor(id)),
                })}
              />
              {/*
                «Новая папка» — обычный пункт списка с «+», в общем ритме
                навигации (REBUILD §1.3, ITERATION-1 §9). Была текстовой
                кнопкой акцентом справа от заголовка секции и читалась как
                активный пункт: единственное цветное пятно в столбце серых
                строк притягивает глаз сильнее, чем выбранная папка.
              */}
              <div className="za-nav">
                <button
                  type="button"
                  className="za-nav__item za-nav__item--action"
                  onClick={() => setCreatingIn('')}
                >
                  <span aria-hidden="true">+</span>
                  {strings.library.newFolder}
                </button>
              </div>
            </>
          ) : null}

          {tagNodes.length > 0 ? (
            <>
              <Section>{strings.library.tags}</Section>
              <Tree
                nodes={tagNodes}
                label={strings.library.tags}
                selectedId={state.tag ?? undefined}
                onSelect={(id) => app.openTag(id)}
                nodeProps={nodePropsFor(pressedTag, tagPress)}
              />
            </>
          ) : null}
        </>
      )}

      <div className="za-library__footer">
        <div className="za-nav">
          <button
            type="button"
            className="za-nav__item"
            onClick={() => app.navigate({ name: 'archive' })}
          >
            <IconArchive size={15} />
            {strings.library.archive}
          </button>
          <button
            type="button"
            className="za-nav__item"
            onClick={() => app.navigate({ name: 'trash' })}
          >
            <IconTrash size={15} />
            {strings.library.trash}
            {/* Пустая корзина счётчик не показывает (BEHAVIOR §3). */}
            {state.trash.length > 0 ? (
              <span className="za-nav__count">{state.trash.length}</span>
            ) : null}
          </button>
          {/*
            Настройки. До этой строки экран настроек был недостижим НА ТЕЛЕФОНЕ
            ВООБЩЕ: попасть в него можно было только по Ctrl+, или через палитру
            команд (Ctrl+K) — то есть с клавиатуры, которой на Android нет.
            За ним заперты выбор темы и акцента, шрифт, шифрование, синк и
            хранилище. Отсюда и «нельзя сменить темы», и «почти никакой
            функционал не работает».
          */}
          <button
            type="button"
            className="za-nav__item"
            onClick={() => app.openSettings()}
          >
            <IconSettings size={15} />
            {strings.settings.title}
          </button>
          {/* Справка — рядом с настройками и по той же причине: на телефоне
              это единственная дорога к ней, клавиатуры с Ctrl+K там нет. */}
          <button
            type="button"
            className="za-nav__item"
            onClick={() => app.navigate({ name: 'help' })}
          >
            <IconHelp size={15} />
            {strings.help.open}
          </button>
          {/*
            Обратная связь — здесь, а не только в «Настройках → О приложении».

            На альфа-тестировании с живыми людьми путь в три касания сквозь
            настройки означает, что напишут единицы: человек, у которого что-то
            не получилось, закрывает приложение, а не идёт искать раздел. А
            контекстная полоса появляется только после сбоя и не чаще раза в
            сутки — то есть тому, кому есть что сказать прямо сейчас, ждать
            нечего.

            Последней в списке намеренно: это не частое действие, и уводить
            внимание от «Настроек» ему незачем.
          */}
          <button
            type="button"
            className="za-nav__item"
            onClick={() => app.openFeedback('menu')}
          >
            <IconFeedback size={15} />
            {strings.feedback.open}
          </button>
        </div>
      </div>

      <ContextMenu
        open={folderMenu !== null}
        onClose={() => setFolderMenu(null)}
        title={folderMenu ?? ''}
        items={[
          {
            id: 'new',
            label: strings.library.newSubfolder,
            onSelect: () => setCreatingIn(folderMenu ?? ''),
          },
          { id: 'rename', label: strings.library.rename, onSelect: () => setRenaming(folderMenu) },
          { id: 'move', label: strings.library.moveFolder, onSelect: () => setMoving(folderMenu) },
          { id: 'delete', label: strings.library.deleteFolder, onSelect: () => setDeleting(folderMenu) },
        ]}
      />
      <FolderNameDialog
        open={creatingIn !== null}
        initial=""
        placeholder={strings.library.folderNameHint}
        title={creatingIn ? strings.library.newSubfolder : strings.library.newFolder}
        confirmLabel={strings.library.create}
        onConfirm={(name) => void app.createFolder(creatingIn ?? '', name)}
        onClose={() => setCreatingIn(null)}
      />

      <FolderNameDialog
        open={renaming !== null}
        initial={renaming ? (renaming.split('/').pop() ?? '') : ''}
        title={strings.library.rename}
        confirmLabel={strings.library.rename}
        onConfirm={(name) => void app.renameFolder(renaming ?? '', name)}
        onClose={() => setRenaming(null)}
      />

      <FolderNameDialog
        open={renamingTag !== null}
        initial={renamingTag ?? ''}
        title={strings.library.rename}
        confirmLabel={strings.library.rename}
        onConfirm={(name) => void app.renameTag(renamingTag ?? '', name)}
        onClose={() => setRenamingTag(null)}
      />

      <FolderPickerDialog
        open={moving !== null}
        source={moving ?? ''}
        current={
          moving && moving.includes('/') ? moving.slice(0, moving.lastIndexOf('/')) : ''
        }
        folders={folderPaths}
        onPick={(parent) => void app.moveFolder(moving ?? '', parent)}
        onClose={() => setMoving(null)}
      />

      <FolderDeleteSheet
        open={deleting !== null}
        name={deleting ? (deleting.split('/').pop() ?? '') : ''}
        count={
          deleting
            ? state.notes.filter((note) => note.path.startsWith(`${deleting}/`)).length
            : 0
        }
        onDelete={(mode) => void app.deleteFolder(deleting ?? '', mode)}
        onClose={() => setDeleting(null)}
      />

      <ContextMenu
        open={tagMenu !== null}
        onClose={() => setTagMenu(null)}
        title={tagMenu ? `#${tagMenu}` : ''}
        items={[
          { id: 'rename', label: strings.library.rename, onSelect: () => setRenamingTag(tagMenu) },
        ]}
      />
    </div>
  );
}

function toTreeNode(node: FolderNode): TreeNode {
  return {
    id: node.path,
    label: node.name,
    icon: <IconFolder size={15} />,
    // REBUILD §1.12: ноль не отображается вовсе.
    count: node.count > 0 ? node.count : undefined,
    /* Папку вложений создало приложение — она читается вторым планом
       (заказчик: «так как это "системные" папки — они должны быть серыми»). */
    ...(node.system ? { muted: true } : {}),
    ...(node.children.length > 0 ? { children: node.children.map(toTreeNode) } : {}),
  };
}

/** Вложенные теги (`практика/супервизия`) показываются деревом (SCREENS §5). */
function buildTagTree(tags: ReadonlyArray<{ tag: string; count: number }>): TreeNode[] {
  interface Draft {
    id: string;
    label: string;
    count: number;
    children: Map<string, Draft>;
  }
  const roots = new Map<string, Draft>();

  for (const { tag, count } of tags) {
    const parts = tag.split('/');
    let level = roots;
    let prefix = '';
    for (const part of parts) {
      prefix = prefix === '' ? part : `${prefix}/${part}`;
      let node = level.get(part);
      if (!node) {
        node = { id: prefix, label: part, count: 0, children: new Map() };
        level.set(part, node);
      }
      node.count += count;
      level = node.children;
    }
  }

  const materialize = (draft: Draft): TreeNode => ({
    id: draft.id,
    label: `#${draft.label}`,
    icon: <IconHash size={15} />,
    ...(draft.count > 0 ? { count: draft.count } : {}),
    ...(draft.children.size > 0
      ? { children: [...draft.children.values()].map(materialize) }
      : {}),
  });

  return [...roots.values()].map(materialize);
}
