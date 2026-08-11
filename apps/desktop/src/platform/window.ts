/**
 * Управление окном для своей строки заголовка (ITERATION-1 §6).
 *
 * Окно безрамочное (`decorations: false` в `tauri.conf.json`), поэтому
 * сворачивание, разворачивание и закрытие лежат на нас. Порт нужен затем же,
 * зачем и остальные: `packages/app` не знает, в какой оболочке он запущен, и
 * `@tauri-apps/*` в нём не импортируется никогда (ARCHITECTURE §1).
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { WindowControls } from '@zapiski/core';

export function createWindowControls(): WindowControls {
  const win = getCurrentWindow();
  return {
    async minimize() {
      await win.minimize();
    },
    async toggleMaximize() {
      await win.toggleMaximize();
    },
    async close() {
      /* `close`, а не `destroy`: закрытие должно пройти штатным путём, чтобы
         сработали слушатели и несохранённое успело лечь на диск. */
      await win.close();
    },
    async isMaximized() {
      return win.isMaximized();
    },
    onMaximizeChange(handler) {
      /* Окно разворачивают не только нашей кнопкой: двойным кликом по полосе,
         перетаскиванием к верхней кромке, Win+↑. Без подписки средняя кнопка
         показывала бы прошлое состояние. */
      let disposed = false;
      let off: (() => void) | null = null;
      void win
        .onResized(() => {
          void win.isMaximized().then((value) => {
            if (!disposed) handler(value);
          });
        })
        .then((unlisten) => {
          if (disposed) unlisten();
          else off = unlisten;
        });
      return () => {
        disposed = true;
        off?.();
      };
    },
  };
}
