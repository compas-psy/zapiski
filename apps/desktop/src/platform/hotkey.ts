/**
 * Порт `GlobalHotkeyProvider` — глобальный хоткей быстрой заметки
 * (ТЗ §5.4, BEHAVIOR §7: «поверх всех окон», по умолчанию Ctrl+Alt+N,
 * настраиваемый).
 *
 * Сочетание занимается в ОС через `tauri-plugin-global-shortcut` на стороне
 * Rust (`src-tauri/src/hotkey.rs`): плагину не выдано ни одного JS-права,
 * поэтому занять произвольный хоткей из вебвью нельзя — только через команду
 * оболочки. Rust поднимает окно и отправляет событие, а что показать —
 * решает `packages/app`.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { GlobalHotkeyProvider } from '@zapiski/core';

import type { HostOs } from './os';

/** Событие из `src-tauri/src/platform.rs`. Полезная нагрузка — акселератор. */
const EVENT_HOTKEY = 'zapiski://global-hotkey';

/**
 * Умолчание по BEHAVIOR §7 — своё на каждой системе.
 *
 * `CommandOrControl` тут не годится: акселератор показывается человеку в
 * настройках, и «CommandOrControl+Alt+N» — не то, что он ищет глазами на
 * своей клавиатуре. На macOS модификатор называется `Cmd` и стоит первым по
 * тамошней привычке, на Windows — `Ctrl`.
 */
export function defaultHotkey(os: HostOs): string {
  return os === 'macos' ? 'Cmd+Alt+N' : 'Ctrl+Alt+N';
}

export class NativeGlobalHotkey implements GlobalHotkeyProvider {
  private readonly handlers = new Map<string, () => void>();
  private listening: Promise<UnlistenFn> | null = null;
  /**
   * Сочетание, которое оболочка заняла сама при старте (из настроек, иначе
   * умолчание). Как только приложение регистрирует своё — это снимается:
   * два хоткея на одно действие пользователю не обещали.
   */
  private shellDefault: string | null = null;

  async register(accelerator: string, handler: () => void): Promise<void> {
    await this.ensureListening();

    if (this.shellDefault !== null && this.shellDefault !== accelerator) {
      const stale = this.shellDefault;
      this.shellDefault = null;
      await this.unregister(stale);
    }

    this.handlers.set(accelerator, handler);
    try {
      await invoke('hotkey_register', { accelerator });
    } catch (error) {
      /* Сочетание занято другой программой — обработчик не оставляем, иначе
         в настройках он выглядел бы рабочим. Текст ошибки уходит наверх:
         решает, что показать, `packages/app`. */
      this.handlers.delete(accelerator);
      throw error;
    }
  }

  async unregister(accelerator: string): Promise<void> {
    this.handlers.delete(accelerator);
    if (this.shellDefault === accelerator) this.shellDefault = null;
    await invoke('hotkey_unregister', { accelerator });
  }

  /**
   * Занять сочетание из настроек при старте.
   *
   * Нужно потому, что хоткей — свойство ОС, а не открытого окна: он обязан
   * работать сразу после автозапуска в трей, когда `packages/app` ещё ничего
   * не зарегистрировал. Само окно поднимает Rust, поэтому обработчик здесь
   * пустой — оболочка не решает, что показать.
   */
  async bootDefault(accelerator: string): Promise<string | null> {
    try {
      await this.register(accelerator, () => {});
      this.shellDefault = accelerator;
      return accelerator;
    } catch {
      /* Сочетание занято — приложение работает, просто без глобального
         хоткея. Ронять старт из-за этого нельзя. */
      return null;
    }
  }

  private ensureListening(): Promise<UnlistenFn> {
    this.listening ??= listen<string>(EVENT_HOTKEY, (event) => {
      this.handlers.get(event.payload)?.();
    });
    return this.listening;
  }
}
