/**
 * Управление окном для своей строки заголовка (ITERATION-1 §6).
 *
 * На Windows окно безрамочное — рамки снимает `set_decorations(false)` в
 * `lib.rs`, потому что в конфиге одно значение на две системы держать нельзя.
 * Значит сворачивание, разворачивание и закрытие лежат на нас. На macOS их
 * рисует система, и порт об этом честно сообщает полем `chrome`.
 *
 * Порт нужен затем же, зачем и остальные: `packages/app` не знает, в какой
 * оболочке он запущен, и `@tauri-apps/*` в нём не импортируется никогда
 * (ARCHITECTURE §1).
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { WindowControls } from '@zapiski/core';

import type { HostOs } from './os';

/**
 * Ширина «светофора» macOS.
 *
 * Три кнопки по 12 pt с шагом 20 pt, начиная от 20 pt от края: правый край
 * последней приходится на 72 pt. До 78 округляем сознательно — вплотную к
 * кнопке ставить нечего, а лишние шесть точек читаются как поле.
 */
const MACOS_TRAFFIC_LIGHTS = 78;

export function createWindowControls(os: HostOs): WindowControls {
  const win = getCurrentWindow();
  const native = os === 'macos';
  return {
    /* На macOS кнопки рисует система (`titleBarStyle: Overlay` в конфиге), и
       свои рядом были бы вторым комплектом. Убрать системные нельзя:
       `decorations: false` уносит их вместе с полосой, и окно перестаёт
       закрываться мышью. */
    chrome: native ? 'native-overlay' : 'custom',
    inlineStartInset: native ? MACOS_TRAFFIC_LIGHTS : 0,
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
