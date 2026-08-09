/**
 * Виджеты и плитка Quick Settings — половина оболочки (BEHAVIOR §8).
 *
 * Как это работает целиком:
 *
 *   приложение → `publishWidgetSnapshot()` → Rust пишет `widgets.json` в
 *   приватный каталог → Kotlin-провайдеры перерисовывают виджеты **по факту
 *   изменения данных, а не по таймеру** (прямое требование §8).
 *
 *   тап по чекбоксу в виджете → Kotlin кладёт команду в очередь и сразу
 *   перерисовывает виджет (пользователь видит отметку мгновенно) → приложение
 *   забирает команду через `onWidgetCommand()` и применяет её к `.md`.
 *
 * ⚠️ **Последняя миля упирается в контракт.** В `AppHost`
 * (`packages/app/src/contract.ts`) нет порта виджетов, поэтому позвать
 * `publishWidgetSnapshot()` приложению сейчас нечем. Оболочка делает всё, что
 * может сделать оболочка: механизм готов, формат данных описан здесь и в
 * `android/.../widget/WidgetData.kt`. Вторая половина — поле в `AppHost`
 * (ARCHITECTURE §1: «не хватает порта — добавляется порт, а не экран»).
 * Рисовать содержимое виджета в оболочке нельзя: заголовок заметки, порядок
 * «последних» и разбор чекбоксов — продуктовая логика, она живёт в ядре.
 *
 * Пока порта нет, виджеты показывают своё пустое состояние («Пока нет
 * заметок»), а не выдуманные данные.
 */
import { COMMANDS, EVENTS, call, on } from './ipc';

/** Одна строка виджета «Последние» (до 4 штук, §8). */
export interface WidgetRecentNote {
  id: string;
  /** Заголовок заметки. У зашифрованной — пустой: содержимое не раскрывается. */
  title: string;
  /** Дата в том виде, в каком её показывает список (моно, §8). */
  date: string;
  encrypted: boolean;
}

/** Строка закреплённой заметки: обычная или чекбокс. */
export interface WidgetPinnedLine {
  text: string;
  /** Строка — чекбокс `- [ ]` / `- [x]`. */
  todo: boolean;
  checked: boolean;
  /** Порядковый номер чекбокса в заметке — им адресуется команда. */
  todoIndex: number;
}

export interface WidgetPinnedNote {
  id: string;
  title: string;
  /** Первые ~6 строк (§8). */
  lines: WidgetPinnedLine[];
}

export interface WidgetSnapshot {
  /**
   * Акцент в формате `#RRGGBB` — виджет живёт в процессе лаунчера и токенов
   * CSS не видит. Значение берётся из вычисленного стиля (`readAccentColor`),
   * а не из литерала: инвариант «ни одного hex вне токенов» соблюдён.
   */
  accent: string;
  recent: WidgetRecentNote[];
  /** Закреплённая заметка для виджета 2×2. Зашифрованную выбрать нельзя (§8). */
  pinned: WidgetPinnedNote | null;
}

/** Команда, пришедшая из виджета. Пока это только отметка чекбокса. */
export interface WidgetCommand {
  kind: 'toggle-todo';
  noteId: string;
  todoIndex: number;
  checked: boolean;
  /** Когда пользователь нажал — миллисекунды epoch. */
  at: number;
}

/** Отдать виджетам новое состояние. Вызывается при изменении данных. */
export function publishWidgetSnapshot(snapshot: WidgetSnapshot): Promise<void> {
  return call<void>(COMMANDS.widgetsPublish, { snapshot });
}

/**
 * Подписка на команды из виджетов. Как и share-target, забирает накопившееся:
 * тап по чекбоксу мог случиться, когда приложение не работало.
 */
export function onWidgetCommand(handler: (command: WidgetCommand) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;

  void on<WidgetCommand>(EVENTS.widgetCommand, (command) => {
    if (!disposed) handler(command);
  }).then((stop) => {
    if (disposed) stop();
    else unlisten = stop;
  });

  void call<WidgetCommand[]>(COMMANDS.widgetsTakeCommands)
    .then((pending) => {
      if (disposed) return;
      for (const command of pending) handler(command);
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Текущий акцент как `#RRGGBB` — читается из применённых токенов темы.
 * Возвращает `null`, если токен ещё не применён: лучше не перерисовать виджет,
 * чем перерисовать его чужим цветом.
 */
export function readAccentColor(): string | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return raw.length === 0 ? null : raw;
}
