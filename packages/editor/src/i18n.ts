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
    voice: string;
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
    voice: 'Микрофон',
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
    voice: 'Voice',
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
};

export const editorStrings = Facet.define<EditorStrings, EditorStrings>({
  combine: (values) => values[0] ?? ru,
  static: true,
});
