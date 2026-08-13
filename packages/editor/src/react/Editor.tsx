/**
 * React-обёртка редактора (React 19).
 *
 * Обёртка тонкая: вся логика живёт в расширениях CodeMirror, здесь только
 * жизненный цикл представления и мост между пропсами и рантаймом. Колбэки
 * держатся в ref и не переконфигурируют состояние — иначе каждый ререндер
 * родителя ронял бы историю отмены и позицию курсора.
 */

import { useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { CSSProperties, Ref } from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { LanguageDescription } from '@codemirror/language';

import { zapiskiEditor } from '../setup.js';
import type { EditorRuntime, NoteSuggestion, TagSuggestion } from '../runtime.js';
import { toggleCollapsed } from '../live-preview/collapsed.js';
import type { EditorStrings } from '../i18n.js';
import type { HapticStrength } from '../contract-types.js';
import { applyTypography, defaultTypography } from '../typography.js';
import type { TypographySettings } from '../typography.js';
import { setFocusMode } from '../focus/focus-mode.js';
import { setRawMode } from '../live-preview/raw-mode.js';
import { setEditorMode, type EditorMode } from '../live-preview/editor-mode.js';
import { flushAutosave } from '../save/autosave.js';
import { redecorateEffect } from '../ime/composition.js';
import { applyTaskOrder } from '../input/task-order.js';

export interface EditorHandle {
  /** Живое представление CodeMirror — для палитры команд и тулбара. */
  readonly view: EditorView | null;
  /** Немедленно сохранить (навигация назад, сворачивание приложения). */
  save(): void;
  focus(): void;
  /**
   * Фокус с курсором в самом начале текста. Нужен полю заголовка
   * (ITERATION-1 §1): Enter и Tab из заголовка ведут в начало тела, а не
   * куда придётся.
   */
  focusStart(): void;
}

export interface EditorProps {
  /** Текст заметки. Первая строка — заголовок (BEHAVIOR §2.2). */
  value: string;
  /** Вызывается на каждое изменение. Для записи на диск используйте `onSave`. */
  onChange?: (value: string) => void;
  /** Автосохранение: debounce 500 мс + blur (BEHAVIOR §0). */
  onSave?: (value: string) => void;

  /** Есть ли заметка с таким заголовком — иначе wiki-ссылка «висячая». */
  wikiExists?: (target: string) => boolean;
  /** Кандидаты тегов для автодополнения. */
  tags?: (prefix: string) => TagSuggestion[];
  /** Кандидаты заметок для `[[…]]`. */
  notes?: (query: string) => NoteSuggestion[];
  /** Хэптика: лёгкая на отметке чекбокса (BEHAVIOR §0). */
  onHaptic?: (strength: HapticStrength) => void;
  /** Картинка из буфера → путь в `attachments/` (BEHAVIOR §2.6). */
  onPasteImage?: (file: File) => Promise<string | null>;
  /** Переход по существующей wiki-ссылке. */
  onOpenWikiLink?: (target: string, mode: 'same' | 'aside') => void;
  /** Тап по висячей ссылке — «Создать заметку „Имя“». */
  onCreateNote?: (title: string) => void;
  /** Тап по тегу — поиск по тегу. */
  onOpenTag?: (tag: string) => void;
  /** `attachments/…` → URL для показа картинки. */
  resolveAttachment?: (src: string) => string | null;
  /** Объём вложения строкой («96 КБ») для карточки файла (ITERATION-1 §5). */
  attachmentSize?: (src: string) => string;
  /**
   * Счётчик готовности вложений: меняется, когда дочитан очередной файл.
   *
   * Без него картинка не появлялась до следующего нажатия клавиши, и это
   * выглядело ровно как «картинки не показываются». Причина в том, что
   * `resolveAttachment` синхронный: первый вызов отвечает `null` и запускает
   * чтение, — а рендер React сам по себе CodeMirror ни о чём не уведомляет,
   * набор декораций пересчитывается только по транзакциям.
   */
  attachmentsVersion?: number;
  /** Тап по вложению: картинка — просмотр, файл — системное приложение. */
  onOpenAttachment?: (src: string) => void;

  /** Настройки типографики; применяются мгновенно (BEHAVIOR §10). */
  typography?: TypographySettings;
  /** Каталог строк. Читается один раз при создании редактора. */
  strings?: EditorStrings;
  /** Языки подсветки кода. Читаются один раз при создании редактора. */
  codeLanguages?: LanguageDescription[];

  readOnly?: boolean;
  /** Поднять клавиатуру сразу — только для НОВОЙ заметки (BEHAVIOR §0). */
  autoFocus?: boolean;
  /**
   * Backspace в самом начале текста. Вернуть `true` — значит «я обработал»,
   * и редактор ничего не удаляет: курсор ушёл в поле заголовка
   * (ITERATION-1 §1). Решает приложение, потому что только оно знает, пуст
   * заголовок или нет.
   */
  onBackspaceAtStart?: () => boolean;
  /** Режим фокуса (BEHAVIOR §2.8). */
  focusMode?: boolean;
  /** Typewriter-скролл — опция, по умолчанию выключена. */
  typewriterScroll?: boolean;
  /** «Переносить выполненные вниз» (ITERATION-1 §3). */
  moveDoneToBottom?: boolean;
  /** Проверка орфографии системой (ITERATION-1 §3). */
  spellCheck?: boolean;
  /**
   * Режим показа разметки (ITERATION-1 §8): `simple` — не видна никогда,
   * `pro` — проявляется у курсора. Файл не меняется ни в том, ни в другом.
   */
  mode?: EditorMode;
  /** Raw ↔ live-preview (Ctrl+E). */
  rawMode?: boolean;

  className?: string;
  style?: CSSProperties;
  ref?: Ref<EditorHandle>;
}

const readOnlyCompartment = new Compartment();

export function Editor(props: EditorProps): React.ReactElement {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  /** Последнее значение, которое мы сами отдали наружу — чтобы не зациклиться. */
  const lastEmitted = useRef<string>(props.value);

  useImperativeHandle(
    props.ref,
    () => ({
      get view() {
        return viewRef.current;
      },
      save() {
        if (viewRef.current) flushAutosave(viewRef.current);
      },
      focus() {
        viewRef.current?.focus();
      },
      focusStart() {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ selection: { anchor: 0 } });
        view.focus();
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const initial = propsRef.current;

    // Стабильный рантайм: методы всегда читают свежие пропсы через ref.
    const runtime: EditorRuntime = {
      wikiExists: (target) => propsRef.current.wikiExists?.(target) ?? false,
      tags: (prefix) => propsRef.current.tags?.(prefix) ?? [],
      notes: (query) => propsRef.current.notes?.(query) ?? [],
      haptic: (strength) => propsRef.current.onHaptic?.(strength),
      save: (text) => {
        lastEmitted.current = text;
        propsRef.current.onSave?.(text);
      },
      pasteImage: async (file) => (await propsRef.current.onPasteImage?.(file)) ?? null,
      openWikiLink: (target, mode) => propsRef.current.onOpenWikiLink?.(target, mode),
      createNote: (title) => propsRef.current.onCreateNote?.(title),
      openTag: (tag) => propsRef.current.onOpenTag?.(tag),
      resolveAttachment: (src) => propsRef.current.resolveAttachment?.(src) ?? null,
      attachmentSize: (src) => propsRef.current.attachmentSize?.(src) ?? '',
      openAttachment: (src) => propsRef.current.onOpenAttachment?.(src),
      /* Сворачивание `<details>` — состояние показа, а не текста: файл не
         меняется, меняется только то, что видно (замечание 12). */
      toggleCollapsed: (at) => {
        viewRef.current?.dispatch({ effects: toggleCollapsed.of(at) });
      },
    };

    const state = EditorState.create({
      doc: initial.value,
      extensions: [
        ...zapiskiEditor({
          runtime,
          ...(initial.strings ? { strings: initial.strings } : {}),
          typography: initial.typography ?? defaultTypography,
          moveDoneToBottom: initial.moveDoneToBottom ?? false,
          mode: initial.mode ?? 'pro',
          ...(initial.codeLanguages ? { codeLanguages: initial.codeLanguages } : {}),
        }),
        readOnlyCompartment.of(EditorState.readOnly.of(initial.readOnly ?? false)),
        /* Выше остальных keymap'ов: иначе Backspace успеет удалить символ
           раньше, чем мы решим поднять курсор в заголовок. */
        Prec.highest(
          keymap.of([
            {
              key: 'Backspace',
              run: (view) => {
                const { main } = view.state.selection;
                if (!main.empty || main.from !== 0) return false;
                return propsRef.current.onBackspaceAtStart?.() ?? false;
              },
            },
          ]),
        ),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          lastEmitted.current = text;
          propsRef.current.onChange?.(text);
        }),
      ],
    });

    const view = new EditorView({ state, parent });
    viewRef.current = view;

    if (initial.focusMode || initial.typewriterScroll) {
      view.dispatch({
        effects: setFocusMode.of({
          enabled: initial.focusMode ?? false,
          typewriter: initial.typewriterScroll ?? false,
        }),
      });
    }
    if (initial.rawMode) view.dispatch({ effects: setRawMode.of(true) });
    if (initial.mode) view.dispatch({ effects: setEditorMode.of(initial.mode) });

    if (initial.autoFocus) view.focus();

    return () => {
      // Принудительное сохранение при уходе с экрана (BEHAVIOR §0).
      flushAutosave(view);
      view.destroy();
      viewRef.current = null;
    };
    // Пересоздавать редактор на смену пропсов нельзя: потеряется история.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Внешнее изменение текста (синк, отмена операции, восстановление версии).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (props.value === lastEmitted.current) return;
    const current = view.state.doc;
    if (current.length === props.value.length && current.toString() === props.value) return;
    lastEmitted.current = props.value;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: props.value },
      selection: { anchor: Math.min(view.state.selection.main.anchor, props.value.length) },
    });
  }, [props.value]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) applyTypography(view, props.typography ?? defaultTypography);
  }, [props.typography]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) applyTaskOrder(view, props.moveDoneToBottom ?? false);
  }, [props.moveDoneToBottom]);

  /* Дочитано очередное вложение — пересчитать декорации сейчас. Транзакция
     пустая, меняется только набор декораций: ни документ, ни курсор, ни
     история от неё не страдают. */
  useEffect(() => {
    const view = viewRef.current;
    if (view && props.attachmentsVersion !== undefined) {
      view.dispatch({ effects: redecorateEffect.of(null) });
    }
  }, [props.attachmentsVersion]);

  /* Смена режима — эффект над готовым состоянием: мгновенно, без потери
     истории отмены и позиции курсора (ITERATION-1 §8). */
  useEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch({ effects: setEditorMode.of(props.mode ?? 'pro') });
  }, [props.mode]);

  /* Проверка орфографии — атрибут на contenteditable, а не расширение: её
     делает система, и включается она ровно так. */
  useEffect(() => {
    const view = viewRef.current;
    if (view) view.contentDOM.spellcheck = props.spellCheck ?? false;
  }, [props.spellCheck]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: setFocusMode.of({
        enabled: props.focusMode ?? false,
        typewriter: props.typewriterScroll ?? false,
      }),
    });
  }, [props.focusMode, props.typewriterScroll]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch({ effects: setRawMode.of(props.rawMode ?? false) });
  }, [props.rawMode]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(props.readOnly ?? false)),
    });
  }, [props.readOnly]);

  return <div ref={host} className={props.className} style={props.style} />;
}
