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
  joinTitle,
  splitTitle,
  stemOf,
  type Note,
  type NoteMeta,
  type VaultPath,
} from '@zapiski/core';
import {
  Editor,
  editorCommands,
  insertImage as insertImageCommand,
  toolbarCommands,
  type EditorHandle,
} from '@zapiski/editor';
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
  IconButton,
  Tag,
  useTheme,
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
import { setActiveEditor } from '../state/active-editor.js';
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
  const theme = useTheme();
  const editorRef = useRef<EditorHandle>(null);
  /**
   * Скрытый выбор файла для кнопки «фото» (BEHAVIOR §2.6).
   *
   * Именно `<input type="file">`, а не отдельный системный вызов: он один
   * работает во всех трёх оболочках — в вебе, в WebView2 на Windows и в
   * Android WebView, где с `accept="image/*"` система сама предлагает и
   * галерею, и камеру. Своего API выбора файла в контракте хоста нет, и
   * заводить его ради этого пришлось бы трижды.
   */
  const imageInput = useRef<HTMLInputElement>(null);
  /* Предыдущий путь — чтобы отличить «открыли другую заметку» от
     «эта же заметка переехала». Разница принципиальна: во втором случае
     перечитывать с диска нельзя, см. эффект ниже. */
  const previousPath = useRef<VaultPath | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  /**
   * Заголовок и тело — раздельно (ITERATION-1 §1). В файле они по-прежнему
   * одна строка `# Название` и всё остальное; разделение живёт только в
   * представлении. Держать их отдельными состояниями, а не резать текст на
   * каждый ввод, важно для курсора: пересборка значения редактора сбрасывала
   * бы позицию.
   */
  const [title, setTitle] = useState('');
  const [editorBody, setEditorBody] = useState('');
  const titleInput = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(true);
  const [toolbarExtra, setToolbarExtra] = useState(false);

  const encrypted = isEncryptedPath(path);
  const unlocked = app.unlockedNote(path);
  const isMobile = layout === 'mobile' || layout === 'compact';

  useEffect(() => {
    let cancelled = false;

    /* Переименование по заголовку меняет путь у ТОЙ ЖЕ заметки. Перечитывать
       её с диска в этот момент нельзя: в редакторе лежит текст свежее
       дискового — между сохранением и переименованием человек продолжает
       печатать. Перечитывание затирало набранное и уводило курсор; со стороны
       это и есть «текст смещается». Обновляем только карточку заметки. */
    const previous = previousPath.current;
    previousPath.current = path;
    if (app.movedFrom(previous, path)) {
      void app.readNote(path).then((loaded) => {
        if (!cancelled) setNote(loaded);
      });
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    void app.readNote(path).then(async (loaded) => {
      if (cancelled) return;
      setNote(loaded);
      /* Хранилище открыто — запертая заметка открывается сама: пароль был
         введён один раз за сеанс, спрашивать его снова не за что (ТЗ §3.3).
         Если ключа нет, `openEncrypted` вернёт null и ниже покажется замок. */
      const text =
        isEncryptedPath(path) && !app.unlockedNote(path) ? await app.openEncrypted(path) : null;
      if (cancelled) return;
      const split = splitTitle(text ?? loaded?.body ?? '');
      setTitle(split.title);
      setEditorBody(split.body);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      /* Выход из заметки — немедленный замок (BEHAVIOR §5.3). */
      if (isEncryptedPath(path)) app.lockNote(path);
    };
  }, [app, path]);

  /* Палитра команд и хоткеи оболочки выполняют команды над этим представлением
     (`editorCommands`, а не копией списка). */
  useEffect(() => {
    setActiveEditor(editorRef.current);
    return () => setActiveEditor(null);
  }, [path, loading]);

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

  /* Файл целиком — то, что уходит на диск и во всё, что считает по тексту. */
  const body = useMemo(() => joinTitle(title, editorBody), [title, editorBody]);

  /**
   * Настройки типографики → редактор (ITERATION-1 §3).
   *
   * Дефект, о котором писал пользователь: «изменение ширины редактора не
   * работает». Ширина была лишь самым заметным симптомом. Проп `typography`
   * не передавался НИГДЕ, и редактор всегда жил на `defaultTypography` —
   * 16 px, 1.65, колонка 640, sans, не компактный. То есть мёртвыми были
   * разом пять настроек: кегль, интерлиньяж, ширина колонки, шрифт и
   * компактный режим.
   *
   * Обманывало то, что снаружи всё выглядело подключённым: `applyAppearance`
   * честно писал `--editor-measure` и `--editor-font-scale` на корень, и
   * обёртка колонки их слушалась. Но текст рисует CodeMirror, а он берёт
   * ширину из своей переменной `--z-col`, которую задаёт ровно этот проп.
   * Менялась рамка вокруг пустоты, а сам текст стоял на месте.
   */
  const typography = useMemo(
    () => ({
      size: theme.editor.fontSize,
      lineHeight: theme.editor.lineHeight,
      column: theme.editor.columnWidth,
      family: theme.editor.typeface,
      compact: theme.editor.compact,
    }),
    [
      theme.editor.fontSize,
      theme.editor.lineHeight,
      theme.editor.columnWidth,
      theme.editor.typeface,
      theme.editor.compact,
    ],
  );

  /**
   * Автосохранение заголовка. У тела оно живёт внутри редактора (debounce
   * 500 мс + blur), а поле заголовка — обычный `<input>`, и без этого набранное
   * название держалось бы до первого blur. Человек, напечатавший заголовок и
   * закрывший приложение, потерял бы его — и заодно не сработало бы
   * переименование файла по заголовку (BEHAVIOR §2.2).
   */
  useEffect(() => {
    if (loading) return;
    const timer = setTimeout(() => void app.save(path, joinTitle(title, editorBody)), 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  const tags = useMemo(() => (encrypted ? [] : extractTags(body)), [body, encrypted]);
  const words = useMemo(() => countWords(body), [body]);
  const crumb = path.includes('/') ? path.slice(0, path.lastIndexOf('/')).split('/').join(' / ') : '';

  const screenState = app.screenState('note', body.trim() === '');

  /* Зашифрованная и ещё не открытая заметка — экран разблокировки. Но если
     хранилище уже открыто, замок показывать не за что: ключ есть, пароль
     спрашивали в начале сеанса (ТЗ §3.3). */
  if (encrypted && !unlocked) {
    return (
      <div className="za-editor">
        <NoteHeader />
        <div className="za-editor__surface">
          <LockScreen
            path={path}
            title={meta?.title ?? stemOf(path)}
            onUnlocked={(text) => {
              const split = splitTitle(text);
              setTitle(split.title);
              setEditorBody(split.body);
            }}
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
            {/* Шаг 3 онбординга — здесь, а не на отдельном экране (SCREENS §1). */}
            {state.firstRun ? (
              <span className="za-chip za-chip--success">{strings.onboarding.step3.chip}</span>
            ) : null}

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

            {/* Заголовок — отдельное поле, всегда видимое, до тела (§1).
                Разметка внутри не работает: `**` останется звёздочками. */}
            {!state.focusMode ? (
              <input
                ref={titleInput}
                className="za-editor__title"
                type="text"
                value={title}
                placeholder={strings.note.titlePlaceholder}
                aria-label={strings.note.titlePlaceholder}
                spellCheck={false}
                /* Новая заметка: курсор сразу в названии, а не в теле. */
                autoFocus={body === ''}
                onChange={(event) => {
                  setTitle(event.target.value);
                  if (encrypted) app.touchLock(path);
                }}
                onBlur={() => void app.save(path, joinTitle(title, editorBody))}
                onKeyDown={(event) => {
                  /* Enter не переносит строку — уводит курсор в начало тела. */
                  if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
                    event.preventDefault();
                    editorRef.current?.focusStart();
                  }
                }}
              />
            ) : null}

            <Editor
              ref={editorRef}
              value={editorBody}
              typography={typography}
              typewriterScroll={theme.editor.typewriter}
              moveDoneToBottom={theme.editor.moveDone}
              spellCheck={theme.editor.spellcheck}
              rawMode={state.rawMode}
              focusMode={state.focusMode}
              onChange={(next) => {
                setEditorBody(next);
                if (encrypted) app.touchLock(path);
              }}
              /* Автосохранение: debounce 500 мс + blur. Кнопки нет нигде. */
              onSave={(next) => void app.save(path, joinTitle(title, next))}
              /* Backspace в начале пустого тела поднимает курсор в название
                 (§1). Возвращаем true — значит редактор ничего не удаляет. */
              onBackspaceAtStart={() => {
                if (title !== '') return false;
                titleInput.current?.focus();
                return true;
              }}
              /* Картинка из буфера — второй путь к вложению (BEHAVIOR §2.6).
                 Редактор ждал этот колбэк с самого начала, а никто его не
                 передавал: вставка картинки молча ничего не делала. */
              onPasteImage={async (file) => (await app.attachImage(file))?.path ?? null}
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

        {/* Выбор картинки. Вне экрана, но в дереве: `click()` по нему —
            единственный способ открыть системный выбор файла из кода. */}
        <input
          ref={imageInput}
          type="file"
          accept="image/*"
          className="z-visually-hidden"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            /* Значение сбрасывается всегда: без этого второй выбор ТОГО ЖЕ
               файла не поднимет `change`, и кнопка «сломается» через раз. */
            event.target.value = '';
            if (file) void attachAndInsert(file);
          }}
        />

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

  /**
   * Файл → `attachments/` → ссылка в тексте (BEHAVIOR §2.6).
   *
   * Тост об ошибке поднимает контроллер: он один знает, что копирование не
   * удалось. Здесь остаётся только не вставлять ссылку на файл, которого нет.
   */
  async function attachAndInsert(file: File): Promise<void> {
    const result = await app.attachImage(file);
    if (!result) return;
    const view = editorRef.current?.view;
    if (view) insertImageCommand(result.markdown)(view);
    editorRef.current?.focus();
  }

  /**
   * Первая строка тулбара: H · B · I · список · чекбокс · изображение · «⋯»
   * (`2_Engineering.md` §5).
   *
   * Микрофона нет и скрытой кнопки под него тоже — решение Р4: «Голос →
   * Markdown = P1, микрофон убирается из тулбара v1». Освободившееся место
   * отдано «⋯» (`1_Design.md` §1.4).
   */
  function mainToolbar(): Array<{
    id: string;
    icon: ReactNode;
    label: string;
    onSelect: () => void;
    hidden?: boolean;
  }> {
    return [
      { id: 'h', icon: <IconHeading size={18} />, label: strings.note.toolbar.heading, onSelect: call(toolbarCommands.cycleHeading) },
      { id: 'b', icon: <IconBold size={18} />, label: strings.note.toolbar.bold, onSelect: runCommand('format.bold') },
      { id: 'i', icon: <IconItalic size={18} />, label: strings.note.toolbar.italic, onSelect: runCommand('format.italic') },
      { id: 'list', icon: <IconList size={18} />, label: strings.note.toolbar.list, onSelect: runCommand('format.bulletList') },
      { id: 'task', icon: <IconCheckSquare size={18} />, label: strings.note.toolbar.checkbox, onSelect: runCommand('format.task') },
      { id: 'image', icon: <IconImage size={18} />, label: strings.note.toolbar.image, onSelect: () => imageInput.current?.click() },
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
      const run = editorCommands.find((item) => item.id === id)?.run;
      run?.(view);
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
