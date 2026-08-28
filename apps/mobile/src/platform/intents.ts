/**
 * Намерения ОС: плитка Quick Settings и виджет «Записать» 1×1 (BEHAVIOR §8).
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Порт `AppHost.onIntent` был объявлен в контракте и не реализован НИ С ОДНОЙ
 * стороны. Событие от плитки доезжало до `main.tsx` и упиралось в обработчик с
 * комментарием «намеренно пусто». То есть плитка в шторке и виджет на рабочем
 * столе, которые в системе выглядели рабочими, не делали ничего: человек
 * нажимал и получал просто запущенное приложение — без заметки, без листа, без
 * объяснения.
 *
 * ── Две дороги, и обе нужны ─────────────────────────────────────────────────
 *
 * Та же развилка, что у возврата после входа и у «Поделиться»:
 *
 *   · приложение уже работает — приходит событие;
 *   · приложение поднимается с нуля — событие уходит в пустоту, потому что
 *     фронтенд ещё не подписан. Поэтому Rust держит его в очереди и выдаёт по
 *     запросу (`platform::flush_quick_note` взводит её после открытия
 *     хранилища).
 *
 * Подписка сама забирает накопленное: иначе первое же нажатие на холодном
 * старте — самый частый случай для плитки — терялось бы.
 *
 * Оболочка решает только «как нажали». ЧТО показать, решает продукт
 * (`packages/app/src/App.tsx`): лист быстрой записки, редактор или что-то
 * ещё — это продуктовое поведение, и знать про него оболочке нечем
 * (ARCHITECTURE §1).
 */
import type { AppIntent } from '@zapiski/app';

import { COMMANDS, EVENTS, call, on } from './ipc';

/**
 * Намерение холодного старта.
 *
 * Отдельной команды «забрать намерение» в Rust нет для плитки/виджета:
 * очередь быстрой заметки взводится событием сразу после открытия
 * хранилища, и подписка ниже его получает. Функция оставлена, чтобы контракт
 * был реализован целиком и чтобы появление такой команды не требовало правок
 * в `packages/app`.
 *
 * Ассоциация `.md` (ниже, в `onIntent`) устроена иначе — холодный старт там
 * не ждёт открытия хранилища, а забирает очередь сам, той же дорогой, что и
 * `share_take()`.
 */
export async function takeInitialIntent(): Promise<AppIntent | null> {
  return null;
}

/** Намерения в уже запущенное приложение. Возвращает отписку. */
export function onIntent(handler: (intent: AppIntent) => void): () => void {
  let disposed = false;
  const stops: Array<() => void> = [];

  const listen = <T>(event: string, toIntent: (payload: T) => AppIntent | null): void => {
    void on<T>(event, (payload) => {
      if (disposed) return;
      const intent = toIntent(payload);
      if (intent !== null) handler(intent);
    }).then((stop) => {
      if (disposed) stop();
      else stops.push(stop);
    });
  };

  /* Плитка и виджет «Записать» — одно намерение. Папку они не выбирают: выбор
     папки живёт на самом листе, где человек его и видит. */
  listen<null>(EVENTS.quickNote, () => ({ kind: 'new-note' }));

  /*
   * Ассоциация `.md`: «Открыть с помощью» из файлового менеджера (ТЗ §5.4).
   * Папку для файла спрашивает `packages/app` (`App.tsx`) тем же диалогом,
   * что и на Windows — здесь только путь.
   */
  listen<string>(EVENTS.openFile, (path) => ({ kind: 'open-file', path }));

  /*
   * Холодный старт: путь, оставленный до запуска, лежит в очереди — та же
   * развилка, что у share-target (`share.ts`, `share_take()`). Без этого
   * забора «Открыть с помощью» на остановленном приложении поднимало бы
   * ЗАПИСКИ и ничего не показывало.
   */
  void call<string[]>(COMMANDS.openFileTake)
    .then((pending) => {
      if (disposed) return;
      for (const path of pending) handler({ kind: 'open-file', path });
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    for (const stop of stops) stop();
    stops.length = 0;
  };
}

/**
 * Байты файла ассоциации — уже наши, в приватном каталоге приложения
 * (`OpenFileActivity` скопировал их из `content://`). Обычный файловый read,
 * а не SAF: путь снаружи vault'а, но не снаружи нашего приложения.
 */
export async function readOpenedFile(path: string): Promise<Uint8Array | null> {
  const bytes = await call<number[] | null>(COMMANDS.readOpenedFile, { path });
  return bytes ? Uint8Array.from(bytes) : null;
}
