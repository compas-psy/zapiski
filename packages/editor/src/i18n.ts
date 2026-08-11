/**
 * Каталоги строк редактора.
 *
 * ARCHITECTURE §3.5: «Ни одной строки, зашитой в компонент. Только каталоги
 * i18n (`ru`, `en`)». Каталог передаётся фасетом, поэтому приложение может
 * подменить его своим — например, общим каталогом из `@zapiski/core`.
 *
 * Тон формулировок — VOICE.md и BEHAVIOR §11: без восклицательных знаков,
 * без слов «ошибка» и «внимание», сообщаем что произошло и что можно сделать.
 */

import { Facet } from '@codemirror/state';

export interface EditorStrings {
  find: {
    placeholder: string;
    replacePlaceholder: string;
    /** «3 из 12» — счётчик совпадений (BEHAVIOR §4). */
    count(current: number, total: number): string;
    empty: string;
    next: string;
    previous: string;
    replace: string;
    replaceAll: string;
    close: string;
  };
  focus: {
    /** «фокус · Esc — выйти» в правом верхнем углу (SCREENS §4). */
    hint: string;
  };
  toolbar: {
    heading: string;
    bold: string;
    italic: string;
    bulletList: string;
    task: string;
    photo: string;
    more: string;
    quote: string;
    code: string;
    table: string;
    divider: string;
    link: string;
    footnote: string;
    wikiLink: string;
  };
  editor: {
    /** Плейсхолдер пустой заметки (SCREENS §1, шаг 3). */
    placeholder: string;
  };
  /**
   * Панель форматирования (ITERATION-1 §4) — плавающие пилюли с меню.
   * Хоткеи держатся рядом со своим пунктом: в меню они печатаются справа
   * моноширинным, и разносить подпись и сочетание по разным местам значит
   * рано или поздно их рассинхронизировать.
   */
  panel: {
    label: string;
    undo: string;
    redo: string;
    blockStyle: string;
    styles: Record<
      'text' | 'heading' | 'quote' | 'callout' | 'code' | 'small' | 'divider',
      string
    >;
    headingLevel(level: number): string;
    back: string;
    weight: string;
    weights: Record<'bold' | 'italic' | 'strike' | 'highlight' | 'mono', string>;
    lists: string;
    listKinds: Record<'none' | 'bullet' | 'ordered' | 'task' | 'details', string>;
    table: string;
    link: string;
    linkText: string;
    linkUrl: string;
    insert: string;
    cancel: string;
    attachment: string;
    attachments: Record<'image' | 'file' | 'audio', string>;
    formula: string;
    formulaPlaceholder: string;
    formulaBlock: string;
    formulaBroken: string;
    done: string;
    emoji: string;
    hotkeys: Record<
      'bold' | 'italic' | 'text' | 'quote' | 'code' | 'bullet' | 'ordered' | 'task',
      string
    >;
  };
}

export const ru: EditorStrings = {
  find: {
    placeholder: 'Найти',
    replacePlaceholder: 'Заменить',
    count: (current, total) => `${current} из ${total}`,
    empty: 'Ничего не нашлось',
    next: 'Дальше',
    previous: 'Назад',
    replace: 'Заменить',
    replaceAll: 'Заменить всё',
    close: 'Закрыть',
  },
  focus: { hint: 'фокус · Esc — выйти' },
  toolbar: {
    heading: 'Заголовок',
    bold: 'Жирный',
    italic: 'Курсив',
    bulletList: 'Список',
    task: 'Чекбокс',
    photo: 'Фото',
    more: 'Ещё',
    quote: 'Цитата',
    code: 'Код',
    table: 'Таблица',
    divider: 'Разделитель',
    link: 'Ссылка',
    footnote: 'Сноска',
    wikiLink: 'Wiki-ссылка',
  },
  editor: {
    placeholder:
      'Просто пишите. Первая строка станет заголовком, #тег — тегом, а сохранится всё само',
  },
  panel: {
    label: 'Форматирование',
    undo: 'Отменить',
    redo: 'Повторить',
    blockStyle: 'Стиль абзаца',
    styles: {
      text: 'Текст',
      heading: 'Заголовок',
      quote: 'Цитата',
      callout: 'Выноска',
      code: 'Код',
      small: 'Мелкий текст',
      divider: 'Разделитель',
    },
    headingLevel: (level: number): string => `Заголовок ${level}`,
    back: 'Назад',
    weight: 'Начертание',
    weights: {
      bold: 'Жирный',
      italic: 'Курсив',
      strike: 'Зачёркнутый',
      highlight: 'Подсветка',
      mono: 'Моноширинный',
    },
    lists: 'Списки',
    listKinds: {
      none: 'Без списка',
      bullet: 'Список с маркерами',
      ordered: 'Список с номерами',
      task: 'Чек-лист',
      details: 'Сворачиваемый блок',
    },
    table: 'Таблица',
    link: 'Ссылка',
    linkText: 'Текст',
    linkUrl: 'Адрес',
    insert: 'Вставить',
    cancel: 'Отмена',
    attachment: 'Вложение',
    attachments: { image: 'Изображение', file: 'Файл', audio: 'Аудиозапись' },
    formula: 'Формула',
    formulaPlaceholder: 'Формула LaTeX',
    formulaBlock: 'Отдельной строкой',
    formulaBroken: 'Не удалось разобрать формулу',
    done: 'Готово',
    emoji: 'Эмодзи',
    hotkeys: {
      bold: 'Ctrl+B',
      italic: 'Ctrl+I',
      text: 'Ctrl+0',
      quote: 'Ctrl+Shift+Q',
      code: 'Ctrl+Shift+C',
      bullet: 'Ctrl+Shift+L',
      ordered: 'Ctrl+Shift+O',
      task: 'Ctrl+Shift+K',
    },
  },
};

export const en: EditorStrings = {
  find: {
    placeholder: 'Find',
    replacePlaceholder: 'Replace',
    count: (current, total) => `${current} of ${total}`,
    empty: 'Nothing found',
    next: 'Next',
    previous: 'Previous',
    replace: 'Replace',
    replaceAll: 'Replace all',
    close: 'Close',
  },
  focus: { hint: 'focus · Esc to exit' },
  toolbar: {
    heading: 'Heading',
    bold: 'Bold',
    italic: 'Italic',
    bulletList: 'List',
    task: 'Checkbox',
    photo: 'Photo',
    more: 'More',
    quote: 'Quote',
    code: 'Code',
    table: 'Table',
    divider: 'Divider',
    link: 'Link',
    footnote: 'Footnote',
    wikiLink: 'Wiki link',
  },
  editor: {
    placeholder: 'Just write. The first line becomes the title, #tag becomes a tag, saving is automatic',
  },
  panel: {
    label: 'Formatting',
    undo: 'Undo',
    redo: 'Redo',
    blockStyle: 'Paragraph style',
    styles: {
      text: 'Text',
      heading: 'Heading',
      quote: 'Quote',
      callout: 'Callout',
      code: 'Code',
      small: 'Small text',
      divider: 'Divider',
    },
    headingLevel: (level: number): string => `Heading ${level}`,
    back: 'Back',
    weight: 'Weight',
    weights: {
      bold: 'Bold',
      italic: 'Italic',
      strike: 'Strikethrough',
      highlight: 'Highlight',
      mono: 'Monospace',
    },
    lists: 'Lists',
    listKinds: {
      none: 'No list',
      bullet: 'Bulleted list',
      ordered: 'Numbered list',
      task: 'Checklist',
      details: 'Collapsible block',
    },
    table: 'Table',
    link: 'Link',
    linkText: 'Text',
    linkUrl: 'Address',
    insert: 'Insert',
    cancel: 'Cancel',
    attachment: 'Attachment',
    attachments: { image: 'Image', file: 'File', audio: 'Audio recording' },
    formula: 'Formula',
    formulaPlaceholder: 'LaTeX formula',
    formulaBlock: 'On its own line',
    formulaBroken: 'Could not parse the formula',
    done: 'Done',
    emoji: 'Emoji',
    hotkeys: {
      bold: 'Ctrl+B',
      italic: 'Ctrl+I',
      text: 'Ctrl+0',
      quote: 'Ctrl+Shift+Q',
      code: 'Ctrl+Shift+C',
      bullet: 'Ctrl+Shift+L',
      ordered: 'Ctrl+Shift+O',
      task: 'Ctrl+Shift+K',
    },
  },
};

export const editorStrings = Facet.define<EditorStrings, EditorStrings>({
  combine: (values) => values[0] ?? ru,
  static: true,
});
