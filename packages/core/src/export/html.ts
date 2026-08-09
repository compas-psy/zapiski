/**
 * Экспорт в HTML (ТЗ §5.3, бесплатно и без paywall — прямой ответ на боль Bear).
 *
 * Документ самодостаточный: стили инлайн, тема — всегда светлая «Бумага»,
 * колонка 640, без интерфейсных элементов (BEHAVIOR §9). Тот же HTML идёт на
 * печать в PDF.
 */
import type { Note } from '../contract.js';
import { parseBlocks, type Block, type Inline } from '../markdown/ast.js';
import { splitFrontmatter } from '../markdown/frontmatter.js';
import { PRINT_PALETTE as C, PRINT_FONTS as F } from './print-palette.js';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Белый список схем для адресов, попадающих в экспортный документ.
 *
 * Экранирования кавычек мало: `[текст](javascript:...)` даёт валидный
 * `<a href="javascript:...">`, и клик по нему исполняет скрипт — в браузере
 * при открытии выгруженного `.html`, а при печати в PDF (`export/pdf.ts`)
 * ещё и внутри WebView приложения. Тело заметки — недоверенный ввод: оно
 * может приехать синком от скомпрометированной стороны (docs/dev/security/THREAT-MODEL.md,
 * актёр «вредоносная заметка по синку»).
 *
 * Пустая строка на выходе означает «адрес небезопасен» — вызывающий рисует
 * текст без ссылки.
 */
const SAFE_LINK_SCHEME = /^(https?|mailto):/i;
const SAFE_IMAGE_DATA = /^data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=\s]*$/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Схлопывает пробелы и управляющие символы: `java\tscript:` — классический обход. */
function collapse(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // Пробелы и управляющие символы (включая DEL) выбрасываем.
    if (code <= 0x20 || code === 0x7f) continue;
    out += char;
  }
  return out;
}

export function safeLinkUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const collapsed = collapse(trimmed);
  if (HAS_SCHEME.test(collapsed)) return SAFE_LINK_SCHEME.test(collapsed) ? trimmed : '';
  // Без схемы — относительный путь или якорь: исполняемым он стать не может.
  return trimmed;
}

export function safeImageUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const collapsed = collapse(trimmed);
  if (!HAS_SCHEME.test(collapsed)) return trimmed;
  if (/^https?:/i.test(collapsed)) return trimmed;
  // data: только растровые картинки; svg умеет носить в себе скрипт.
  return SAFE_IMAGE_DATA.test(collapsed) ? trimmed : '';
}

function renderInline(nodes: Inline[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += escapeHtml(node.text);
        break;
      case 'strong':
        out += `<strong>${renderInline(node.children)}</strong>`;
        break;
      case 'em':
        out += `<em>${renderInline(node.children)}</em>`;
        break;
      case 'strike':
        out += `<s>${renderInline(node.children)}</s>`;
        break;
      case 'mark':
        out += `<mark>${renderInline(node.children)}</mark>`;
        break;
      case 'code':
        out += `<code>${escapeHtml(node.text)}</code>`;
        break;
      case 'link': {
        // Адрес с запрещённой схемой теряет ссылку, но не текст: содержимое
        // заметки при экспорте не пропадает никогда.
        const href = safeLinkUrl(node.href);
        out += href === ''
          ? renderInline(node.children)
          : `<a href="${escapeHtml(href)}">${renderInline(node.children)}</a>`;
        break;
      }
      case 'wiki': {
        const label = escapeHtml(node.label === '' ? node.target : node.label);
        const target = safeLinkUrl(node.target);
        out += target === ''
          ? `<span class="wiki">${label}</span>`
          : `<a class="wiki" href="${escapeHtml(target)}.html">${label}</a>`;
        break;
      }
      case 'image': {
        const src = safeImageUrl(node.src);
        out += src === ''
          ? `<span class="image-blocked">${escapeHtml(node.alt)}</span>`
          : `<img src="${escapeHtml(src)}" alt="${escapeHtml(node.alt)}">`;
        break;
      }
      case 'footnote':
        out += `<sup class="fn">${escapeHtml(node.label)}</sup>`;
        break;
      case 'break':
        out += '<br>';
        break;
    }
  }
  return out;
}

function renderBlocks(blocks: Block[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.push(`<h${block.level}>${renderInline(block.inline)}</h${block.level}>`);
        break;
      case 'paragraph':
        out.push(`<p>${renderInline(block.inline)}</p>`);
        break;
      case 'code':
        out.push(
          `<pre${block.lang === '' ? '' : ` data-lang="${escapeHtml(block.lang)}"`}><code>${escapeHtml(
            block.text,
          )}</code></pre>`,
        );
        break;
      case 'quote':
        out.push(`<blockquote>${renderBlocks(block.blocks)}</blockquote>`);
        break;
      case 'hr':
        out.push('<hr>');
        break;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        const items = block.items
          .map((item) => {
            const box =
              item.checked === null
                ? ''
                : `<input type="checkbox" disabled${item.checked ? ' checked' : ''}> `;
            const className = item.checked === null ? '' : ' class="task"';
            return `<li${className}>${box}${renderInline(item.inline)}</li>`;
          })
          .join('');
        out.push(`<${tag}>${items}</${tag}>`);
        break;
      }
      case 'table': {
        const header = block.header.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
        const rows = block.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
          .join('');
        out.push(`<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`);
        break;
      }
      case 'footnoteDef':
        out.push(`<p class="footnote"><sup>${escapeHtml(block.label)}</sup> ${renderInline(block.inline)}</p>`);
        break;
    }
  }
  return out.join('\n');
}

export function markdownToHtml(body: string): string {
  return renderBlocks(parseBlocks(splitFrontmatter(body).body));
}

/**
 * Стили печати. Тема «Бумага», колонка 640, без интерфейса (BEHAVIOR §9).
 *
 * Цвета литеральные — экспортный документ покидает приложение и не может
 * ссылаться на рантайм-токены темы. Но пишутся они не руками: `print-palette.ts`
 * генерируется из `packages/ui/src/styles/tokens.css`
 * (`node scripts/gen-print-palette.mjs`), а тест сторожит синхронность.
 * Раньше значения были зашиты вручную и разъехались с дизайн-системой —
 * подсветка `==текст==` стала золотистой вместо `--accent-soft`.
 */
const PRINT_CSS = `
:root { color-scheme: light; }
body { margin: 0; background: ${C.bg}; color: ${C.text}; font-family: ${F.serif};
  font-size: 17px; line-height: 1.7; }
main { max-width: 640px; margin: 0 auto; padding: 48px 24px 96px; }
h1, h2, h3, h4, h5, h6 { font-family: ${F.sans}; line-height: 1.25; margin: 1.6em 0 0.6em; }
h1 { font-size: 30px; margin-top: 0; }
p { margin: 0 0 1em; }
a { color: ${C.accent}; text-decoration: underline; text-decoration-style: dashed; }
mark { background: ${C.accentSoft}; padding: 0 2px; }
code { font-family: ${F.mono}; font-size: 0.9em; background: ${C.surface}; padding: 1px 4px; border-radius: 4px; }
pre { background: ${C.surface}; padding: 14px 16px; border-radius: 12px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: 0 0 1em; padding-left: 16px; border-left: 2.5px solid ${C.line}; color: ${C.textSecondary}; font-style: italic; }
img { max-width: 100%; border-radius: 12px; }
table { border-collapse: collapse; width: 100%; margin: 0 0 1em; }
th, td { border: 1px solid ${C.line}; padding: 6px 10px; text-align: left; }
th { background: ${C.surface}; }
li.task { list-style: none; margin-left: -1.2em; }
.meta { font-family: ${F.mono}; font-size: 12px; color: ${C.textTertiary}; margin-bottom: 32px; }
.footnote { font-size: 14px; color: ${C.textSecondary}; }
@page { margin: 18mm; }
`;

export interface HtmlExportOptions {
  /** Показывать строку с датами. По умолчанию да. */
  meta?: boolean;
  locale?: string;
}

/** Готовый к печати самодостаточный документ — он же исходник для PDF. */
export function renderPrintableHtml(note: Note, options: HtmlExportOptions = {}): string {
  const showMeta = options.meta ?? true;
  const locale = options.locale ?? 'ru-RU';
  const date = new Date(note.updatedAt).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
  const meta = showMeta ? `<div class="meta">${escapeHtml(date)}</div>` : '';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(note.title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<main>
${meta}
${markdownToHtml(note.body)}
</main>
</body>
</html>`;
}
