/**
 * Внешние зависимости редактора.
 *
 * Редактор НЕ ходит в `@zapiski/core` сам (ARCHITECTURE §5): всё, что ему нужно
 * знать о хранилище, индексе, тегах и хэптике, приходит снаружи — пропсами
 * React-компонента или фасетом для тех, кто собирает CodeMirror вручную.
 */

import { Facet } from '@codemirror/state';
import type { HapticStrength } from './contract-types.js';

/** Подсказка тега для автодополнения (BEHAVIOR §2.4). */
export interface TagSuggestion {
  /** Вложенный тег целиком: `практика/супервизия`. */
  tag: string;
  /** Частота использования — по ней сортируется список. */
  count: number;
}

/** Подсказка заметки для `[[wiki]]` (BEHAVIOR §2.5). */
export interface NoteSuggestion {
  /** Заголовок заметки — то, что подставляется в `[[…]]`. */
  title: string;
  /** Путь для подписи в списке; необязателен. */
  path?: string;
}

/**
 * Всё, что редактор просит у приложения. Реализация живёт в `packages/app`,
 * редактор получает готовый объект и никогда не создаёт его сам.
 */
export interface EditorRuntime {
  /**
   * Есть ли заметка с таким заголовком. `false` → ссылка «висячая»
   * (BEHAVIOR §2.5: акцент + пунктир 50% opacity).
   */
  wikiExists(target: string): boolean;
  /** Кандидаты тегов по префиксу. Сортировку по частоте делает редактор. */
  tags(prefix: string): TagSuggestion[];
  /** Кандидаты заметок по fuzzy-запросу. */
  notes(query: string): NoteSuggestion[];
  /** Хэптика (BEHAVIOR §0): лёгкая на отметке чекбокса. */
  haptic(strength: HapticStrength): void;
  /** Автосохранение (BEHAVIOR §0): debounce 500 мс + blur. */
  save(text: string): void;
  /**
   * Картинка из буфера обмена (BEHAVIOR §2.6): приложение копирует файл в
   * `attachments/` и возвращает путь вида `attachments/2026-08-09_ab12.png`.
   * `null` — не удалось, редактор покажет инлайн-ошибку из реестра §11.
   */
  pasteImage(file: File): Promise<string | null>;
  /** Тап по существующей wiki-ссылке. `aside` — Ctrl+клик / long-press. */
  openWikiLink(target: string, mode: 'same' | 'aside'): void;
  /** Тап по висячей wiki-ссылке — предложение «Создать заметку „Имя“». */
  createNote(title: string): void;
  /** Тап по тегу в тексте — поиск по этому тегу (BEHAVIOR §2.4). */
  openTag(tag: string): void;
  /** `attachments/…` → URL, который можно поставить в `src` картинки. */
  resolveAttachment(src: string): string | null;
  /**
   * Объём вложения человекочитаемой строкой («96 КБ») — для карточки файла
   * (ITERATION-1 §5). Пустая строка, пока байты не прочитаны: карточка тогда
   * просто без размера, а не с нулём.
   *
   * Форматированием занимается приложение, а не редактор: единицы измерения
   * склоняются, и каталог строк живёт там.
   */
  attachmentSize(src: string): string;
  /**
   * Тап по вложению в тексте (ITERATION-1 §5): картинка — полноэкранный
   * просмотр, файл — системное приложение. Что именно делать, решает
   * приложение: редактор не знает ни про оболочку, ни про просмотрщик.
   */
  openAttachment(src: string): void;

  /**
   * Свернуть/развернуть блок `<details>`, начинающийся в этой позиции.
   *
   * Живёт в рантайме, а не в виджете, потому что виджет не имеет доступа к
   * представлению: он получает готовый обработчик и только зовёт его.
   */
  toggleCollapsed(at: number): void;
}

/** Заглушка: редактор полностью работоспособен и без приложения вокруг. */
export const noopRuntime: EditorRuntime = {
  wikiExists: () => false,
  tags: () => [],
  notes: () => [],
  haptic: () => {},
  save: () => {},
  pasteImage: async () => null,
  openWikiLink: () => {},
  createNote: () => {},
  openTag: () => {},
  resolveAttachment: () => null,
  attachmentSize: () => '',
  openAttachment: () => {},
  toggleCollapsed: () => {},
};

/**
 * Фасет с рантаймом. Значение — стабильный объект на всё время жизни редактора;
 * React-обёртка обновляет его поля через ref, чтобы не переконфигурировать
 * состояние на каждый рендер.
 */
export const editorRuntime = Facet.define<EditorRuntime, EditorRuntime>({
  combine: (values) => values[0] ?? noopRuntime,
  static: true,
});
