/**
 * Расширения markdown-грамматики, которых нет в GFM, но которые требует ТЗ:
 *
 * - `==подсветка==`  — BEHAVIOR §2.1, SCREENS §4 («абзац с ==подсветкой==»)
 * - `[[wiki-ссылка]]` — BEHAVIOR §2.5
 * - `#тег`            — BEHAVIOR §2.4
 * - `[^сноска]`       — SCREENS §4 (витринная заметка)
 * - `$формула$`      — ITERATION-1 §4 (LaTeX, показывается KaTeX)
 *
 * Узлы получают префикс `Z`, чтобы никогда не столкнуться с именами из
 * `@lezer/markdown` — даже если в будущем там появятся свои `Highlight`
 * или `WikiLink`.
 */

import type { MarkdownConfig, InlineContext, Element } from '@lezer/markdown';

const CH_HASH = 35; // '#'
const CH_OPEN_BRACKET = 91; // '['
const CH_CLOSE_BRACKET = 93; // ']'
const CH_CARET = 94; // '^'
const CH_PIPE = 124; // '|'
const CH_EQUALS = 61; // '='
const CH_DOLLAR = 36; // '$'

/** Пунктуация по CommonMark — нужна для правил открытия/закрытия делимитеров. */
const PUNCTUATION = /[!-/:-@[-`{-~¡‐-‧]/;

/** Символы, из которых может состоять тело тега (кириллица включена). */
const TAG_BODY = /[\p{L}\p{N}_/-]/u;
/** Первый символ тега: буква или подчёркивание — «`#` + буква» из BEHAVIOR §2.1. */
const TAG_HEAD = /[\p{L}_]/u;
/** Перед тегом допустимы начало строки, пробел или открывающая пунктуация. */
const TAG_BOUNDARY_BEFORE = /[\s([{<"'«—–-]/;

// ─────────────────────────────────────────────────────────────────────────────
// ==подсветка==
// ─────────────────────────────────────────────────────────────────────────────

const HighlightDelim = { resolve: 'ZHighlight', mark: 'ZHighlightMark' };

/**
 * `==текст==`. Реализовано делимитерами — ровно как GFM-strikethrough в
 * `@lezer/markdown`, поэтому корректно вкладывается в жирный/курсив.
 */
export const HighlightExtension: MarkdownConfig = {
  defineNodes: [{ name: 'ZHighlight' }, { name: 'ZHighlightMark' }],
  parseInline: [
    {
      name: 'ZHighlight',
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== CH_EQUALS || cx.char(pos + 1) !== CH_EQUALS || cx.char(pos + 2) === CH_EQUALS) {
          return -1;
        }
        const before = pos > cx.offset ? cx.slice(pos - 1, pos) : '';
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = /\s|^$/.test(before);
        const spaceAfter = /\s|^$/.test(after);
        const punctBefore = PUNCTUATION.test(before);
        const punctAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !spaceAfter && (!punctAfter || spaceBefore || punctBefore),
          !spaceBefore && (!punctBefore || spaceAfter || punctAfter),
        );
      },
      after: 'Emphasis',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// [[wiki-ссылка]] и [[цель|подпись]]
// ─────────────────────────────────────────────────────────────────────────────

export const WikiLinkExtension: MarkdownConfig = {
  defineNodes: [
    { name: 'ZWikiLink' },
    { name: 'ZWikiMark' },
    { name: 'ZWikiTarget' },
    { name: 'ZWikiAlias' },
  ],
  parseInline: [
    {
      name: 'ZWikiLink',
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== CH_OPEN_BRACKET || cx.char(pos + 1) !== CH_OPEN_BRACKET) return -1;
        const limit = cx.end;
        for (let i = pos + 2; i < limit - 1; i++) {
          const ch = cx.char(i);
          // Вложенное `[[` — значит первое было незакрытым, дальше не наше дело.
          if (ch === CH_OPEN_BRACKET && cx.char(i + 1) === CH_OPEN_BRACKET) return -1;
          if (ch !== CH_CLOSE_BRACKET || cx.char(i + 1) !== CH_CLOSE_BRACKET) continue;

          const children: Element[] = [cx.elt('ZWikiMark', pos, pos + 2)];
          let pipe = -1;
          for (let j = pos + 2; j < i; j++) {
            if (cx.char(j) === CH_PIPE) {
              pipe = j;
              break;
            }
          }
          if (pipe > -1) {
            if (pipe > pos + 2) children.push(cx.elt('ZWikiTarget', pos + 2, pipe));
            children.push(cx.elt('ZWikiMark', pipe, pipe + 1));
            if (i > pipe + 1) children.push(cx.elt('ZWikiAlias', pipe + 1, i));
          } else if (i > pos + 2) {
            children.push(cx.elt('ZWikiTarget', pos + 2, i));
          }
          children.push(cx.elt('ZWikiMark', i, i + 2));
          return cx.addElement(cx.elt('ZWikiLink', pos, i + 2, children));
        }
        return -1;
      },
      // Строго до обычной ссылки, иначе `[` съест делимитер Link.
      before: 'Link',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// #тег и #вложенный/тег
// ─────────────────────────────────────────────────────────────────────────────

export const TagExtension: MarkdownConfig = {
  defineNodes: [{ name: 'ZTag' }, { name: 'ZTagMark' }],
  parseInline: [
    {
      name: 'ZTag',
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== CH_HASH) return -1;
        if (pos > cx.offset) {
          const before = cx.slice(pos - 1, pos);
          if (!TAG_BOUNDARY_BEFORE.test(before)) return -1;
        }
        const head = cx.slice(pos + 1, pos + 2);
        if (!head || !TAG_HEAD.test(head)) return -1;

        let end = pos + 1;
        while (end < cx.end && TAG_BODY.test(cx.slice(end, end + 1))) end++;
        // Хвостовые `/` и `-` в тег не входят: `#практика/` — это тег «практика».
        while (end > pos + 1 && /[/-]/.test(cx.slice(end - 1, end))) end--;
        if (end <= pos + 1) return -1;

        return cx.addElement(
          cx.elt('ZTag', pos, end, [cx.elt('ZTagMark', pos, pos + 1)]),
        );
      },
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// [^сноска]
// ─────────────────────────────────────────────────────────────────────────────

export const FootnoteExtension: MarkdownConfig = {
  defineNodes: [{ name: 'ZFootnoteRef' }, { name: 'ZFootnoteMark' }],
  parseInline: [
    {
      name: 'ZFootnoteRef',
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== CH_OPEN_BRACKET || cx.char(pos + 1) !== CH_CARET) return -1;
        for (let i = pos + 2; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === CH_OPEN_BRACKET) return -1;
          if (ch !== CH_CLOSE_BRACKET) continue;
          if (i === pos + 2) return -1;
          return cx.addElement(
            cx.elt('ZFootnoteRef', pos, i + 1, [
              cx.elt('ZFootnoteMark', pos, pos + 2),
              cx.elt('ZFootnoteMark', i, i + 1),
            ]),
          );
        }
        return -1;
      },
      before: 'Link',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// $формула$ и $$формула$$
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Формула LaTeX между долларами — соглашение, которое понимают Obsidian,
 * GitHub, Pandoc и любой markdown с математикой. Своего синтаксиса не
 * выдумываем: формула должна остаться формулой и в чужом редакторе.
 *
 * Разбор намеренно строгий, потому что доллар — обычный символ в тексте про
 * деньги. Открывающий доллар не должен упираться в пробел, закрывающий — не
 * должен начинать слово, а пустая пара `$$` формулой не считается. Иначе
 * «заплатил $5 и $7» стало бы формулой «5 и ».
 */
export const MathExtension: MarkdownConfig = {
  defineNodes: [{ name: 'ZMath' }, { name: 'ZMathMark' }],
  parseInline: [
    {
      name: 'ZMath',
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== CH_DOLLAR) return -1;
        /* Блочная формула `$$…$$` — те же правила, только маркер длиннее. */
        const double = cx.char(pos + 1) === CH_DOLLAR;
        const open = pos + (double ? 2 : 1);
        if (/\s|^$/.test(cx.slice(open, open + 1))) return -1;

        for (let i = open; i < cx.end; i += 1) {
          const ch = cx.char(i);
          if (ch !== CH_DOLLAR) continue;
          if (double && cx.char(i + 1) !== CH_DOLLAR) continue;
          if (i === open) return -1;
          /* Закрывающий доллар не должен висеть после пробела: `$a $` —
             это не формула, а два доллара в тексте. */
          if (/\s/.test(cx.slice(i - 1, i))) return -1;
          const close = i + (double ? 2 : 1);
          return cx.addElement(
            cx.elt('ZMath', pos, close, [
              cx.elt('ZMathMark', pos, open),
              cx.elt('ZMathMark', i, close),
            ]),
          );
        }
        return -1;
      },
      before: 'Emphasis',
    },
  ],
};

/** Полный набор фирменных расширений грамматики. */
export const zapiskiMarkdownExtensions: MarkdownConfig[] = [
  HighlightExtension,
  WikiLinkExtension,
  FootnoteExtension,
  TagExtension,
  MathExtension,
];
