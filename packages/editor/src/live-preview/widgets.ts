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

  /**
   * `false`, а не `true`, — и это не мелочь.
   *
   * CodeMirror при `true` вообще не пропускает событие в свой конвейер:
   * `eventBelongsToEditor` идёт от цели вверх и на первом же виджете с
   * «игнорировать» возвращает `false`. Значит, до `domEventHandlers` дело не
   * доходит — а тап по квадрату разбирает как раз наш обработчик
   * (`markupInteractions`). С `true` квадрат молча не нажимался: на телефоне
   * он и есть основная цель, отмечать задачу было нечем.
   *
   * Курсор при этом не прыгает: обработчик зовёт `preventDefault` и
   * возвращает `true`, то есть своей обработки CodeMirror не делает.
   */
  override ignoreEvent(): boolean {
    return false;
  }
}

/** Инлайн-превью изображения (BEHAVIOR §2.6). */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    /**
     * Путь, как он написан в тексте. Нужен для тапа: полноэкранный просмотр
     * открывает приложение, а оно знает про вложения по пути, а не по
     * `blob:`-адресу, который живёт только внутри кэша (ITERATION-1 §5).
     */
    readonly path = '',
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.path === this.path;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-z-image-wrap';
    wrap.setAttribute('aria-hidden', 'true');

    const img = document.createElement('img');
    img.className = 'cm-z-image';
    img.src = this.src;
    img.alt = this.alt;
    if (this.path !== '') img.dataset['zSrc'] = this.path;
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

  /** Тап уходит в `markupInteractions` — см. объяснение у `TaskBoxWidget`. */
  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Карточка файла (ITERATION-1 §5).
 *
 * До этого документ, вставленный в заметку, оставался голой ссылкой
 * `[](attachments/договор.pdf)` — то есть выглядел как опечатка. Карточка
 * говорит три вещи, которых не хватало: что это файл, какого он типа и
 * сколько весит.
 *
 * Размер приходит снаружи: сам виджет в хранилище не ходит — он живёт внутри
 * пересчёта декораций, а тот обязан укладываться в кадр.
 */
export class FileWidget extends WidgetType {
  constructor(
    /** Путь, как он написан в тексте: его и открывает оболочка. */
    readonly path: string,
    readonly name: string,
    /** Человекочитаемый объём или пустая строка, если ещё не известен. */
    readonly size: string,
    readonly onOpen: (path: string) => void,
  ) {
    super();
  }

  override eq(other: FileWidget): boolean {
    return other.path === this.path && other.name === this.name && other.size === this.size;
  }

  override toDOM(): HTMLElement {
    const card = document.createElement('span');
    card.className = 'cm-z-file';
    card.dataset['zSrc'] = this.path;

    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('class', 'cm-z-file__icon');
    icon.setAttribute('aria-hidden', 'true');
    const sheet = document.createElementNS(SVG_NS, 'path');
    sheet.setAttribute('d', 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z');
    const fold = document.createElementNS(SVG_NS, 'path');
    fold.setAttribute('d', 'M14 3v5h5');
    icon.append(sheet, fold);

    const name = document.createElement('span');
    name.className = 'cm-z-file__name';
    name.textContent = this.name;

    card.append(icon, name);
    if (this.size !== '') {
      const size = document.createElement('span');
      size.className = 'cm-z-file__size';
      size.textContent = this.size;
      card.appendChild(size);
    }

    /* Клик открывает файл системным приложением — этим занимается оболочка. */
    card.addEventListener('mousedown', (event) => {
      event.preventDefault();
      this.onOpen(this.path);
    });
    return card;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Мини-плеер аудио (ITERATION-1 §5, COMPONENTS §8).
 *
 * Стандартный `<audio controls>` не годится: его рисует система, и он выглядит
 * чужим в каждой из трёх оболочек по-своему. Здесь ровно то, что нужно, —
 * кнопка, полоса и длительность.
 *
 * Виджет не грузит файл заранее: `preload="metadata"` даёт длительность, не
 * вытягивая в память сам звук. Заметка с десятком записей иначе тянула бы
 * десяток файлов при открытии.
 */
export class AudioWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly name: string,
  ) {
    super();
  }

  override eq(other: AudioWidget): boolean {
    return other.src === this.src;
  }

  override toDOM(): HTMLElement {
    const host = document.createElement('span');
    host.className = 'cm-z-audio';

    const audio = document.createElement('audio');
    audio.src = this.src;
    audio.preload = 'metadata';

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'cm-z-audio__play';
    play.setAttribute('aria-label', this.name);
    play.textContent = '▶';

    const track = document.createElement('span');
    track.className = 'cm-z-audio__track';
    const fill = document.createElement('span');
    fill.className = 'cm-z-audio__fill';
    track.appendChild(fill);

    const time = document.createElement('span');
    time.className = 'cm-z-audio__time';
    time.textContent = '--:--';

    const clock = (seconds: number): string => {
      if (!Number.isFinite(seconds)) return '--:--';
      const whole = Math.floor(seconds);
      return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
    };

    audio.addEventListener('loadedmetadata', () => {
      time.textContent = clock(audio.duration);
    });
    audio.addEventListener('timeupdate', () => {
      const ratio = audio.duration > 0 ? audio.currentTime / audio.duration : 0;
      fill.style.inlineSize = `${Math.round(ratio * 100)}%`;
      time.textContent = clock(audio.duration - audio.currentTime);
    });
    audio.addEventListener('ended', () => {
      play.textContent = '▶';
      fill.style.inlineSize = '0%';
    });

    play.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (audio.paused) {
        void audio.play();
        play.textContent = '■';
      } else {
        audio.pause();
        play.textContent = '▶';
      }
    });

    host.append(play, track, time, audio);
    return host;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Стрелка сворачиваемого блока (замечание 12).
 *
 * Заказчик: «сворачиваемый блок в принципе не работает, а просто выдаёт xml,
 * заполняя который ничего не происходит». В файле блок остаётся честным
 * `<details><summary>` — так его понимают GitHub, Obsidian и любой браузер, —
 * а на экране от него остаётся заголовок со стрелкой, и он сворачивается.
 *
 * `ignoreEvent` возвращает `false`, иначе CodeMirror не пропустит нажатие в
 * свой конвейер и стрелка окажется мёртвой: `eventBelongsToEditor` идёт от
 * цели вверх и на первом же виджете с «игнорировать» возвращает `false`.
 */
export class SummaryWidget extends WidgetType {
  constructor(
    readonly collapsed: boolean,
    readonly at: number,
    readonly onToggle: (at: number) => void,
  ) {
    super();
  }

  override eq(other: SummaryWidget): boolean {
    return other.collapsed === this.collapsed && other.at === this.at;
  }

  override toDOM(): HTMLElement {
    const host = document.createElement('span');
    host.className = 'cm-z-summary-arrow';
    host.setAttribute('aria-hidden', 'true');

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('role', 'presentation');
    const path = document.createElementNS(SVG_NS, 'path');
    /* Треугольник вправо; развёрнутый блок поворачивает его вниз средствами
       CSS — так поворот анимируется и не требует второго виджета. */
    path.setAttribute('d', 'M6 4 L11 8 L6 12 Z');
    svg.appendChild(path);
    host.appendChild(svg);

    if (!this.collapsed) host.classList.add('cm-z-summary-arrow-open');

    host.addEventListener('pointerdown', (event) => {
      /* Нажатие не должно уводить курсор в текст заголовка: человек кликает
         по стрелке, а не ставит каретку. */
      event.preventDefault();
      this.onToggle(this.at);
    });

    return host;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}
