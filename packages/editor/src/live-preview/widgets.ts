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
import katex from 'katex';
/* Стили KaTeX — обычный файл, а не `StyleModule`: в нём объявления шрифтов,
   и переписывать их своими руками значило бы держать копию чужого пакета.
   Шрифты приезжают в сборку рядом с ним, из сети ничего не грузится. */
import 'katex/dist/katex.min.css';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Формула LaTeX (ITERATION-1 §4).
 *
 * Заказчик: «ты тихой сапой забыл про формулы LaTeX с вводом через виджет».
 * Забыл не совсем — строки и кнопка были готовы, но KaTeX не входил в сборку,
 * и кнопка пряталась. Теперь входит: пакет ставится в бандл, из сети ничего
 * не тянется, и правило «работает в самолёте» цело.
 *
 * `throwOnError: false` — разбор ломается на каждом втором символе, пока
 * формулу набирают, и падать на этом нельзя. KaTeX в таком режиме рисует
 * неразобранный кусок красным, а сообщение мы кладём в подсказку.
 */
export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    /** `$$…$$` — формула отдельной строкой, по центру. */
    readonly block: boolean,
  ) {
    super();
  }

  override eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.block === this.block;
  }

  override toDOM(): HTMLElement {
    const host = document.createElement(this.block ? 'div' : 'span');
    host.className = this.block ? 'cm-z-math cm-z-math-block' : 'cm-z-math';
    try {
      katex.render(this.tex, host, {
        displayMode: this.block,
        throwOnError: false,
        output: 'html',
      });
    } catch (error) {
      /* Сюда попадают только отказы самого KaTeX, а не разбора формулы:
         разбор с `throwOnError: false` не бросает. Показываем исходник — он
         честнее пустого места. */
      host.textContent = this.tex;
      host.title = error instanceof Error ? error.message : String(error);
    }
    return host;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

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
    /** Выделена ли картинка: у выделенной по углам стоят ручки размера. */
    readonly selected = false,
    /** Записать новую ширину в подпись. Ставит её приложение. */
    readonly onResize: (path: string, width: number) => void = () => {},
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.path === this.path &&
      other.selected === this.selected
    );
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-z-image-wrap' + (this.selected ? ' cm-z-image-wrap-sel' : '');
    /*
     * `aria-hidden` только у невыделенной: пока картинка просто показана,
     * её содержимое диктору даёт текст разметки. У выделенной появляются
     * органы управления, и прятать их от клавиатуры и диктора нельзя.
     */
    if (!this.selected) wrap.setAttribute('aria-hidden', 'true');

    const img = document.createElement('img');
    img.className = 'cm-z-image';
    img.src = this.src;
    /*
     * Ширина из подписи: `![подпись|400](путь)` (замечание 2).
     *
     * Это соглашение Obsidian, и взято оно намеренно: в самом markdown
     * размеров нет, а придумывать своё значило бы, что заметка с картинкой
     * читается правильно только у нас. Чужой редактор покажет `|400` частью
     * подписи — некрасиво, но не сломано.
     *
     * Ширина, а не высота: колонка текста узкая, и по ней картинка и
     * масштабируется. Пропорции держит CSS.
     */
    const sized = /^(.*)\|(\d{1,4})$/.exec(this.alt);
    if (sized) {
      img.style.width = `${Math.min(Number(sized[2]), 4000)}px`;
      img.alt = (sized[1] ?? '').trim();
    } else {
      img.alt = this.alt;
    }
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
    if (this.selected) this.addHandles(wrap, img);
    return wrap;
  }

  /**
   * Четыре квадратика по углам — ими и тянут.
   *
   * Меняется ТОЛЬКО ширина: высоту держит пропорция, а «растянуть по одной
   * оси» для фотографии в заметке — не то, чего от неё ждут. Поэтому любая
   * ручка ведёт по горизонтали, а левые считают сдвиг наоборот.
   *
   * Пока тянут, ширина живёт в стиле картинки: документ трогать на каждый
   * пиксель нельзя — это была бы сотня правок в истории и сотня пересчётов
   * разметки. В текст ширина уходит один раз, когда палец отпустили.
   */
  private addHandles(wrap: HTMLElement, img: HTMLImageElement): void {
    const CORNERS = [
      ['nw', -1],
      ['ne', 1],
      ['sw', -1],
      ['se', 1],
    ] as const;

    for (const [corner, direction] of CORNERS) {
      const grip = document.createElement('span');
      grip.className = `cm-z-image-grip cm-z-image-grip-${corner}`;
      grip.dataset['zGrip'] = corner;

      let startX = 0;
      let startWidth = 0;
      let width = 0;

      grip.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        startX = event.clientX;
        startWidth = img.getBoundingClientRect().width;
        width = startWidth;
        grip.setPointerCapture(event.pointerId);
      });
      grip.addEventListener('pointermove', (event) => {
        if (!grip.hasPointerCapture(event.pointerId)) return;
        event.preventDefault();
        /* Нижняя граница 48: картинку меньше уже не ухватить обратно. */
        width = Math.max(48, Math.min(4000, startWidth + (event.clientX - startX) * direction));
        img.style.width = `${Math.round(width)}px`;
      });
      const finish = (event: PointerEvent): void => {
        if (!grip.hasPointerCapture(event.pointerId)) return;
        grip.releasePointerCapture(event.pointerId);
        if (Math.round(width) === Math.round(startWidth)) return;
        this.onResize(this.path, Math.round(width));
      };
      grip.addEventListener('pointerup', finish);
      grip.addEventListener('pointercancel', finish);
      wrap.appendChild(grip);
    }
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
 * название, кнопка, полоса, время и скорость.
 *
 * Заказчик про прежний вид: «пустой аудио-плеер — есть воспроизведение, но
 * нужна длительность и название трека». Оба замечания про одно: плеер не
 * говорил, ЧТО он играет и СКОЛЬКО это длится. Название теперь стоит строкой
 * над полосой (раньше оно было только в `aria-label`, то есть видно лишь
 * экранному диктору), а время печатается как «прошло / всего».
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
    return other.src === this.src && other.name === this.name;
  }

  override toDOM(): HTMLElement {
    const host = document.createElement('span');
    host.className = 'cm-z-audio';

    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = this.src;

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'cm-z-audio__play';
    play.setAttribute('aria-label', this.name);
    play.setAttribute('aria-pressed', 'false');
    play.append(glyph(false));

    const body = document.createElement('span');
    body.className = 'cm-z-audio__body';

    const name = document.createElement('span');
    name.className = 'cm-z-audio__name';
    name.textContent = this.name;
    /* Длинное имя обрезается многоточием, но полное остаётся во всплывающей
       подсказке: у записей с телефона имя длиннее любой колонки текста. */
    name.title = this.name;

    const row = document.createElement('span');
    row.className = 'cm-z-audio__row';

    /* Полоса лежит в обёртке с вертикальным полем: сама она 3 px по §8, а
       попасть пальцем в 3 px нельзя — нажимается обёртка. */
    const seek = document.createElement('span');
    seek.className = 'cm-z-audio__seek';
    const track = document.createElement('span');
    track.className = 'cm-z-audio__track';
    const fill = document.createElement('span');
    fill.className = 'cm-z-audio__fill';
    track.appendChild(fill);
    seek.appendChild(track);

    const time = document.createElement('span');
    time.className = 'cm-z-audio__time';

    const rate = document.createElement('button');
    rate.type = 'button';
    rate.className = 'cm-z-audio__rate';
    rate.textContent = '1×';

    /* Скорость стоит в одной строке со временем, а не сбоку карточки: сбоку
       она висела на десяток пикселей выше цифр и читалась как чужая. */
    row.append(seek, time, rate);
    body.append(name, row);
    host.append(play, body, audio);

    // ─── время ───────────────────────────────────────────────────────────────

    const clock = (seconds: number): string => {
      const whole = Math.max(0, Math.floor(seconds));
      return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
    };

    /*
     * Длительность показывается, только когда она известна.
     *
     * Прежний плеер печатал `--:--` и оставался с ним навсегда, если
     * метаданные не пришли, — ровно то, что заказчик назвал пустым плеером.
     * Теперь неизвестная длительность даёт «0:00», а не прочерки: время
     * воспроизведения известно всегда, и врать про него нечем.
     */
    const known = (): boolean => Number.isFinite(audio.duration) && audio.duration > 0;
    const showTime = (): void => {
      time.textContent = known()
        ? `${clock(audio.currentTime)} / ${clock(audio.duration)}`
        : clock(audio.currentTime);
    };
    const showFill = (): void => {
      const ratio = known() ? audio.currentTime / audio.duration : 0;
      fill.style.inlineSize = `${(Math.min(1, Math.max(0, ratio)) * 100).toFixed(2)}%`;
    };
    showTime();

    /*
     * Добыча длительности, когда её не отдали сразу.
     *
     * Два случая, и оба встречаются на настоящих файлах, а не в теории.
     *
     * 1. В контейнере длительности нет. Так пишут потоковые кодировщики:
     *    голосовое сообщение из мессенджера (ogg/opus) и запись с
     *    `MediaRecorder` приходят с `duration === Infinity`. Приём против
     *    этого один и он общеизвестен: перемотать заведомо за конец —
     *    браузер при этом вынужден досчитать длину и присылает
     *    `durationchange` с настоящим значением, после чего возвращаемся в
     *    начало.
     * 2. Оболочка проигнорировала `preload`. Мобильные webview так делают
     *    ради трафика, и `loadedmetadata` не приходит вовсе, пока не нажмут
     *    «играть». Для нас экономии тут нет никакой: байты уже прочитаны в
     *    память ради `blob:`-адреса. Поэтому, если через 1.2 с не загружено
     *    ничего (`readyState === 0`), просим громче: `preload="auto"` и явный
     *    `load()`.
     *
     *    Честно про доказательства: первый случай воспроизведён в настоящем
     *    Chromium и без перемотки даёт «0:00» вместо «0:00 / 0:07». Второй
     *    отсюда не воспроизводится — своё решение webview принимает сам, и
     *    подделать его со стороны страницы нельзя. Поэтому это защита, а не
     *    доказанное лечение; вреда от неё нет, потому что в здоровом браузере
     *    `readyState` к этому моменту уже не нулевой.
     */
    let probing = false;
    const seekProbe = (): void => {
      if (probing || known()) return;
      probing = true;
      try {
        audio.currentTime = 1e101;
      } catch {
        /* Некоторые движки отказываются перематывать до метаданных — тогда
           длительность просто останется неизвестной, и это честнее прочерков. */
        probing = false;
      }
    };

    audio.addEventListener('loadedmetadata', () => {
      seekProbe();
      showTime();
    });
    audio.addEventListener('durationchange', () => {
      if (probing && known()) {
        probing = false;
        audio.currentTime = 0;
      }
      showTime();
      showFill();
    });
    audio.addEventListener('timeupdate', () => {
      /* Пока идёт перемотка за конец, `currentTime` — служебный: показывать
         его значит мигать чужими цифрами. */
      if (probing) return;
      showTime();
      showFill();
    });
    audio.addEventListener('ended', () => {
      setPlaying(false);
      audio.currentTime = 0;
      showTime();
      showFill();
    });

    const nudge = window.setTimeout(() => {
      if (known() || audio.readyState !== 0) return;
      audio.preload = 'auto';
      audio.load();
    }, 1200);
    timers.set(host, nudge);

    // ─── кнопки ──────────────────────────────────────────────────────────────

    const setPlaying = (playing: boolean): void => {
      play.replaceChildren(glyph(playing));
      play.setAttribute('aria-pressed', String(playing));
    };
    audio.addEventListener('play', () => setPlaying(true));
    audio.addEventListener('pause', () => setPlaying(false));

    /* `pointerdown`, а не `mousedown`: на тач-устройстве браузер досылает
       совместимостный `mousedown` после `touchend`, и одно нажатие
       срабатывало дважды — тем же дефектом болела панель форматирования. */
    play.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (audio.paused) void audio.play();
      else audio.pause();
    });

    const RATES = [1, 1.25, 1.5, 2, 0.75];
    rate.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const next = RATES[(RATES.indexOf(audio.playbackRate) + 1) % RATES.length] ?? 1;
      audio.playbackRate = next;
      rate.textContent = `${String(next).replace('.', ',')}×`;
    });

    // ─── перемотка ───────────────────────────────────────────────────────────

    const seekTo = (clientX: number): void => {
      if (!known()) return;
      const box = track.getBoundingClientRect();
      if (box.width === 0) return;
      const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
      audio.currentTime = ratio * audio.duration;
      showTime();
      showFill();
    };
    seek.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      /* Перемотка ПЕРВОЙ, захват после: захват — про продолжение жеста, и его
         отказ не должен отменять само нажатие. */
      seekTo(event.clientX);
      try {
        seek.setPointerCapture(event.pointerId);
      } catch {
        /* Указателя уже нет — тянуть нечего, разовое нажатие сработало. */
      }
    });
    seek.addEventListener('pointermove', (event) => {
      if (seek.hasPointerCapture(event.pointerId)) seekTo(event.clientX);
    });
    seek.addEventListener('pointerup', (event) => {
      if (seek.hasPointerCapture(event.pointerId)) seek.releasePointerCapture(event.pointerId);
    });

    return host;
  }

  /**
   * Виджет строится только для видимых строк: стоит увести заметку прокруткой,
   * и его DOM уничтожается. Открепление `<audio>` от документа воспроизведение
   * НЕ останавливает — звук продолжал бы идти, а кнопки, которой его выключают,
   * на экране больше нет. Поэтому останавливаем явно.
   */
  override destroy(dom: HTMLElement): void {
    const timer = timers.get(dom);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(dom);
    }
    dom.querySelector('audio')?.pause();
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** Отложенная попытка догрузить метаданные — снимается вместе с виджетом. */
const timers = new WeakMap<HTMLElement, number>();

/** Треугольник или две полосы — рисуем сами, системный глиф везде разный. */
function glyph(playing: boolean): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('role', 'presentation');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of playing ? ['M9 6v12', 'M15 6v12'] : ['M8 5.5 19 12 8 18.5z']) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
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
