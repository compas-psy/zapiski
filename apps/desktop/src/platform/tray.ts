/**
 * Иконка в трее (ТЗ §5.4).
 *
 * Меню строит Rust (`src-tauri/src/tray.rs`) — иначе иконка появлялась бы
 * только после загрузки бандла. Отсюда едут подписи: каталоги строк живут в
 * TypeScript, и дублировать их в Rust значило бы завести второй источник
 * правды для перевода.
 *
 * Пункт «Запускать при входе в систему» — переключатель автозапуска, по
 * умолчанию **выключенный**: галка отражает фактическое состояние в реестре,
 * и никто её сам не ставит.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { PlatformStrings } from './strings';

/** События из `src-tauri/src/platform.rs`. */
const EVENT_QUICK_NOTE = 'zapiski://quick-note';
const EVENT_OPEN_FILE = 'zapiski://open-file';

export async function initTray(strings: PlatformStrings): Promise<void> {
  await invoke('tray_init', {
    labels: {
      quickNote: strings.tray.quickNote,
      open: strings.tray.open,
      autostart: strings.tray.autostart,
      quit: strings.tray.quit,
      tooltip: strings.tray.tooltip,
    },
  });
}

/**
 * Подписка на «быструю заметку» из трея.
 *
 * ⚠️ В `AppHost` порта для этого пока нет: событие доходит, но передать его
 * приложению контрактом нечем. Оболочка делает свою половину — поднимает окно
 * (это уже сделал Rust) и доставляет событие; вторая половина — поле в
 * `AppHost` (ARCHITECTURE §1: «не хватает порта — добавляется порт, а не
 * экран»). До тех пор обработчик пустой, и это видно, а не спрятано.
 */
export function onQuickNote(handler: () => void): Promise<UnlistenFn> {
  return listen(EVENT_QUICK_NOTE, () => handler());
}

/**
 * Подписка на открытие `.md` из проводника (ассоциация файлов, ТЗ §5.4).
 *
 * ⚠️ Та же история: порта в `AppHost` нет. Ассоциация регистрируется
 * установщиком, путь долетает до фронтенда, дальше нужен контракт.
 */
export function onOpenFile(handler: (paths: string[]) => void): Promise<UnlistenFn> {
  return listen<string[]>(EVENT_OPEN_FILE, (event) => handler(event.payload));
}
