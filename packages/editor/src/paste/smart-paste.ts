/**
 * Умная вставка (BEHAVIOR §2.1).
 *
 * - HTML из буфера → markdown;
 * - картинка из буфера → колбэк наружу (копирование в `attachments/`) и
 *   вставка `![](attachments/…)` (BEHAVIOR §2.6);
 * - ссылка поверх выделенного текста оборачивает его в `[текст](url)`;
 * - обычный текст вставляется как есть;
 * - Ctrl+Shift+V — без форматирования.
 *
 * Ошибка вставки картинки никогда не блокирует ввод (ARCHITECTURE §3.9):
 * редактор просто ничего не вставляет, а тост из реестра §11 показывает
 * приложение — оно же владеет операцией копирования файла.
 */

import { EditorSelection } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Command } from '@codemirror/view';
import { editorRuntime } from '../runtime.js';
import { htmlToMarkdown } from './html-to-markdown.js';

/** Ссылка целиком, без пробелов внутри. */
const URL_ONLY = /^(https?:\/\/|mailto:|obsidian:\/\/|zapiski:\/\/)\S+$/i;

/**
 * Ctrl+Shift+V успевает поставить метку до того, как браузер выстрелит `paste`.
 * Окно в 600 мс с запасом покрывает даже медленную обработку буфера.
 */
const PLAIN_WINDOW_MS = 600;
let plainPasteUntil = 0;

/** Ctrl+Shift+V — вставить без форматирования. */
export const plainPaste: Command = () => {
  plainPasteUntil = Date.now() + PLAIN_WINDOW_MS;
  // Возвращаем false: саму вставку выполняет браузер, мы только пометили режим.
  return false;
};

function insertText(view: EditorView, text: string): void {
  const tr = view.state.changeByRange((range) => ({
    changes: { from: range.from, to: range.to, insert: text },
    range: EditorSelection.cursor(range.from + text.length),
  }));
  view.dispatch(view.state.update(tr, { scrollIntoView: true, userEvent: 'input.paste' }));
}

function firstImage(data: DataTransfer): File | null {
  const files = data.files;
  for (let i = 0; i < files.length; i++) {
    const file = files.item(i);
    if (file && file.type.startsWith('image/')) return file;
  }
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    if (item && item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

export const smartPaste: Extension = EditorView.domEventHandlers({
  paste(event: ClipboardEvent, view: EditorView) {
    const data = event.clipboardData;
    if (!data) return false;
    const runtime = view.state.facet(editorRuntime);
    const plain = Date.now() < plainPasteUntil;
    plainPasteUntil = 0;

    // ── Картинка ────────────────────────────────────────────────────────────
    const image = firstImage(data);
    if (image) {
      event.preventDefault();
      void runtime.pasteImage(image).then((path) => {
        if (!path) return;
        insertText(view, `![](${path})`);
      });
      return true;
    }

    const text = data.getData('text/plain');

    // ── Ссылка поверх выделения ─────────────────────────────────────────────
    if (text && URL_ONLY.test(text.trim())) {
      const range = view.state.selection.main;
      if (!range.empty) {
        event.preventDefault();
        const label = view.state.sliceDoc(range.from, range.to);
        const insert = `[${label}](${text.trim()})`;
        view.dispatch({
          changes: { from: range.from, to: range.to, insert },
          selection: { anchor: range.from + insert.length },
          scrollIntoView: true,
          userEvent: 'input.paste',
        });
        return true;
      }
    }

    if (plain) {
      if (!text) return false;
      event.preventDefault();
      insertText(view, text);
      return true;
    }

    // ── HTML → markdown ─────────────────────────────────────────────────────
    const html = data.getData('text/html');
    if (html) {
      const markdown = htmlToMarkdown(html);
      if (markdown && markdown !== text.trim()) {
        event.preventDefault();
        insertText(view, markdown);
        return true;
      }
    }

    // Обычный текст — как есть, стандартным обработчиком CodeMirror.
    return false;
  },
});
