/**
 * Автосохранение (BEHAVIOR §0, ARCHITECTURE §3.7).
 *
 * Debounce 500 мс после последнего кейстрока + принудительно на blur.
 * Слова «Сохранить» в UI нет нигде — наружу уходит только колбэк `onSave`.
 *
 * Композиция IME не мешает сохранению: сохраняем текст как есть, декорации к
 * этому отношения не имеют.
 */

import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { editorRuntime } from '../runtime.js';

/** Задержка автосохранения из BEHAVIOR §0. */
export const AUTOSAVE_DEBOUNCE_MS = 500;

class Autosave {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    if (!update.docChanged) return;
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /** Принудительное сохранение: blur, сворачивание, уход с экрана. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.view.state.facet(editorRuntime).save(this.view.state.doc.toString());
  }

  destroy(): void {
    this.flush();
  }
}

const autosavePlugin = ViewPlugin.fromClass(Autosave, {
  eventHandlers: {
    blur(this: Autosave) {
      this.flush();
      return false;
    },
  },
});

/** Немедленно записать текущий текст (навигация назад, закрытие приложения). */
export function flushAutosave(view: EditorView): void {
  view.plugin(autosavePlugin)?.flush();
}

export const autosave: Extension = [autosavePlugin];
