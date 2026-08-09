/**
 * Виджеты live-preview.
 *
 * Оба виджета — ДОБАВОЧНЫЕ (`Decoration.widget`), ни один ничего не заменяет.
 * `Decoration.replace()` в этом пакете не используется нигде: он схлопывает
 * символы и двигает текст, а BEHAVIOR §2.1 это прямо запрещает.
 *
 * - `TaskBoxWidget` — квадрат чекбокса. Ширина виджета нулевая, сам квадрат
 *   позиционируется абсолютно поверх сырого `[ ]`, поэтому поток текста
 *   не меняется вообще (SCREENS §4: 18×18, радиус 6).
 * - `ImageWidget` — превью картинки. Ставится в конец строки и рисуется
 *   блоком, то есть добавляет высоту, но не сдвигает ни одного символа
 *   по горизонтали (BEHAVIOR §2.6: max-width колонки, радиус 12).
 */

import { WidgetType } from '@codemirror/view';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Квадрат чекбокса с галочкой, рисуемой через `stroke-dashoffset` (BEHAVIOR §2.3). */
export class TaskBoxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  override eq(other: TaskBoxWidget): boolean {
    return other.checked === this.checked;
  }

  override toDOM(): HTMLElement {
    const host = document.createElement('span');
    host.className = 'cm-z-taskbox' + (this.checked ? ' cm-z-taskbox-checked' : '');
    host.setAttribute('aria-hidden', 'true');

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 18 18');
    svg.setAttribute('role', 'presentation');

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', '0.75');
    rect.setAttribute('y', '0.75');
    rect.setAttribute('width', '16.5');
    rect.setAttribute('height', '16.5');
    rect.setAttribute('rx', '6');

    const check = document.createElementNS(SVG_NS, 'path');
    check.setAttribute('d', 'M4.4 9.3 L7.5 12.4 L13.6 5.9');

    svg.appendChild(rect);
    svg.appendChild(check);
    host.appendChild(svg);
    return host;
  }

  /** Клик по квадрату обрабатываем сами — курсор при этом не двигается. */
  override ignoreEvent(): boolean {
    return true;
  }
}

/** Инлайн-превью изображения (BEHAVIOR §2.6). */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-z-image-wrap';
    wrap.setAttribute('aria-hidden', 'true');

    const img = document.createElement('img');
    img.className = 'cm-z-image';
    img.src = this.src;
    img.alt = this.alt;
    img.loading = 'lazy';
    img.draggable = false;
    // Ошибка загрузки не блокирует ввод (ARCHITECTURE §3.9): показываем
    // спокойный инлайн-плейсхолдер вместо «битой» иконки браузера.
    img.addEventListener('error', () => {
      const stub = document.createElement('span');
      stub.className = 'cm-z-image-missing';
      stub.textContent = this.alt || this.src;
      img.replaceWith(stub);
    });

    wrap.appendChild(img);
    return wrap;
  }

  override get estimatedHeight(): number {
    return -1;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}
