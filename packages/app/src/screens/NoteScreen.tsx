/**
 * Редактор — SCREENS §4, BEHAVIOR §2.
 *
 * Экран — обёртка над `@zapiski/editor`: шапка с крошкой, чипы тегов, панель
 * «Инфо», backlinks, статус-строка и режим фокуса. Всё, что касается текста
 * (live-preview, автоформат, IME, автосохранение), живёт в редакторе.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  countWords,
  extractTags,
  isEncryptedPath,
  stemOf,
  type Note,
  type NoteMeta,
  type VaultPath,
} from '@zapiski/core';
import { Editor, editorCommands, toolbarCommands, type EditorHandle } from '@zapiski/editor';
import {
  EditorToolbar,
  IconArrowLeft,
  IconBold,
  IconCheckSquare,
  IconHeading,
  IconImage,
  IconInfo,
  IconItalic,
  IconList,
  IconLock,
  IconMic,
  IconButton,
  Tag,
} from '@zapiski/ui';
import {
  IconCode,
  IconFootnote,
  IconLink,
  IconQuote,
  IconRule,
  IconTable,
  IconWikiLink,
} from '../components/icons.js';
import { useApp, useAppState, useLayout, useStrings } from '../state/context.js';
import { NoteSkeleton } from '../components/ScreenStates.js';
import { LockScreen } from './LockScreen.js';
import { InfoPanel } from './InfoPanel.js';
import { NoteMenu } from './NoteMenu.js';
import { relativeTime } from '../lib/format.js';

export interface NoteScreenProps {
  path: VaultPath;
}

export function NoteScreen({ path }: NoteScreenProps): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const layout = useLayout();
  const editorRef = useRef<EditorHandle>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(true);
  const [toolbarExtra, setToolbarExtra] = useState(false);

  const encrypted = isEncryptedPath(path);
  const unlocked = app.unlockedNote(path);
  const isMobile = layout === 'mobile' || layout === 'compact';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void app.readNote(path).then((loaded) => {
      if (cancelled) return;
      setNote(loaded);
      setBody(loaded?.body ?? '');
      setLoading(false);
    });
    return () => {
      cancelled = true;
      /* Выход из заметки — немедленный замок (BEHAVIOR §5.3). */
      if (isEncryptedPath(path)) app.lockNote(path);
    };
  }, [app, path]);

  /* Навигация «назад» и закрытие — принудительное сохранение (BEHAVIOR §0). */
  const flush = useCallback(() => editorRef.current?.save(), []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [flush]);

  const meta: NoteMeta | undefined = state.notes.find((item) => item.path === path);
  const backlinks = useMemo(() => {
    const vault = app.vaultRef;
    if (!vault || !meta) return [];
    return vault.index.backlinks(meta.id);
  }, [app, meta, state.notes]);

  const tags = useMemo(() => (encrypted ? [] : extractTags(body)), [body, encrypted]);
  const words = useMemo(() => countWords(body), [body]);
  const crumb = path.includes('/') ? path.slice(0, path.lastIndexOf('/')).split('/').join(' / ') : '';

  const screenState = app.screenState('note', body.trim() === '');

  /* Зашифрованная и ещё не открытая заметка — экран разблокировки. */
  if (encrypted && !unlocked) {
    return (
      <div className="za-editor">
        <NoteHeader />
        <div className="za-editor__surface">
          <LockScreen
            path={path}
            title={meta?.title ?? stemOf(path)}
            onUnlocked={(text) => setBody(text)}
          />
        </div>
      </div>
    );
  }

  if (loading || screenState === 'loading') {
    return (
      <div className="za-editor">
        <NoteHeader />
        <NoteSkeleton />
      </div>
    );
  }

  return (
    <div className="za-editor" style={{ flexDirection: 'row' }}>
      <div className="za-editor__host">
        {!state.focusMode ? <NoteHeader /> : null}
        {/* Хром скрыт полностью, кроме подсказки «фокус · Esc — выйти». */}
        {state.focusMode ? <span className="za-editor__hint">{strings.note.focusHint}</span> : null}

        <div className="za-editor__surface">
          <div className="za-editor__column">
            {/* Чип автозамка расшифрованной заметки (SCREENS §7 `2g`). */}
            {unlocked ? <DecryptedChip lockAt={unlocked.lockAt} /> : null}

            {tags.length > 0 && !state.focusMode ? (
              <div className="za-editor__tags">
                {tags.map((tag) => (
                  <Tag key={tag} onClick={() => app.openTag(tag)} style={{ cursor: 'pointer' }}>
                    #{tag}
                  </Tag>
                ))}
              </div>
            ) : null}

            <Editor
              ref={editorRef}
              value={body}
              rawMode={state.rawMode}
              focusMode={state.focusMode}
              /* Новая заметка: клавиатура сразу, курсор в конце заголовка. */
              autoFocus={body === ''}
              cursorAtTitleEnd={body === ''}
              onChange={(next) => {
                setBody(next);
                if (encrypted) app.touchLock(path);
              }}
              /* Автосохранение: debounce 500 мс + blur. Кнопки нет нигде. */
              onSave={(next) => void app.save(path, next)}
              wikiExists={(target) =>
                state.notes.some((item) => item.title.toLowerCase() === target.toLowerCase())
              }
              tags={(prefix) =>
                state.tags
                  .filter((item) => item.tag.startsWith(prefix))
                  .slice(0, 8)
                  .map((item) => ({ tag: item.tag, count: item.count }))
              }
              notes={(query) =>
                state.notes
                  .filter((item) => item.title.toLowerCase().includes(query.toLowerCase()))
                  .slice(0, 8)
                  .map((item) => ({ title: item.title, path: item.path }))
              }
              {...(app.host.platform.haptics
                ? { onHaptic: (strength) => app.host.platform.haptics?.impact(strength) }
                : {})}
              onOpenWikiLink={(target) => {
                const found = state.notes.find(
                  (item) => item.title.toLowerCase() === target.toLowerCase(),
                );
                if (found) app.openNote(found.path);
              }}
              onCreateNote={(title) => void app.createNote(undefined, title)}
              onOpenTag={(tag) => app.openTag(tag)}
            />

            {/* Панель backlinks не показывается вовсе, если ссылок нет. */}
            {backlinks.length > 0 && !state.focusMode ? (
              <div className="za-backlinks">
                <button
                  type="button"
                  className="za-backlinks__title"
                  aria-expanded={backlinksOpen}
                  onClick={() => setBacklinksOpen((open) => !open)}
                >
                  {strings.note.backlinksTitle(backlinks.length)}
                </button>
                {backlinksOpen ? (
                  <div className="za-backlinks__list">
                    {backlinks.map((item) => (
                      <button
                        key={item.path}
                        type="button"
                        className="za-backlinks__link"
                        onClick={() => app.openNote(item.path)}
                      >
                        {item.title}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* Тулбар над клавиатурой — только mobile (SCREENS §4). */}
        {isMobile && !state.focusMode ? (
          <EditorToolbar
            label={strings.note.toolbar.label}
            items={toolbarExtra ? extraToolbar() : mainToolbar()}
          />
        ) : null}

        {/* Статус-строка: «изменено только что · N слов · автосохранение — всегда» */}
        {!state.focusMode ? (
          <div className="za-editor__status">
            {note ? relativeTime(note.updatedAt, strings) : strings.note.statusChanged} ·{' '}
            {strings.note.statusWords(words)} · {strings.note.statusAutosave}
          </div>
        ) : null}
      </div>

      {/* Панель «Инфо»: 280 на desktop, bottom sheet на mobile (BEHAVIOR §2.9). */}
      {state.infoOpen && !isMobile && note ? (
        <div className="za-info">
          <InfoPanel note={{ ...note, body }} backlinks={backlinks} />
        </div>
      ) : null}
      {isMobile && note ? (
        <NoteMenu
          note={{ ...note, body }}
          backlinks={backlinks}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
    </div>
  );

  function NoteHeader(): ReactNode {
    return (
      <div className="za-header">
        <IconButton
          icon={<IconArrowLeft size={20} />}
          label={strings.app.back}
          tone="ghost"
          onClick={() => {
            flush();
            app.back();
          }}
        />
        <span className="za-header__crumb">{crumb}</span>
        <div className="za-header__actions">
          {/* Замок в шапке — быстрое «запереть сейчас» (SCREENS §7 `2g`). */}
          {unlocked ? (
            <IconButton
              icon={<IconLock size={18} />}
              label={strings.note.lockNow}
              tone="ghost"
              onClick={() => app.lockNote(path)}
            />
          ) : null}
          <IconButton
            icon={<IconInfo size={20} />}
            label={strings.note.info}
            tone="ghost"
            onClick={() => (isMobile ? setMenuOpen(true) : app.toggleInfo())}
          />
          <IconButton
            icon={<span aria-hidden="true">⋯</span>}
            label={strings.app.more}
            tone="ghost"
            onClick={() => setMenuOpen(true)}
          />
        </div>
      </div>
    );
  }

  /** Первая строка тулбара: H · B · I · список · чекбокс · фото · микрофон · ⋯ */
  function mainToolbar(): Array<{ id: string; icon: ReactNode; label: string; onSelect: () => void }> {
    return [
      { id: 'h', icon: <IconHeading size={18} />, label: strings.note.toolbar.heading, onSelect: call(toolbarCommands.cycleHeading) },
      { id: 'b', icon: <IconBold size={18} />, label: strings.note.toolbar.bold, onSelect: runCommand('format.bold') },
      { id: 'i', icon: <IconItalic size={18} />, label: strings.note.toolbar.italic, onSelect: runCommand('format.italic') },
      { id: 'list', icon: <IconList size={18} />, label: strings.note.toolbar.list, onSelect: runCommand('format.bulletList') },
      { id: 'task', icon: <IconCheckSquare size={18} />, label: strings.note.toolbar.checkbox, onSelect: runCommand('format.task') },
      { id: 'image', icon: <IconImage size={18} />, label: strings.note.toolbar.image, onSelect: () => undefined },
      /* Микрофон — ход 3 (VOICE.md); экран записи ещё не реализован. */
      { id: 'mic', icon: <IconMic size={18} />, label: strings.note.toolbar.voice, onSelect: () => undefined },
      { id: 'more', icon: <span aria-hidden="true">⋯</span>, label: strings.note.toolbar.more, onSelect: () => setToolbarExtra(true) },
    ];
  }

  /** Вторая строка: цитата, код, таблица, разделитель, ссылка, сноска, wiki. */
  function extraToolbar(): Array<{ id: string; icon: ReactNode; label: string; onSelect: () => void }> {
    return [
      { id: 'quote', icon: <IconQuote size={18} />, label: strings.note.toolbar.quote, onSelect: runCommand('format.quote') },
      { id: 'code', icon: <IconCode size={18} />, label: strings.note.toolbar.code, onSelect: runCommand('format.codeBlock') },
      { id: 'table', icon: <IconTable size={18} />, label: strings.note.toolbar.table, onSelect: call(toolbarCommands.insertTable) },
      { id: 'divider', icon: <IconRule size={18} />, label: strings.note.toolbar.divider, onSelect: call(toolbarCommands.insertDivider) },
      { id: 'link', icon: <IconLink size={18} />, label: strings.note.toolbar.link, onSelect: runCommand('insert.link') },
      { id: 'footnote', icon: <IconFootnote size={18} />, label: strings.note.toolbar.footnote, onSelect: call(toolbarCommands.insertFootnote) },
      { id: 'wiki', icon: <IconWikiLink size={18} />, label: strings.note.toolbar.wikiLink, onSelect: runCommand('insert.wikiLink') },
      { id: 'back', icon: <span aria-hidden="true">‹</span>, label: strings.app.back, onSelect: () => setToolbarExtra(false) },
    ];
  }

  /** Запуск команды редактора по её id из `editorCommands` (BEHAVIOR §7). */
  function runCommand(id: string): () => void {
    return () => {
      const view = editorRef.current?.view;
      if (!view) return;
      editorCommands.find((item) => item.id === id)?.run(view);
    };
  }

  /** Команды тулбара, которых нет в карте хоткеев (таблица, сноска, …). */
  function call(command: (view: never) => boolean): () => void {
    return () => {
      const view = editorRef.current?.view;
      if (view) (command as unknown as (v: unknown) => boolean)(view);
    };
  }
}

/** Чип «Расшифровано · закроется через N мин» + предупреждение за 30 с. */
function DecryptedChip({ lockAt }: { lockAt: number }): ReactNode {
  const strings = useStrings();
  const [left, setLeft] = useState(() => lockAt - Date.now());

  useEffect(() => {
    const timer = setInterval(() => setLeft(lockAt - Date.now()), 1000);
    return () => clearInterval(timer);
  }, [lockAt]);

  if (!Number.isFinite(left)) {
    return <span className="za-chip">{strings.crypto.decryptedChip(0)}</span>;
  }
  /* За 30 с до автозамка чип меняет текст. Модалки нет — любой ввод отменяет. */
  const soon = left <= 30_000;
  return (
    <span className={`za-chip${soon ? '' : ' za-chip--success'}`} role="status">
      {soon ? strings.crypto.closingSoon : strings.crypto.decryptedChip(Math.max(1, Math.round(left / 60_000)))}
    </span>
  );
}
