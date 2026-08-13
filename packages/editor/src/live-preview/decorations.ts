/**
 * LIVE-PREVIEW — ядро редактора и главный приёмочный критерий (BEHAVIOR §2.1,
 * §13.3; DESIGN_TOKENS §3).
 *
 * ЗАКОН ЭТОГО ФАЙЛА:
 *   Символы разметки (`**`, `#`, `>`, `==`, `[[`, …) видны, когда курсор внутри
 *   узла или узел в выделении, и СХЛОПНУТЫ, когда курсор снаружи.
 *
 * ПОЧЕМУ НЕ `opacity: 0`, КАК БЫЛО. Прежняя редакция прятала символы
 * прозрачностью, оставляя им место в потоке, — ради обещания «layout не
 * сдвигается никогда». Обещание выполнялось, а результат заказчик описал так:
 * «убирает `**`, но оставляет 2 пробела, как будто эти символы ещё там».
 * Так и было: они там и оставались, просто невидимые. Каждый жирный фрагмент
 * получал по дыре с обеих сторон, каждый чекбокс — дыру рядом с квадратом, и
 * текст выглядел дырявым.
 *
 * Хуже того, прозрачный символ остаётся местом, куда встаёт курсор. После
 * Ctrl+B по выделению курсор оказывался МЕЖДУ маркерами, стрелка их не
 * перешагивала, и всё напечатанное дальше уезжало внутрь жирного:
 * `**жирное продолжаю печатать дальше**`. Это и есть «редактор очень неумный».
 *
 * `Decoration.replace()` решает обе беды разом: диапазон схлопывается, а
 * `EditorView.atomicRanges` (см. `plugin.ts`) делает его неделимым для курсора,
 * так что стрелка перешагивает пару целиком.
 *
 * Расхождение с BEHAVIOR §2.1 и §13.3 нового пакета — сознательное и названо
 * вслух: там записано «всегда занимают место, меняется только opacity». Прямое
 * указание заказчика от 2026-08-10 перечисляет это поведение первым пунктом
 * списка дефектов. Вернуть прежнее — это `hiddenMark` → `markDeco` ниже.
 *
 * Что осталось неизменным:
 *   • активность считается по РОДИТЕЛЮ символа;
 *   • виджеты (чекбокс, картинка) добавляются, а не заменяют текст;
 *   • композиция IME никогда не прерывается пересчётом декораций.
 *
 * «Активный узел» = узел синтаксического дерева, в диапазон которого курсор
 * попадает или к границе которого примыкает. Для символа разметки активность
 * считается по его РОДИТЕЛЮ: `#` подсвечивается, когда курсор где угодно в
 * заголовке, а `**` — когда курсор где угодно внутри жирного фрагмента.
 *
 * Производительность (ARCHITECTURE §4, <16 мс на кейстрок в заметке 1 МБ):
 * декорации строятся ТОЛЬКО по видимым диапазонам (`view.visibleRanges`),
 * дерево обходится один раз, результат собирается `RangeSetBuilder`.
 */

import { RangeSetBuilder } from '@codemirror/state';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { hidesMarkup } from './editor-mode.js';
import type { SyntaxNodeRef } from '@lezer/common';
import { editorRuntime } from '../runtime.js';
import type { EditorRuntime } from '../runtime.js';
import { AudioWidget, FileWidget, ImageWidget, SummaryWidget, TaskBoxWidget } from './widgets.js';
import { isCollapsed } from './collapsed.js';

// ─────────────────────────────────────────────────────────────────────────────
// Кэш деклараций: одинаковый класс → один и тот же объект `Decoration`.
// CodeMirror сравнивает декорации по значению, но стабильные ссылки экономят
// аллокации на каждом кейстроке.
// ─────────────────────────────────────────────────────────────────────────────

const markCache = new Map<string, Decoration>();
function markDeco(cls: string): Decoration {
  let deco = markCache.get(cls);
  if (!deco) {
    deco = Decoration.mark({ class: cls });
    markCache.set(cls, deco);
  }
  return deco;
}

const lineCache = new Map<string, Decoration>();
function lineDeco(cls: string): Decoration {
  let deco = lineCache.get(cls);
  if (!deco) {
    deco = Decoration.line({ class: cls });
    lineCache.set(cls, deco);
  }
  return deco;
}

/**
 * Схлопнутый символ разметки. Один объект на всё приложение: CodeMirror
 * сравнивает декорации по значению, а замена без виджета не несёт состояния.
 */
const hiddenMark = Decoration.replace({});

/** Класс ВИДИМОГО символа разметки — он рисуется только у курсора. */
function syntaxClass(extra?: string): string {
  const base = 'cm-z-mark cm-z-mark-on';
  return extra ? `${base} ${extra}` : base;
}

// ─────────────────────────────────────────────────────────────────────────────
// Классификация узлов
// ─────────────────────────────────────────────────────────────────────────────

/** Символы разметки, которые фейдятся у курсора. */
const FADING_MARKS = new Set([
  'HeaderMark',
  'QuoteMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'LinkMark',
  'ZHighlightMark',
  'ZWikiMark',
  'ZFootnoteMark',
  'SubscriptMark',
  'SuperscriptMark',
]);

/** Инлайн-узлы, у которых стиль не зависит от курсора. */
const INLINE_STYLE: Record<string, string> = {
  StrongEmphasis: 'cm-z-strong',
  Emphasis: 'cm-z-em',
  Strikethrough: 'cm-z-strike',
  ZHighlight: 'cm-z-highlight',
  InlineCode: 'cm-z-inline-code',
  URL: 'cm-z-url',
  LinkTitle: 'cm-z-url',
  LinkLabel: 'cm-z-url',
  Link: 'cm-z-link',
  Autolink: 'cm-z-link',
  ZTag: 'cm-z-tag',
  ZFootnoteRef: 'cm-z-footnote',
  CodeInfo: 'cm-z-code-info',
};

const HEADING_LINE: Record<string, string> = {
  ATXHeading1: 'cm-z-h1',
  ATXHeading2: 'cm-z-h2',
  ATXHeading3: 'cm-z-h3',
  ATXHeading4: 'cm-z-h4',
  ATXHeading5: 'cm-z-h5',
  ATXHeading6: 'cm-z-h6',
  SetextHeading1: 'cm-z-h1',
  SetextHeading2: 'cm-z-h2',
};

const IMAGE_URL = /^(https?:)?\/\//i;
/** Что показывать плеером, а не карточкой. */
const AUDIO_ATTACHMENT = /\.(mp3|ogg|opus|wav|m4a|aac|flac)$/i;
/** Расширения картинок — те же, что знает ядро. */
const isImageUrl = (url: string): boolean =>
  /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/i.test(url.split('?')[0] ?? url);
/** Имя файла из пути — подпись карточки, когда её не задали в тексте. */
const fileNameOf = (path: string): string => path.split('/').pop() ?? path;
const TASK_CHECKED = /^\[[xX]\]$/;
/** Строка-определение сноски: `[^1]: текст` (SCREENS §4). */
const FOOTNOTE_DEF = /^\s{0,3}\[\^[^\]\s]+\]:/;

// ─────────────────────────────────────────────────────────────────────────────
// Построитель
// ─────────────────────────────────────────────────────────────────────────────

interface AncestorFrame {
  name: string;
  from: number;
  to: number;
}

class LivePreviewBuilder {
  private readonly out: Range<Decoration>[] = [];
  /** Схлопнутые символы — они же неделимые для курсора диапазоны. */
  private readonly hidden: Range<Decoration>[] = [];
  private readonly stack: AncestorFrame[] = [];
  /** Строки, на которых уже стоит блочная декорация данного класса. */
  private readonly seenLines = new Set<string>();
  /** Границы текущего видимого куска — блочные классы дальше них не считаем. */
  private viewFrom = 0;
  private viewTo = 0;

  constructor(
    private readonly state: EditorState,
    private readonly runtime: EditorRuntime,
  ) {}

  /** Начать обход очередного видимого диапазона. */
  setRange(from: number, to: number): void {
    this.viewFrom = from;
    this.viewTo = to;
    this.stack.length = 0;
  }

  /** Пересекается ли диапазон хотя бы с одним диапазоном выделения/курсором. */
  private isActive(from: number, to: number): boolean {
    for (const range of this.state.selection.ranges) {
      // `<=` и `>=` дают «примыкание к границе», как требует BEHAVIOR §2.1.
      if (range.from <= to && range.to >= from) return true;
    }
    return false;
  }

  private parent(): AncestorFrame | undefined {
    return this.stack[this.stack.length - 2];
  }

  private mark(from: number, to: number, cls: string): void {
    if (to > from) this.out.push(markDeco(cls).range(from, to));
  }

  /**
   * Символ разметки: показать у курсора, схлопнуть вне его.
   *
   * Схлопнутый диапазон попадает ещё и в `hidden` — из него собирается набор
   * неделимых для курсора диапазонов. Без этого стрелка встаёт между двумя
   * `*`, где нет ни одного пикселя, и набранное дальше уезжает внутрь жирного.
   */
  private fade(from: number, to: number, active: boolean, extra?: string): void {
    if (to <= from) return;
    /* Простой режим: разметка не проявляется ни в одном состоянии, включая
       курсор внутри узла (ITERATION-1 §8). Гасится здесь, в единственном
       месте, где решается «показать или схлопнуть», — иначе правило пришлось
       бы повторять у каждого типа узла и однажды забыть. */
    if (active && !hidesMarkup(this.state)) {
      this.out.push(markDeco(syntaxClass(extra)).range(from, to));
      return;
    }
    const range = hiddenMark.range(from, to);
    this.out.push(range);
    this.hidden.push(range);
  }

  /**
   * Докуда на самом деле тянется блочный маркер.
   *
   * Дефект, ради которого появился этот метод: «при применении Hx остаётся
   * пробел перед словом». Парсер markdown относит к `HeaderMark` только сами
   * решётки, а пробел между ними и текстом — уже содержимое строки. Пока
   * схлопывался один узел, пробел оставался на экране, и заголовок оказывался
   * сдвинут на символ вправо относительно обычного текста. То же и у цитаты:
   * `>` пряталось, а её отступ жил своей жизнью.
   *
   * Пробел после блочного маркера — часть разметки: без него `#Заголовок`
   * вообще не заголовок. Значит и прятать его нужно вместе с маркером.
   *
   * Только для блочных маркеров и только вперёд по строке: у закрывающих
   * решёток (`## Текст ##`) справа пробелов нет, а инлайновые `*` и `` ` ``
   * окружены обычным текстом, который трогать нельзя.
   */
  /** Позиция за пробелами, идущими сразу после `at` (в пределах строки). */
  private spaceAfter(at: number): number {
    const line = this.state.doc.lineAt(at);
    let end = at;
    while (end < line.to && ' \t'.includes(this.state.doc.sliceString(end, end + 1))) end += 1;
    return end;
  }

  /** Идёт ли сразу за маркером списка квадрат задачи — `- [ ] …`. */
  private startsTask(afterMark: number): boolean {
    const line = this.state.doc.lineAt(afterMark);
    const rest = this.state.doc.sliceString(this.spaceAfter(afterMark), line.to);
    return /^\[[ xX]\]/.test(rest);
  }

  private markEnd(name: string, from: number, to: number): number {
    if (name !== 'HeaderMark' && name !== 'QuoteMark') return to;
    const line = this.state.doc.lineAt(from);
    /* Закрывающая решётка стоит в конце строки — там поглощать нечего. */
    if (to >= line.to) return to;
    let end = to;
    while (end < line.to && ' \t'.includes(this.state.doc.sliceString(end, end + 1))) end += 1;
    return end;
  }

  /**
   * Цитата и выноска — один узел markdown, разное на экране.
   *
   * Выноска записывается как цитата с меткой типа: `> [!note] текст`. Это
   * соглашение Obsidian и GitHub, и оно намеренно остаётся в файле обычным
   * markdown — заметка обязана осмысленно открываться чужим редактором.
   *
   * Дефект, ради которого метод появился: метку никто не прятал, и на экране
   * оставалось «> [!note] Текст» — заказчик описал это как «результат работы
   * выноски отображается с лишними символами». Сам маркер цитаты `>` при этом
   * схлопывался, отчего строка читалась ещё страннее.
   *
   * Сразу скажу про центрирование, потому что здесь расхождение с каноном: ни
   * в Obsidian, ни в GitHub выноска по горизонтали не центрируется — она
   * занимает всю ширину колонки и опознаётся полосой слева. Центрирование
   * сделано по прямой просьбе заказчика и живёт в теме (`.cm-z-callout`), а
   * не в разметке файла: в `.md` остаётся канонический markdown.
   */
  private blockquote(from: number, to: number): void {
    const first = this.state.doc.lineAt(from);
    const label = /^>[\t ]*(\[![^\]\n]*\])[\t ]?/.exec(first.text);
    if (!label) {
      this.lines(from, to, 'cm-z-quote');
      this.quoteAuthor(from, to);
      return;
    }

    this.lines(from, to, 'cm-z-callout', 'cm-z-callout-first', 'cm-z-callout-last');

    /* Метка прячется вместе с отбивкой — по тому же правилу, что и блочные
       маркеры: иначе на её месте останется дыра в начале строки. */
    const tag = label[1] as string;
    const at = first.text.indexOf(tag);
    const start = first.from + at;
    const spaced = ' \t'.includes(first.text[at + tag.length] ?? '');
    this.fade(start, start + tag.length + (spaced ? 1 : 0), this.isActive(first.from, first.to));
  }

  /**
   * `<details>` и `<summary>` — заголовок со стрелкой вместо голой разметки.
   *
   * Заказчик: «сворачиваемый блок в принципе не работает, а просто выдаёт xml,
   * заполняя который ничего не происходит». В файле блок остаётся честным
   * html — так его понимают GitHub, Obsidian и браузер, — прячется только
   * показ: сами теги. Заголовок получает стрелку, и она сворачивает тело.
   *
   * Разметка видна, когда курсор внутри блока: иначе её не отредактировать.
   */
  private htmlBlock(from: number, to: number): void {
    const text = this.state.doc.sliceString(from, to);
    if (!/<\/?(details|summary)\b/i.test(text)) return;

    const active = this.isActive(from, to);
    const open = /<details[^>]*>/i.exec(text);
    const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(text);

    /* Закрывающий блок — только тег: прячем его целиком. */
    if (!open && !summary) {
      const close = /<\/details\s*>/i.exec(text);
      if (close) this.fade(from + (close.index ?? 0), from + (close.index ?? 0) + close[0].length, active);
      return;
    }

    if (open) this.fade(from + open.index, from + open.index + open[0].length, active);

    if (!summary) return;
    const head = from + summary.index;
    const inner = summary[1] ?? '';
    const openTagLength = summary[0].length - inner.length - '</summary>'.length;

    this.lines(head, head, 'cm-z-summary');
    /* Стрелка ставится ПЕРЕД заголовком и замещает открывающий тег: так у неё
       есть своё место, а курсор перешагивает её целиком. */
    const collapsed = isCollapsed(this.state, from);
    const arrow = Decoration.replace({
      widget: new SummaryWidget(collapsed, from, (at) => this.runtime.toggleCollapsed(at)),
    }).range(head, head + openTagLength);
    this.out.push(arrow);
    this.hidden.push(arrow);
    this.fade(head + openTagLength + inner.length, head + summary[0].length, active);

    if (collapsed) this.collapseBody(to);
  }

  /**
   * Спрятать тело свёрнутого блока — строки от заголовка до `</details>`.
   *
   * Тело разбирается как обычный markdown отдельными узлами, поэтому его
   * границы здесь неизвестны: ищем закрывающий тег построчно. Прячем классом
   * строки, а не `replace`: содержимое остаётся в документе и в поиске, просто
   * не показывается — как и должно быть у свёрнутого блока.
   */
  private collapseBody(afterHead: number): void {
    const doc = this.state.doc;
    const first = doc.lineAt(afterHead).number + 1;
    for (let n = first; n <= doc.lines; n += 1) {
      const line = doc.line(n);
      if (/<\/details\s*>/i.test(line.text)) return;
      const key = `${line.from}:cm-z-collapsed`;
      if (this.seenLines.has(key)) continue;
      this.seenLines.add(key);
      this.out.push(lineDeco('cm-z-collapsed').range(line.from));
    }
  }

  /**
   * Строка атрибуции в цитате — `> — Автор` (замечание 4).
   *
   * Оформляется мельче и вторичным цветом, как подпись. Пустая — та, где
   * кроме тире ничего нет, — не показывается вовсе: «если пользователь не
   * вбивает автора, место под него в просмотре не должно оставаться». Пока
   * курсор в этой строке, она видна: иначе автора не дописать.
   */
  private quoteAuthor(from: number, to: number): void {
    const doc = this.state.doc;
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n += 1) {
      const line = doc.line(n);
      const author = /^\s*>\s*—\s*(.*)$/.exec(line.text);
      if (!author) continue;
      const filled = (author[1] ?? '').trim() !== '';
      if (!filled && !this.isActive(line.from, line.to)) {
        this.lines(line.from, line.from, 'cm-z-collapsed');
        continue;
      }
      this.lines(line.from, line.from, 'cm-z-quote-author');
    }
  }

  private widget(pos: number, deco: Decoration): void {
    this.out.push(deco.range(pos));
  }

  /** Блочный класс на каждую строку узла в пределах видимого куска. */
  private lines(from: number, to: number, cls: string, firstCls?: string, lastCls?: string): void {
    const doc = this.state.doc;
    const nodeFirst = doc.lineAt(from).number;
    const nodeLast = doc.lineAt(to).number;
    // Код-блок на тысячу строк не должен стоить тысячу декораций: за пределами
    // вьюпорта их всё равно никто не увидит (ARCHITECTURE §4).
    const visFirst = Math.max(nodeFirst, doc.lineAt(Math.max(from, this.viewFrom)).number);
    const visLast = Math.min(nodeLast, doc.lineAt(Math.min(to, Math.max(this.viewTo, from))).number);
    for (let n = visFirst; n <= visLast; n++) {
      const line = doc.line(n);
      const key = `${line.from}:${cls}`;
      if (this.seenLines.has(key)) continue;
      this.seenLines.add(key);
      let full = cls;
      if (firstCls && n === nodeFirst) full += ` ${firstCls}`;
      if (lastCls && n === nodeLast) full += ` ${lastCls}`;
      this.out.push(lineDeco(full).range(line.from));
    }
  }

  enter(node: SyntaxNodeRef): void {
    this.stack.push({ name: node.name, from: node.from, to: node.to });
    const { name, from, to } = node;

    // ── Символы разметки ────────────────────────────────────────────────────
    if (FADING_MARKS.has(name)) {
      const owner = this.parent();
      const active = owner ? this.isActive(owner.from, owner.to) : this.isActive(from, to);
      this.fade(from, this.markEnd(name, from, to), active);
      return;
    }

    // ── Чекбокс (BEHAVIOR §2.3) ─────────────────────────────────────────────
    if (name === 'TaskMarker') {
      const raw = this.state.doc.sliceString(from, to);
      const checked = TASK_CHECKED.test(raw);
      const owner = this.parent();
      /*
        Квадрат ЗАМЕЩАЕТ сырые `[ ]`, а не добавляется рядом.

        Пока разметка пряталась прозрачностью, скобки держали место, и виджет
        помещался в него. Теперь разметка схлопывается — и добавочный виджет
        оказался поверх текста: «☐адача» вместо «☐ задача».

        Замена, а не пара «виджет + скрытый текст», ещё и честнее: у квадрата
        появляется собственная ширина, а курсор перешагивает его целиком, как
        любой другой схлопнутый диапазон.
      */
      const box = Decoration.replace({ widget: new TaskBoxWidget(checked) }).range(from, to);
      this.out.push(box);
      this.hidden.push(box);
      if (checked && owner && owner.to > to) {
        // Текст выполненной задачи: secondary + line-through (BEHAVIOR §2.3).
        this.mark(to, owner.to, 'cm-z-task-done');
      }
      return;
    }

    /*
     * Адрес ссылки прячется вместе с её скобками.
     *
     * Дефект: `[CMPAS](https://cmpas.ru)` показывался как «CMPAShttps://
     * cmpas.ru» — заказчик описал это как «отображаются и текст и ссылка
     * слитно текстом». Скобки схлопывались (они `LinkMark`), а сам адрес
     * оставался обычным текстом и приклеивался к подписи.
     *
     * Прячется только адрес В ССЫЛКЕ С ПОДПИСЬЮ. У автоссылки (`Autolink`,
     * просто `https://…` в тексте) адрес — единственное, что есть, и прятать
     * там нечего.
     */
    if ((name === 'URL' || name === 'LinkTitle') && this.parent()?.name === 'Link') {
      const owner = this.parent();
      const active = owner ? this.isActive(owner.from, owner.to) : false;
      if (!active) {
        this.fade(from, to, false);
        return;
      }
      /* Курсор внутри ссылки — адрес показан и остаётся собой: приглушённым
         моноширинным (`cm-z-url` ниже), а не «символом разметки». Иначе
         редактировать ссылку пришлось бы вслепую. */
    }

    // ── Маркеры списков: акцент, деликатно; НЕ фейдятся ─────────────────────
    if (name === 'ListMark') {
      /*
       * У задачи маркер списка прячется. В файле пункт записан как
       * `- [ ] текст` — это канонический GFM, и трогать его нельзя. Но на
       * экране дефис перед квадратом лишний: заказчик так и написал — «при
       * добавлении чеклиста перед текстбоксом появляется `-`, что лишнее».
       * Роль маркера здесь уже играет сам квадрат.
       */
      if (this.startsTask(to)) {
        this.fade(from, this.spaceAfter(to), false);
        return;
      }
      this.mark(from, to, 'cm-z-list-mark');
      return;
    }

    /*
     * Таблица (замечание 13): «просто выдаётся текстовый каркас, с которым в
     * простом режиме непросто работать».
     *
     * В файле остаётся канонический GFM — иначе таблица перестанет быть
     * таблицей в любом другом редакторе. Прячется служебное:
     *
     *   · строка `| --- | --- |` целиком: она нужна разбору, а не читателю;
     *   · сами палки `|` вне таблицы под курсором — колонки разделяет тонкая
     *     линия, которую рисует ячейка.
     *
     * Когда курсор в таблице, всё возвращается: править её иначе нельзя.
     */
    if (name === 'TableDelimiter') {
      const table = this.stack.find((frame) => frame.name === 'Table');
      const active = table ? this.isActive(table.from, table.to) : this.isActive(from, to);
      const line = this.state.doc.lineAt(from);
      const wholeLine = from <= line.from && to >= line.to;

      if (active) {
        this.mark(from, to, 'cm-z-table-delim');
        return;
      }
      if (wholeLine) {
        this.lines(from, to, 'cm-z-table-rule');
        return;
      }
      this.fade(from, to, false);
      return;
    }

    if (name === 'TableCell') {
      this.mark(from, to, 'cm-z-table-cell');
      return;
    }

    // ── Заголовки: размер и насыщенность, не цвет (DESIGN_TOKENS §2) ────────
    const headingCls = HEADING_LINE[name];
    if (headingCls) {
      this.lines(from, to, headingCls);
      return;
    }

    switch (name) {
      /*
       * Список отбивается влево-вправо как блок. Заказчик: «не происходит
       * сдвига вправо, что ожидается при добавлении списка» — и он прав:
       * маркер должен висеть в поле, а текст пунктов идти по своей оси.
       * До сих пор у списков не было ни своего класса, ни отступа, и пункты
       * стояли вровень с обычными абзацами.
       */
      case 'BulletList':
      case 'OrderedList':
        this.lines(from, to, 'cm-z-list');
        return;
      case 'Blockquote':
        this.blockquote(from, to);
        return;
      case 'FencedCode':
      case 'CodeBlock':
        this.lines(from, to, 'cm-z-code', 'cm-z-code-first', 'cm-z-code-last');
        return;
      /*
       * Сворачиваемый блок (замечание 12): `<details>` / `<summary>`.
       *
       * Парсер отдаёт его двумя HTML-блоками — открывающим (вместе с
       * заголовком) и закрывающим, — а тело между ними разбирает как обычный
       * markdown. Это удобно: тело остаётся живым текстом со своим
       * форматированием, а прячем мы только теги.
       */
      case 'HTMLBlock':
        this.htmlBlock(from, to);
        return;
      case 'HorizontalRule':
        this.lines(from, to, 'cm-z-hr');
        this.fade(from, to, this.isActive(from, to));
        return;
      case 'Table':
        this.lines(from, to, 'cm-z-table', undefined, 'cm-z-table-last');
        return;
      case 'TableHeader':
        this.lines(from, to, 'cm-z-table-head');
        return;
      case 'ZWikiLink':
        this.wikiLink(from, to);
        return;
      case 'Image':
        this.image(node);
        return;
      case 'Link':
        /* Ссылка на файл в хранилище — карточка или плеер, а не голый адрес
           (ITERATION-1 §5). Внешние ссылки остаются ссылками. */
        this.attachment(node);
        break;
      default:
        break;
    }

    const inlineCls = INLINE_STYLE[name];
    if (inlineCls) this.mark(from, to, inlineCls);

    /* Решётка тега — того же цвета, но на 60 % непрозрачности (ITERATION-1 §7).
       Отдельной декорацией, потому что часть текста иначе не покрасить: сам
       символ служебный, а читается имя тега. */
    if (name === 'ZTag' && to > from) this.mark(from, from + 1, 'cm-z-tag-hash');
  }

  leave(): void {
    this.stack.pop();
  }

  /** Висячая wiki-ссылка — акцент + пунктир 50% opacity (BEHAVIOR §2.5). */
  private wikiLink(from: number, to: number): void {
    const inner = this.state.doc.sliceString(from + 2, Math.max(from + 2, to - 2));
    const pipe = inner.indexOf('|');
    const target = (pipe > -1 ? inner.slice(0, pipe) : inner).trim();
    const dangling = target.length > 0 && !this.runtime.wikiExists(target);
    this.mark(from, to, dangling ? 'cm-z-wiki cm-z-wiki-dangling' : 'cm-z-wiki');
  }

  /** Инлайн-превью картинки после строки (BEHAVIOR §2.6). */
  private image(node: SyntaxNodeRef): void {
    const raw = this.state.doc.sliceString(node.from, node.to);
    const parsed = /^!\[([^\]]*)\]\(\s*<?([^\s>)]*)>?/.exec(raw);
    if (!parsed) return;
    const alt = parsed[1] ?? '';
    const rawSrc = parsed[2] ?? '';
    if (!rawSrc) return;
    const src =
      IMAGE_URL.test(rawSrc) || rawSrc.startsWith('data:')
        ? rawSrc
        : this.runtime.resolveAttachment(rawSrc);
    if (!src) return;
    const lineEnd = this.state.doc.lineAt(node.to).to;
    /* Путь из текста едет вместе с URL: по нему тап открывает полноэкранный
       просмотр. У внешнего адреса путь — он сам. */
    this.widget(
      lineEnd,
      Decoration.widget({ widget: new ImageWidget(src, alt, rawSrc), side: 1 }),
    );
  }

  /**
   * Вложение-НЕкартинка: документ или аудиозапись.
   *
   * Раньше и то и другое оставалось голой ссылкой `[](attachments/договор.pdf)`
   * — то есть выглядело как опечатка. Теперь документ показывается карточкой,
   * а звук — мини-плеером (§5).
   *
   * Внешние адреса сюда не попадают: `http(s)://` и `data:` остаются обычной
   * ссылкой, за ними нет файла, который мы могли бы открыть.
   */
  private attachment(node: SyntaxNodeRef): void {
    const raw = this.state.doc.sliceString(node.from, node.to);
    const parsed = /^\[([^\]]*)\]\(\s*<?([^\s>)]*)>?/.exec(raw);
    if (!parsed) return;
    const rawSrc = parsed[2] ?? '';
    if (!rawSrc || IMAGE_URL.test(rawSrc) || rawSrc.startsWith('data:')) return;
    if (isImageUrl(rawSrc)) return;

    const src = this.runtime.resolveAttachment(rawSrc);
    if (!src) return;

    const name = (parsed[1] ?? '') || fileNameOf(rawSrc);
    const lineEnd = this.state.doc.lineAt(node.to).to;
    const widget = AUDIO_ATTACHMENT.test(rawSrc)
      ? new AudioWidget(src, name)
      : new FileWidget(rawSrc, name, this.runtime.attachmentSize(rawSrc), (path) =>
          this.runtime.openAttachment(path),
        );
    this.widget(lineEnd, Decoration.widget({ widget, side: 1 }));
  }

  /** Определения сносок оформляются построчно — узла для них в грамматике нет. */
  footnoteDefinitions(from: number, to: number): void {
    const doc = this.state.doc;
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      if (FOOTNOTE_DEF.test(line.text)) {
        const key = `${line.from}:cm-z-footnote-def`;
        if (this.seenLines.has(key)) continue;
        this.seenLines.add(key);
        this.out.push(lineDeco('cm-z-footnote-def').range(line.from));
      }
    }
  }

  /**
   * `RangeSetBuilder` требует строго неубывающего порядка по `(from, startSide)`,
   * а обход дерева выдаёт строчные и инлайновые декорации вперемешку —
   * поэтому сортируем один раз в конце. На видимом куске это десятки элементов.
   */
  finish(): LivePreviewSets {
    return { decorations: pack(this.out), atomic: pack(this.hidden) };
  }
}

/** Отсортировать и собрать набор диапазонов. */
function pack(ranges: Range<Decoration>[]): DecorationSet {
  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) builder.add(range.from, range.to, range.value);
  return builder.finish();
}

export interface LivePreviewSets {
  /** Всё, что рисуется. */
  decorations: DecorationSet;
  /**
   * Схлопнутые символы разметки — их курсор перешагивает целиком
   * (`EditorView.atomicRanges`). Отдельный набор, а не весь предыдущий:
   * неделимыми должны стать ровно невидимые куски, иначе курсор перестанет
   * ходить по обычному тексту внутри жирного.
   */
  atomic: DecorationSet;
}

/**
 * Собрать декорации live-preview для заданных диапазонов.
 *
 * Чистая функция: не трогает DOM и не требует `EditorView`, поэтому её же
 * гоняют перф-тесты (`test/perf.test.ts`) и тесты разметки.
 */
export function buildLivePreview(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): LivePreviewSets {
  const runtime = state.facet(editorRuntime);
  const builder = new LivePreviewBuilder(state, runtime);
  const tree = syntaxTree(state);
  for (const { from, to } of ranges) {
    builder.setRange(from, to);
    tree.iterate({
      from,
      to,
      enter: (node) => {
        builder.enter(node);
        return true;
      },
      leave: () => builder.leave(),
    });
    builder.footnoteDefinitions(from, to);
  }
  return builder.finish();
}
