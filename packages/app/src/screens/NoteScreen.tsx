/**
 * Редактор — SCREENS §4, BEHAVIOR §2.
 *
 * Экран — обёртка над `@zapiski/editor`: шапка с крошкой, чипы тегов, панель
 * «Инфо», backlinks, статус-строка и режим фокуса. Всё, что касается текста
 * (live-preview, автоформат, IME, автосохранение), живёт в редакторе.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from 'react';
import {
  baseName,
  countWords,
  extractTags,
  isEncryptedPath,
  isImageAttachment,
  isMarkdownFile,
  joinTitle,
  noteImagePaths,
  splitTitle,
  stemOf,
  toMessengerText,
  type Note,
  type NoteMeta,
  type ShareOutFile,
  type VaultPath,
} from '@zapiski/core';
import {
  Editor,
  editorCommands,
  FormatPanel,
  insertImage as insertImageCommand,
  ru as editorStrings,
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
  IconShare,
  IconTable,
  IconWikiLink,
} from '../components/icons.js';
import { useApp, useAppState, useLayout, useStrings } from '../state/context.js';
import { setActiveEditor } from '../state/active-editor.js';
import { NoteSkeleton } from '../components/ScreenStates.js';
import { LockScreen } from './LockScreen.js';
import { InfoPanel } from './InfoPanel.js';
import { NoteMenu } from './NoteMenu.js';
import { formatBytes, relativeTime } from '../lib/format.js';
import { AttachmentUrls, attachmentMime } from '../lib/attachment-urls.js';
import { ImageViewer } from '../components/ImageViewer.js';
import { FormatPanelSlot } from '../components/FormatPanelSlot.js';
import { imageWidthOf, setImageWidth } from '@zapiski/editor';
import { ModeSwitch } from '../components/ModeSwitch.js';

/**
 * Что предлагать в системном выборе файла (ITERATION-1 §5).
 *
 * `image/*` на Android открывает и галерею, и камеру — поэтому отдельного
 * пункта «камера» нет: система спрашивает сама и делает это лучше нас.
 * `audio/*` там же предлагает диктофон.
 */
const ACCEPT: Record<'image' | 'file' | 'audio', string> = {
  image: 'image/*',
  audio: 'audio/*',
  file: '*/*',
};

/**
 * Сколько байтов картинок уезжает с одной заметкой.
 *
 * На время отправки копия каждой ложится в кэш приложения — иначе получатель
 * не сможет её прочитать (у него нет доступа к нашему хранилищу). Двадцать
 * пять мегабайт — это уже полтора десятка снимков с телефона; дальше
 * начинается не «поделиться заметкой», а выгрузка альбома.
 */
const SHARE_BYTES_LIMIT = 25 * 1024 * 1024;

export interface NoteScreenProps {
  path: VaultPath;
}

export function NoteScreen({ path }: NoteScreenProps): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const layout = useLayout();
  const theme = useTheme();
  const editorRef = useRef<EditorHandle | null>(null);
  /**
   * Тот же редактор, но в состоянии, — и это не дубль ради удобства.
   *
   * Представление CodeMirror живёт не весь срок экрана: любой перезаход в
   * хранилище поднимает флаг «загружаюсь», экран уходит в скелетон, и редактор
   * пересоздаётся. Ссылка в ref об этом не сообщает никому: панель
   * форматирования продолжала держать представление, которого уже нет, а
   * палитра команд — разрушенное. Со стороны это выглядело как «кнопки панели
   * не работают», причём избирательно: меню правки таблицы не открывалось
   * вовсе, потому что ему нужно ЖИВОЕ состояние, а не просто обработчик.
   */
  const [editorHandle, setEditorHandle] = useState<EditorHandle | null>(null);
  const attachEditor = useCallback((value: EditorHandle | null) => {
    editorRef.current = value;
    setEditorHandle(value);
  }, []);
  /* Представление появляется в эффекте самого редактора, то есть ПОСЛЕ того,
     как сюда пришла ссылка. Поэтому панель получает его отдельным состоянием:
     иначе первый рендер отдал бы ей `null` навсегда. */
  const [panelView, setPanelView] = useState<EditorHandle['view']>(null);
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
  /**
   * Что именно выбирают сейчас: изображение, файл или аудио (ITERATION-1 §5).
   * Input один на все три — у него меняется `accept`: три скрытых поля вместо
   * одного не дают ничего, кроме трёх мест, где можно забыть обработчик.
   */
  const [attachKind, setAttachKind] = useState<'image' | 'file' | 'audio'>('image');
  /** Файл висит над областью текста — подсветка зоны (ITERATION-1 §5). */
  const [dragOver, setDragOver] = useState(false);
  /**
   * Приём файла в область текста — на ОБЕИХ поверхностях экрана.
   *
   * Обработчики были только у зашифрованной (экран замка), а у обычной их не
   * было вовсе: файл, бро́шенный в открытую заметку, не делал ничего — окно
   * просто пыталось открыть его само. Один объект на оба места, чтобы такое
   * расхождение больше не заводилось.
   */
  const dropProps = {
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      setDragOver(true);
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDragOver(false);
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      const dropped = Array.from(event.dataTransfer.files);
      if (dropped.length === 0) return;
      event.preventDefault();
      setDragOver(false);
      void acceptDropped(dropped);
    },
  };
  /**
   * Мост «путь вложения → URL».
   *
   * Без него вставленная картинка показывалась строкой `attachments/…`:
   * редактор спрашивал `resolveAttachment`, а передать его было некому.
   * Счётчик перерисовки нужен затем, что колбэк синхронный — первый вызов
   * возвращает `null` и запускает чтение, а перерисовка показывает результат.
   */
  const [attachmentTick, setAttachmentTick] = useState(0);
  /** Картинка в полноэкранном просмотре; `null` — просмотр закрыт (§5). */
  const [viewing, setViewing] = useState<{ src: string; alt: string } | null>(null);
  const attachments = useRef<AttachmentUrls | null>(null);
  if (attachments.current === null) {
    attachments.current = new AttachmentUrls(() => setAttachmentTick((value) => value + 1));
  }
  useEffect(() => {
    const urls = attachments.current;
    urls?.attach(app.vaultRef?.storage ?? null);
    return () => urls?.clear();
  }, [app, app.vaultRef]);
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
  /**
   * Название, унаследованное от ИМЕНИ ФАЙЛА, — для заметок без строки `# …`.
   *
   * Заказчик: «заметки .md, перенесённые из Obsidian, не подхватывают название
   * файла в виде заголовка заметки». В списке они назывались правильно (там
   * имя файла давно третий источник имени), а в открытой заметке поле
   * названия было пустым — то есть приложение противоречило само себе.
   *
   * Отдельным состоянием, а не в `title`, ради чужого архива: `title`
   * участвует в сохранении, и подставь мы туда имя файла, простое ОТКРЫТИЕ
   * заметки дописало бы в чужой файл строку `# Название`. Здесь имя только
   * показывается; в файл оно попадёт, когда человек тронет поле сам — то
   * есть по его решению, а не по нашему.
   */
  const [inheritedTitle, setInheritedTitle] = useState('');
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
      /* Строки `# …` в файле нет — показываем имя файла, как это делает
         список. «Без названия» не наследуем: так называется наша же заметка,
         у которой имени действительно нет. */
      const stem = stemOf(path);
      setInheritedTitle(
        split.title === '' && stem !== strings.notes.untitled ? stem : '',
      );
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
     (`editorCommands`, а не копией списка). Зависимость — сам редактор, а не
     путь: пересоздали редактор, значит прежний разрушен, и держать его
     означало бы выполнять команды в пустоту. */
  useEffect(() => {
    setActiveEditor(editorHandle);
    setPanelView(editorHandle?.view ?? null);
    return () => setActiveEditor(null);
  }, [editorHandle]);

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
      listIndent: theme.editor.listIndent,
      listMarkColor: theme.editor.listMarkColor,
      margins: theme.editor.margins,
    }),
    [
      theme.editor.fontSize,
      theme.editor.lineHeight,
      theme.editor.columnWidth,
      theme.editor.typeface,
      theme.editor.compact,
      theme.editor.listIndent,
      theme.editor.listMarkColor,
      theme.editor.margins,
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
        <div
          className={`za-editor__surface${dragOver ? ' za-editor__surface--drop' : ''}`}
          {...dropProps}
        >
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

        <div
          className={`za-editor__surface${dragOver ? ' za-editor__surface--drop' : ''}`}
          {...dropProps}
        >
          <div className="za-editor__column">
            {/* Шаг 3 онбординга — здесь, а не на отдельном экране (SCREENS §1). */}
            {state.firstRun ? (
              <span className="za-chip za-chip--success">{strings.onboarding.step3.chip}</span>
            ) : null}

            {/* Чип автозамка расшифрованной заметки (SCREENS §7 `2g`). */}
            {unlocked ? <DecryptedChip lockAt={unlocked.lockAt} /> : null}

            {tags.length > 0 && !state.focusMode ? (
              <div className="za-editor__tags">
                {/* Отражение тегов из текста; редактируются только там (§7). */}
                {tags.map((tag) => (
                  <Tag key={tag} onClick={() => app.openTag(tag)} style={{ cursor: 'pointer' }}>
                    <span className="za-tag__hash" aria-hidden="true">
                      #
                    </span>
                    {tag}
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
                value={title === '' ? inheritedTitle : title}
                placeholder={strings.note.titlePlaceholder}
                aria-label={strings.note.titlePlaceholder}
                spellCheck={false}
                /* Новая заметка: курсор сразу в названии, а не в теле. */
                autoFocus={body === ''}
                onChange={(event) => {
                  /* Человек тронул поле — унаследованное имя больше не
                     подсказка, а его собственный заголовок: с этого момента
                     оно живёт в тексте файла. */
                  setInheritedTitle('');
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
              ref={attachEditor}
              value={editorBody}
              typography={typography}
              typewriterScroll={theme.editor.typewriter}
              moveDoneToBottom={theme.editor.moveDone}
              spellCheck={theme.editor.spellcheck}
              mode={theme.editor.mode}
              /* Raw — принадлежность профессионального режима (§8): в простом
                 разметки нет ни в одном состоянии, и «показать её сырой» там
                 означало бы дверь в то, чего человек не выбирал. */
              rawMode={theme.editor.mode === 'pro' && state.rawMode}
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
              onPasteImage={async (file) => (await app.attachImage(file, path))?.path ?? null}
              /* `attachmentTick` в зависимостях нарочно: колбэк обязан быть
                 новым после каждой дочитанной картинки, иначе редактор не
                 пересчитает декорации и виджет не появится. */
              resolveAttachment={(src) => {
                void attachmentTick;
                return attachments.current?.resolve(src) ?? null;
              }}
              /* Дочитанное вложение обязано появиться сразу. Одного нового
                 колбэка мало: CodeMirror пересчитывает декорации по
                 транзакциям, а не по рендерам React, — и картинка ждала
                 следующего нажатия клавиши. */
              attachmentsVersion={attachmentTick}
              /* Размер для карточки файла (§5). Пока байты не прочитаны —
                 пустая строка: карточка тогда без размера, а не с нулём. */
              attachmentSize={(src) => {
                void attachmentTick;
                const bytes = attachments.current?.size(src);
                return bytes === null || bytes === undefined ? '' : formatBytes(bytes, strings);
              }}
              /* Тап по вложению (§5): картинка — полноэкранный просмотр,
                 остальное — системное приложение. Разделение здесь, а не в
                 редакторе: про оболочку знает приложение. */
              onOpenAttachment={(src) => {
                const external = /^(https?:)?\/\//i.test(src);
                if (isImageAttachment(src)) {
                  const url = external ? src : (attachments.current?.resolve(src) ?? null);
                  if (url) setViewing({ src: url, alt: src });
                  return;
                }
                if (external) {
                  void app.host.openExternal(src);
                  return;
                }
                /*
                 * Файл из хранилища отдаём СИСТЕМЕ, а не браузеру (замечание
                 * 16). `blob:`-адрес, которым это работало в вебе, Android и
                 * Windows бесполезен: им нужен настоящий путь или
                 * `content://`. Поэтому сперва порт оболочки, и только если
                 * она не смогла — прежний путь: в вебе другого и нет.
                 */
                void (async () => {
                  if (await app.host.openAttachment?.(src as never).catch(() => false)) return;
                  const url = attachments.current?.resolve(src) ?? null;
                  if (url) await app.host.openExternal(url);
                })();
              }}
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
          accept={ACCEPT[attachKind]}
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

        {/*
          Панель форматирования (ITERATION-1 §4). На десктопе — пилюля под
          шапкой редактора, на мобильном — прижата к верхней кромке клавиатуры
          и заменяет прежний тулбар высотой 44.

          Прежний тулбар был рядом плоских кнопок в две строки: что применено
          к тексту под курсором, по нему понять было нельзя, и половина
          форматирования в него просто не влезала.
        */}
        {!state.focusMode ? (
          <FormatPanelSlot
            placement={theme.editor.panelPlacement}
            spot={theme.editor.panelSpot}
            mobile={isMobile}
            onMove={(spot) => theme.setEditor({ panelSpot: spot })}
          >
            <FormatPanel
              /* Символ маркера — из настроек: он попадает в текст файла. */
              bulletMarker={theme.editor.listMarker}
              view={panelView}
              strings={editorStrings}
              /* Удаление строки и столбца таблицы — ОО (§4): тост «Строка
                 удалена · Отменить». Отменяет обычная отмена редактора: сам
                 тост ничего не хранит, иначе рядом с настоящей историей
                 завёлся бы второй механизм отката. */
              onUndoable={(message, undoAction) =>
                app.toast({
                  message,
                  actionLabel: strings.actions.undo,
                  onAction: undoAction,
                })
              }
              onAttach={(kind) => {
                setAttachKind(kind);
                /* `accept` ставится до открытия диалога: изменение атрибута
                   после `click()` система уже не увидит. */
                if (imageInput.current) imageInput.current.accept = ACCEPT[kind];
                imageInput.current?.click();
              }}
            />
          </FormatPanelSlot>
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
      {/*
        Меню «⋯» монтируется на ВСЕХ платформах, а не только на мобильной.

        Прежде оно стояло под `isMobile`, а кнопка «⋯» в шапке рисовалась
        всегда: на десктопе и в Windows нажатие переключало состояние, которое
        никто не читал, и не происходило ровно ничего. Через это меню лежит
        единственный путь к «Зашифровать» и «Снять шифрование» из открытой
        заметки — то есть шифрование с десктопа было недостижимо.
      */}
      {note ? (
        <NoteMenu
          note={{ ...note, body }}
          backlinks={backlinks}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          showInfo={isMobile}
        />
      ) : null}

      {/* Полноэкранный просмотр картинки (ITERATION-1 §5). */}
      <ImageViewer
        src={viewing?.src ?? null}
        alt={viewing?.alt ?? ''}
        onClose={() => setViewing(null)}
        /* Размер картинки В ЗАМЕТКЕ и обрезка САМОГО ФАЙЛА — разные вещи, и
           обе доступны только для вложений из хранилища: у картинки по
           внешней ссылке ни того, ни другого мы не касаемся (замечание 2). */
        {...(viewing && !/^(https?:)?\/\//i.test(viewing.alt)
          ? {
              width: imageWidthOf(altOfImage(editorBody, viewing.alt)),
              onWidth: (next: number | null) => {
                const view = editorRef.current?.view;
                if (view) setImageWidth(viewing.alt, next)(view);
              },
              onCrop: async (rect: {
                x: number;
                y: number;
                width: number;
                height: number;
              }): Promise<boolean> => {
                const ok = await app.cropAttachment(viewing.alt as VaultPath, rect);
                if (ok) {
                  /* Кэш держит прежние байты — без сброса на экране осталась
                     бы необрезанная картинка. */
                  attachments.current?.forget(viewing.alt);
                  setViewing(null);
                }
                return ok;
              },
            }
          : {})}
      />
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
          {/* Режим показа разметки — на каждой заметке, справа сверху
              (замечание 3). Стоит первым в группе действий: это взгляд на
              текст, а не действие над ним. */}
          <ModeSwitch />
          {/* Замок в шапке — быстрое «запереть сейчас» (SCREENS §7 `2g`). */}
          {unlocked ? (
            <IconButton
              icon={<IconLock size={18} />}
              label={strings.note.lockNow}
              tone="ghost"
              onClick={() => app.lockNote(path)}
            />
          ) : null}
          {/*
            «Поделиться» — там, где у платформы есть системное окно.
            Порт объявляет только Android, и кнопка появляется ровно там:
            по правилу BEHAVIOR §5.1 скрытый элемент честнее выключенного, а
            в вебе и на Windows обмен идёт другими путями.

            Уходит markdown как есть — заголовок строкой `# …` и тело. Тому,
            кто принимает, виднее: Telegram разбирает разметку сам.
          */}
          {app.host.platform.shareOut ? (
            <IconButton
              icon={<IconShare size={18} />}
              label={strings.note.share}
              tone="ghost"
              onClick={() => void shareNote()}
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
  /**
   * Отдать заметку системному «Поделиться».
   *
   * ── Почему не сырой markdown ────────────────────────────────────────────
   *
   * До сих пор наружу уходило то же, что лежит в файле, — на том основании,
   * что «принимающая сторона разберётся сама». Заказчик прислал снимок из
   * Telegram: `# Психологов развелось!`, `**Слишком много выбора.**`
   * звёздочками, `> цитата` палкой, `![|258](Images/…)` и `[имя](адрес)`
   * скобками. Не разобралась.
   *
   * Проверено по источникам, а не по догадке:
   *
   *   · Telegram для Android приводит пришедший `EXTRA_TEXT` к строке, а затем
   *     ищет РОВНО шесть видов разметки регулярками (`**`, `__`, `||`, `~~`,
   *     `` ` ``, ```` ``` ````). Заголовок, цитата, список, картинка и
   *     `[имя](адрес)` не значат для него ничего;
   *   · у MAX разметка — параметр Bot API (`format: "markdown"`), то есть
   *     привилегия бота: текст, присланный человеком, он разбирать не обязан.
   *
   * Поэтому текст переводится в то, что получатель действительно покажет:
   * структуру держат обычные символы (`•`, `☐`, `│`, `———`), а начертания —
   * только те маркеры, которые он знает. Режим выбирается в настройках: если
   * получатель не разбирает и их, уходит голый текст (`shareFlavour`).
   *
   * Зашифрованная заметка отдаётся расшифрованной — но только та, что человек
   * уже открыл на этом экране: тянуть ключ ради «поделиться» неправильно, а
   * отправить шифротекст — бессмысленно.
   */
  async function shareNote(): Promise<void> {
    const provider = app.host.platform.shareOut;
    if (!provider) return;
    const shown = title === '' ? inheritedTitle : title;
    const outcome = await provider
      .share({
        ...(shown === '' ? {} : { title: shown }),
        text: toMessengerText(joinTitle(shown, editorBody), { flavour: app.shareFlavour() }),
        files: await shareFiles(),
      })
      .catch((error: unknown) => ({
        kind: 'failed' as const,
        reason: error instanceof Error ? error.message : undefined,
      }));
    /* Открылось системное окно — говорить нечего, человек уже в нём. */
    if (outcome.kind === 'shared') return;
    if (outcome.kind === 'copied') {
      app.toast({ message: strings.note.shareCopied });
      return;
    }
    app.toast({ message: strings.note.shareFailed(outcome.reason) });
  }

  /**
   * Картинки заметки — файлами, а не строкой `![](Images/…)`.
   *
   * На снимке заказчика фотография из заметки не уехала вовсе: в Telegram
   * приехал только её путь. Теперь она идёт вложением к тому же сообщению.
   *
   * Три ограничения, и каждое — про чужое устройство, а не про нашу
   * аккуратность:
   *
   *  · счёт (`SHARE_IMAGE_LIMIT`) — заметка на сто картинок не превращается
   *    в сто файлов в чужом чате;
   *  · объём (`SHARE_BYTES_LIMIT`) — копия каждой картинки на время отправки
   *    ложится в кэш, и заметка с десятком фотографий заняла бы там сотни
   *    мегабайт;
   *  · нечитаемое пропускается молча. Отказ отправить заметку из-за того, что
   *    одна картинка не прочиталась, — это потеря заметки ради вложения.
   */
  async function shareFiles(): Promise<ShareOutFile[]> {
    const storage = app.vaultRef?.storage;
    if (!storage) return [];
    const files: ShareOutFile[] = [];
    let total = 0;
    for (const src of noteImagePaths(joinTitle(title, editorBody))) {
      const bytes = await storage.read(src as VaultPath).catch(() => null);
      if (!bytes || bytes.byteLength === 0) continue;
      if (total + bytes.byteLength > SHARE_BYTES_LIMIT) break;
      total += bytes.byteLength;
      files.push({ name: baseName(src), mime: attachmentMime(src), bytes });
    }
    return files;
  }

  /**
   * Что делать с тем, что уронили в область текста.
   *
   * Развилка одна и проходит по расширению:
   *
   *   · `.md` — это ЗАМЕТКА, а не вложение. Заказчик: «Если перетаскиваю,
   *     например, из Explorer в окно редактора, то заметка .md открывается в
   *     редакторе, а сохраняется в текущей выбранной в меню папке». До сих пор
   *     такой файл прикреплялся карточкой «файл» — то есть текст заметки
   *     оказывался вложением, недоступным ни поиску, ни синхронизации как
   *     заметка;
   *   · всё остальное — вложение, как и было (ITERATION-1 §5).
   *
   * Порядок важен: вложения вставляются в ТЕКУЩУЮ заметку, поэтому они идут
   * первыми — открытие импортированной заметки сменит экран.
   */
  async function acceptDropped(files: File[]): Promise<void> {
    const notes = files.filter((file) => isMarkdownFile(file.name));
    /* По одному и по порядку: параллельная запись нескольких файлов в одну
       папку даёт гонку за именем. */
    for (const file of files) {
      if (!isMarkdownFile(file.name)) await attachAndInsert(file);
    }
    if (notes.length === 0) return;
    const paths = await app.importDroppedNotes(notes, state.folder ?? undefined);
    const first = paths[0];
    if (first !== undefined) app.openNote(first);
  }

  async function attachAndInsert(file: File): Promise<void> {
    /* Путь заметки нужен правилу «рядом с заметкой» (ITERATION-1 §5): где
       лежит сама заметка, знает экран, а не контроллер. */
    const result = await app.attachImage(file, path);
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

/**
 * Подпись картинки по её пути — в ней живёт ширина (`![подпись|400](путь)`).
 * Пустая строка, если картинки с таким путём в тексте нет.
 */
function altOfImage(text: string, path: string): string {
  for (const match of text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)) {
    if ((match[2] ?? '') === path) return match[1] ?? '';
  }
  return '';
}
