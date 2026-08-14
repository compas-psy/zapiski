/**
 * Полная карта хоткеев редактора (BEHAVIOR §7).
 *
 * Здесь только то, что относится к тексту. Хоткеи оболочки (Ctrl+N, Ctrl+K,
 * Ctrl+\, Ctrl+, …) живут в `packages/app` — редактор про экраны не знает.
 *
 * Приёмочный критерий §13.8: все хоткеи из §7 работают и отражены в палитре
 * команд, поэтому список команд экспортируется отдельно — палитра строится
 * из него, а не из копии.
 */

import { copyLineDown, moveLineDown, moveLineUp } from '@codemirror/commands';
import { acceptCompletion } from '@codemirror/autocomplete';
import { Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import type { KeyBinding } from '@codemirror/view';
import {
  cycleHeading,
  insertCodeBlock,
  insertDivider,
  insertFootnote,
  insertLink,
  insertTable,
  insertWikiLink,
  setHeading,
  toggleBold,
  toggleBulletList,
  toggleHighlight,
  toggleItalic,
  toggleOrderedList,
  toggleQuote,
  toggleStrike,
  toggleTaskList,
} from './formatting.js';
import { completeDivider, completeFencedCode } from '../input/autoformat.js';
import { enterAtBlockStart } from '../input/block-start.js';
import { dedentListItem, indentListItem, listBackspace, listNewline } from '../input/lists.js';
import { toggleTaskAtCursor } from '../live-preview/interactions.js';
import { toggleRawMode } from '../live-preview/raw-mode.js';
import { toggleFocusMode } from '../focus/focus-mode.js';
import { openFind, openReplace } from '../search/panel.js';
import { plainPaste } from '../paste/smart-paste.js';

/** Одна команда редактора — то, из чего палитра строит свой список. */
export interface EditorCommandSpec {
  id: string;
  key: string;
  run: KeyBinding['run'];
  /**
   * По умолчанию событие гасится: иначе Ctrl+D откроет закладки браузера,
   * а Ctrl+H — историю. Исключение — Ctrl+Shift+V: там вставку выполняет
   * сам браузер, и гасить событие нельзя.
   */
  preventDefault?: boolean;
}

/**
 * Сочетания, которые в окне браузера принадлежат браузеру.
 *
 * Заказчик: «не работают горячие клавиши, например Ctrl+Shift+0 (Windows,
 * Web)». Проверка нажатием показала, что дело не в нашей карте: до страницы
 * эти сочетания просто не доходят. Ctrl+1…8 переключают вкладки, Ctrl+0
 * сбрасывает масштаб, Ctrl+L уводит в адресную строку, Ctrl+E — в поиск
 * омнибокса, Ctrl+Shift+O открывает закладки. Отменить их страница не может
 * никак: их разбирает браузер до того, как событие уйдёт в документ.
 *
 * Поэтому у каждой такой команды есть ВТОРОЕ сочетание, которого браузер не
 * трогает. Первое остаётся ради оболочек — в окне Windows и на Android
 * адресной строки нет, и там работает привычное Ctrl+1.
 *
 * Ctrl+Shift+0…6 выбраны не случайно: так это сделано в Notion, и заказчик
 * нажал именно Ctrl+Shift+0, ожидая «обычный текст». Ctrl+Shift+7 и
 * Ctrl+Shift+8 для списков — соглашение Word и Google Docs.
 */
export const editorCommands: EditorCommandSpec[] = [
  { id: 'format.bold', key: 'Mod-b', run: toggleBold },
  { id: 'format.italic', key: 'Mod-i', run: toggleItalic },
  { id: 'format.highlight', key: 'Mod-u', run: toggleHighlight },
  { id: 'format.strike', key: 'Mod-Shift-x', run: toggleStrike },
  { id: 'format.h1', key: 'Mod-1', run: setHeading(1) },
  { id: 'format.h2', key: 'Mod-2', run: setHeading(2) },
  { id: 'format.h3', key: 'Mod-3', run: setHeading(3) },
  { id: 'format.h4', key: 'Mod-4', run: setHeading(4) },
  { id: 'format.h5', key: 'Mod-5', run: setHeading(5) },
  { id: 'format.h6', key: 'Mod-6', run: setHeading(6) },
  { id: 'format.paragraph', key: 'Mod-0', run: setHeading(0) },
  /* Вторые сочетания — те, что доживают до страницы в браузере. */
  { id: 'format.h1.alt', key: 'Mod-Shift-1', run: setHeading(1) },
  { id: 'format.h2.alt', key: 'Mod-Shift-2', run: setHeading(2) },
  { id: 'format.h3.alt', key: 'Mod-Shift-3', run: setHeading(3) },
  { id: 'format.h4.alt', key: 'Mod-Shift-4', run: setHeading(4) },
  { id: 'format.h5.alt', key: 'Mod-Shift-5', run: setHeading(5) },
  { id: 'format.h6.alt', key: 'Mod-Shift-6', run: setHeading(6) },
  { id: 'format.paragraph.alt', key: 'Mod-Shift-0', run: setHeading(0) },
  { id: 'format.bulletList', key: 'Mod-Shift-l', run: toggleBulletList },
  { id: 'format.orderedList', key: 'Mod-Shift-o', run: toggleOrderedList },
  { id: 'format.task', key: 'Mod-Shift-k', run: toggleTaskList },
  { id: 'format.quote', key: 'Mod-Shift-q', run: toggleQuote },
  { id: 'format.codeBlock', key: 'Mod-Shift-c', run: insertCodeBlock },
  { id: 'insert.link', key: 'Mod-l', run: insertLink },
  { id: 'insert.link.alt', key: 'Mod-Alt-l', run: insertLink },
  { id: 'format.orderedList.alt', key: 'Mod-Shift-7', run: toggleOrderedList },
  { id: 'format.bulletList.alt', key: 'Mod-Shift-8', run: toggleBulletList },
  { id: 'insert.wikiLink', key: 'Mod-Shift-w', run: insertWikiLink },
  { id: 'line.duplicate', key: 'Mod-d', run: copyLineDown },
  { id: 'line.moveUp', key: 'Alt-ArrowUp', run: moveLineUp },
  { id: 'line.moveDown', key: 'Alt-ArrowDown', run: moveLineDown },
  { id: 'task.toggle', key: 'Mod-Enter', run: toggleTaskAtCursor },
  { id: 'note.find', key: 'Mod-f', run: openFind },
  { id: 'note.replace', key: 'Mod-h', run: openReplace },
  { id: 'view.raw', key: 'Mod-e', run: toggleRawMode },
  { id: 'view.raw.alt', key: 'Mod-Alt-e', run: toggleRawMode },
  { id: 'note.replace.alt', key: 'Mod-Alt-h', run: openReplace },
  { id: 'view.focus', key: 'Mod-Shift-f', run: toggleFocusMode },
  { id: 'paste.plain', key: 'Mod-Shift-v', run: plainPaste, preventDefault: false },
];

/** Команды без хоткея — только для тулбара и палитры (BEHAVIOR §2.7). */
export const toolbarCommands = {
  cycleHeading,
  insertTable,
  insertDivider,
  insertFootnote,
} as const;

const bindings: KeyBinding[] = [
  ...editorCommands.map(({ key, run, preventDefault }) => ({
    key,
    run,
    preventDefault: preventDefault ?? true,
  })),
  // Enter: код-блок → разделитель → начало размеченной строки → продолжение
  // списка → обычный перевод строки.
  { key: 'Enter', run: completeFencedCode },
  { key: 'Enter', run: completeDivider },
  /* В простом режиме разметка блока спрятана, и «начало строки» на экране —
     это позиция после неё. Обычный перевод строки оставлял бы `# ` сверху и
     превращал заголовок в обычный текст на глазах у человека, который ничего
     такого не просил (см. `input/block-start.ts`). */
  { key: 'Enter', run: enterAtBlockStart },
  { key: 'Enter', run: listNewline },
  // Tab: сперва принять подсказку, потом вложенность списка (до 6 уровней).
  { key: 'Tab', run: acceptCompletion },
  { key: 'Tab', run: indentListItem },
  { key: 'Shift-Tab', run: dedentListItem },
  // Backspace в начале элемента списка снимает маркер, не удаляя строку.
  { key: 'Backspace', run: listBackspace },
];

/**
 * `Prec.high` обязателен: иначе `Mod-Shift-k` из стандартной раскладки
 * (удалить строку) перехватит наш чекбокс, а `Enter` уйдёт в отступы.
 */
export const zapiskiKeymap: Extension = Prec.high(keymap.of(bindings));
