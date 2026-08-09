/**
 * Кто сейчас держит текст: ссылка на живой `<Editor/>` открытой заметки.
 *
 * Нужна палитре команд и хоткеям оболочки: команды текста живут в
 * `editorCommands` (`@zapiski/editor`) и выполняются над `EditorView`, а
 * палитра — отдельный экран и своего представления не имеет.
 *
 * Регистр намеренно один на приложение: заметка открыта ровно одна, даже в
 * трёхпанельной раскладке (SCREENS «Каркас»).
 */
import type { EditorHandle } from '@zapiski/editor';

let active: EditorHandle | null = null;

/** Вызывается экраном заметки на монтировании и размонтировании. */
export function setActiveEditor(handle: EditorHandle | null): void {
  active = handle;
}

export function activeEditor(): EditorHandle | null {
  return active;
}

/** Сохранить немедленно: навигация назад, сворачивание, закрытие (BEHAVIOR §0). */
export function flushActiveEditor(): void {
  active?.save();
}
