/**
 * Share-target — SCREENS §10b (`4f`), BEHAVIOR §8.
 *
 * Bottom sheet поверх того, что было: превью содержимого, «Новая заметка»
 * выбрана по умолчанию, выбор папки, поиск существующей и две недавние.
 * После «Добавить» лист закрывается, приложение НЕ открывается на экране
 * заметки — только тост «Добавлено в „…“ · Открыть».
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SharedPayload, VaultPath } from '@zapiski/core';
import { BottomSheet, Button, Radio, SearchField } from '@zapiski/ui';
import { useApp, useAppState, useStrings } from '../state/context.js';

export interface ShareSheetProps {
  open: boolean;
  payload: SharedPayload | null;
  onClose: () => void;
}

/** Сколько недавних заметок предлагать (SCREENS §10b `4f` — две). */
const RECENT_TARGETS = 2;

export function ShareSheet({ open, payload, onClose }: ShareSheetProps): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const [target, setTarget] = useState<VaultPath | 'new'>('new');
  const [folder, setFolder] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setTarget('new');
      setQuery('');
      setBusy(false);
    }
  }, [open]);

  /** Текст, который ляжет в заметку. Ссылка — `[заголовок](url)`. */
  const text = useMemo(() => sharedText(payload), [payload]);

  const recent = useMemo(
    () =>
      state.lastOpened
        .map((path) => state.notes.find((note) => note.path === path))
        .filter((note): note is NonNullable<typeof note> => note !== undefined && !note.encrypted)
        .slice(0, RECENT_TARGETS),
    [state.lastOpened, state.notes],
  );

  const found = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (trimmed === '') return [];
    return state.notes
      .filter((note) => !note.encrypted && note.title.toLowerCase().includes(trimmed))
      .slice(0, 5);
  }, [query, state.notes]);

  return (
    <BottomSheet open={open} onClose={onClose} title={strings.share.title}>
      {/* Превью содержимого на `--surface`. */}
      <div className="za-card za-card--static">
        <span className="za-card__text">{text}</span>
      </div>

      <div className="za-stack za-stack--tight">
        <Radio
          name="share-target"
          label={strings.share.newNote}
          checked={target === 'new'}
          onChange={() => setTarget('new')}
        />
        {target === 'new' ? (
          <select
            className="za-select"
            aria-label={strings.share.folder}
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
          >
            <option value="">{strings.importer.targetRoot}</option>
            {state.folders.map((node) => (
              <option key={node.path} value={node.path}>
                {node.path}
              </option>
            ))}
          </select>
        ) : null}

        {recent.map((note) => (
          <Radio
            key={note.path}
            name="share-target"
            label={note.title || strings.notes.untitled}
            checked={target === note.path}
            onChange={() => setTarget(note.path)}
          />
        ))}

        <SearchField
          label={strings.share.existing}
          placeholder={strings.share.existing}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery('')}
          clearLabel={strings.app.close}
        />
        {found.map((note) => (
          <Radio
            key={note.path}
            name="share-target"
            label={note.title || strings.notes.untitled}
            checked={target === note.path}
            onChange={() => setTarget(note.path)}
          />
        ))}

        <Button fullWidth loading={busy} onClick={() => void add()}>
          {strings.share.add}
        </Button>
      </div>
    </BottomSheet>
  );

  async function add(): Promise<void> {
    setBusy(true);
    try {
      let path: VaultPath | null = null;
      let title = '';
      if (target === 'new') {
        const created = await app.vaultRef?.create({
          body: text,
          ...(folder ? { folder } : {}),
        });
        path = created?.path ?? null;
        title = created?.title ?? '';
      } else {
        const note = await app.readNote(target);
        if (note) {
          await app.save(target, `${note.body.replace(/\s+$/, '')}\n\n${text}\n`);
          path = target;
          title = note.title;
        }
      }
      await app.refresh();
      onClose();
      if (path === null) return;
      /* Приложение не открывается: только тост со ссылкой «Открыть». */
      const opened = path;
      app.toast({
        message: strings.share.added(title || strings.notes.untitled),
        actionLabel: strings.share.open,
        onAction: () => app.openNote(opened),
      });
    } finally {
      setBusy(false);
    }
  }
}

/**
 * Ссылка оборачивается в `[заголовок](url)`, если заголовок известен, иначе
 * остаётся голым url (BEHAVIOR §8 — ждать больше 2 с нельзя, поэтому получение
 * заголовка делает платформа и кладёт его в `text`).
 */
export function sharedText(payload: SharedPayload | null): string {
  if (!payload) return '';
  if (payload.kind === 'link' && payload.url) {
    return payload.text ? `[${payload.text}](${payload.url})` : payload.url;
  }
  if (payload.kind === 'image') return payload.text ?? '';
  return payload.text ?? payload.url ?? '';
}
