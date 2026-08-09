/**
 * Библиотека — SCREENS §5, BEHAVIOR §3.
 *
 * Разделы «Все заметки» / «Закреплённые», деревья папок и тегов со счётчиками
 * (моно, без бейджей-кружков), внизу за разделителем — «Архив» и «Корзина».
 */
import { useMemo, useState, type ReactNode } from 'react';
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
import { IconArchive } from '../components/icons.js';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { EmptyBlock, Section, TreeSkeleton } from '../components/ScreenStates.js';
import { ContextMenu } from '../components/ContextMenu.js';
import { SyncIndicator } from '../components/SyncIndicator.js';

export function LibraryPanel(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [tagMenu, setTagMenu] = useState<string | null>(null);

  const screenState = app.screenState('library', state.folders.length === 0);

  const folderNodes = useMemo(() => state.folders.map(toTreeNode), [state.folders]);
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
          <span className="za-nav__count">{activeNotes.length}</span>
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
          <span className="za-nav__count">{pinnedCount}</span>
        </button>
      </div>

      {screenState === 'loading' ? (
        <TreeSkeleton />
      ) : screenState === 'empty' && tagNodes.length === 0 ? (
        <EmptyBlock
          title={strings.empty.library}
          icon={<IconFolder size={24} />}
          action={<Button onClick={() => void app.createNote()}>{strings.list.newNote}</Button>}
        />
      ) : (
        <>
          {folderNodes.length > 0 ? (
            <>
              <Section>{strings.library.folders}</Section>
              <Tree
                nodes={folderNodes}
                label={strings.library.folders}
                selectedId={state.folder ?? undefined}
                onSelect={(id) => app.openFolder(id)}
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
        </div>
      </div>

      <ContextMenu
        open={folderMenu !== null}
        onClose={() => setFolderMenu(null)}
        title={folderMenu ?? ''}
        items={[
          { id: 'new', label: strings.library.newSubfolder, onSelect: () => void app.createNote(folderMenu ?? undefined) },
          { id: 'rename', label: strings.library.rename, onSelect: () => undefined },
        ]}
      />
      <ContextMenu
        open={tagMenu !== null}
        onClose={() => setTagMenu(null)}
        title={tagMenu ? `#${tagMenu}` : ''}
        items={[{ id: 'rename', label: strings.library.rename, onSelect: () => undefined }]}
      />
    </div>
  );
}

function toTreeNode(node: FolderNode): TreeNode {
  return {
    id: node.path,
    label: node.name,
    icon: <IconFolder size={15} />,
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
    count: draft.count,
    ...(draft.children.size > 0
      ? { children: [...draft.children.values()].map(materialize) }
      : {}),
  });

  return [...roots.values()].map(materialize);
}
