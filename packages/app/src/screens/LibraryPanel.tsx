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
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { FolderNode } from '@zapiski/core';
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
import { IconArchive, IconSettings } from '../components/icons.js';
import { useLongPress } from '../lib/gestures.js';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { EmptyBlock, Section, TreeSkeleton } from '../components/ScreenStates.js';
import { ContextMenu } from '../components/ContextMenu.js';
import {
  flattenFolders,
  FolderDeleteSheet,
  FolderNameDialog,
  FolderPickerDialog,
} from '../components/FolderDialogs.js';
import { SyncIndicator } from '../components/SyncIndicator.js';

export function LibraryPanel(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
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
  const pressedFolder = useRef<string | null>(null);
  const pressedTag = useRef<string | null>(null);
  const openFolderMenu = useCallback(() => setFolderMenu(pressedFolder.current), []);
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

  const screenState = app.screenState('library', state.folders.length === 0);

  const folderNodes = useMemo(() => state.folders.map(toTreeNode), [state.folders]);
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
        <EmptyBlock
          title={strings.empty.library}
          icon={<IconFolder size={24} />}
          action={
            <>
              <Button onClick={() => void app.createNote()}>{strings.list.newNote}</Button>
              {/* Без этой кнопки первую папку создать было НЕЧЕМ: меню папки
                  открывается долгим нажатием на папку, а папок ещё нет. */}
              <Button variant="secondary" onClick={() => setCreatingIn('')}>
                {strings.library.newFolder}
              </Button>
            </>
          }
        />
      ) : (
        <>
          {folderNodes.length > 0 ? (
            <>
              <div className="za-row-between">
                <Section>{strings.library.folders}</Section>
                <Button variant="text" onClick={() => setCreatingIn('')}>
                  {strings.library.newFolder}
                </Button>
              </div>
              <Tree
                nodes={folderNodes}
                label={strings.library.folders}
                selectedId={state.folder ?? undefined}
                onSelect={(id) => app.openFolder(id)}
                nodeProps={nodePropsFor(pressedFolder, folderPress)}
              />
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
        initial={strings.library.folderNameDefault}
        title={creatingIn ? strings.library.newSubfolder : strings.library.newFolder}
        confirmLabel={strings.library.newFolder}
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
