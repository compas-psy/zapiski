/**
 * LIVE-PREVIEW — ядро редактора и главный приёмочный критерий (BEHAVIOR §2.1,
 * §13.3; DESIGN_TOKENS §3).
 *
 * ЗАКОН ЭТОГО ФАЙЛА:
 *   Символы разметки (`**`, `#`, `>`, `==`, `[[`, …) ВСЕГДА занимают своё место
 *   в потоке текста. Меняется ТОЛЬКО `opacity`: 0 вне активного узла, 1 (цвет
 *   `--text-disabled`) когда курсор внутри узла или узел попал в выделение.
 *   Переход 160 мс. LAYOUT НЕ СДВИГАЕТСЯ НИКОГДА.
 *
 * Следствия, которые нельзя нарушать:
 *   • `Decoration.replace()` не используется ни разу — он схлопывает символы;
 *   • ни один класс, зависящий от курсора, не меняет метрику (font-size,
 *     display, width, padding, letter-spacing) — только `opacity`;
 *   • виджеты (чекбокс, картинка) добавляются, а не заменяют текст.
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
import type { SyntaxNodeRef } from '@lezer/common';
import { editorRuntime } from '../runtime.js';
import type { EditorRuntime } from '../runtime.js';
import { ImageWidget, TaskBoxWidget } from './widgets.js';

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
 * Класс символа разметки. Единственное, что зависит от курсора во всём файле, —
 * добавление `cm-z-mark-on`, а оно меняет исключительно `opacity`.
 */
function syntaxClass(active: boolean, extra?: string): string {
  const base = active ? 'cm-z-mark cm-z-mark-on' : 'cm-z-mark';
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
      this.mark(from, to, syntaxClass(active));
      return;
    }

    // ── Чекбокс (BEHAVIOR §2.3) ─────────────────────────────────────────────
    if (name === 'TaskMarker') {
      const raw = this.state.doc.sliceString(from, to);
      const checked = TASK_CHECKED.test(raw);
      const owner = this.parent();
      const active = owner ? this.isActive(owner.from, owner.to) : this.isActive(from, to);
      this.widget(from, Decoration.widget({ widget: new TaskBoxWidget(checked), side: -1 }));
      this.mark(from, to, syntaxClass(active, 'cm-z-task'));
      if (checked && owner && owner.to > to) {
        // Текст выполненной задачи: secondary + line-through (BEHAVIOR §2.3).
        this.mark(to, owner.to, 'cm-z-task-done');
      }
      return;
    }

    // ── Маркеры списков: акцент, деликатно; НЕ фейдятся ─────────────────────
    if (name === 'ListMark') {
      this.mark(from, to, 'cm-z-list-mark');
      return;
    }

    // ── Разделители таблицы: структурные, тоже не фейдятся ──────────────────
    if (name === 'TableDelimiter') {
      this.mark(from, to, 'cm-z-table-delim');
      return;
    }

    // ── Заголовки: размер и насыщенность, не цвет (DESIGN_TOKENS §2) ────────
    const headingCls = HEADING_LINE[name];
    if (headingCls) {
      this.lines(from, to, headingCls);
      return;
    }

    switch (name) {
      case 'Blockquote':
        this.lines(from, to, 'cm-z-quote');
        return;
      case 'FencedCode':
      case 'CodeBlock':
        this.lines(from, to, 'cm-z-code', 'cm-z-code-first', 'cm-z-code-last');
        return;
      case 'HorizontalRule':
        this.lines(from, to, 'cm-z-hr');
        this.mark(from, to, syntaxClass(this.isActive(from, to)));
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
      default:
        break;
    }

    const inlineCls = INLINE_STYLE[name];
    if (inlineCls) this.mark(from, to, inlineCls);
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
    this.widget(lineEnd, Decoration.widget({ widget: new ImageWidget(src, alt), side: 1 }));
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
  finish(): DecorationSet {
    this.out.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
    const builder = new RangeSetBuilder<Decoration>();
    for (const range of this.out) builder.add(range.from, range.to, range.value);
    return builder.finish();
  }
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
): DecorationSet {
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
