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

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
      case 'link':
        out += `<a href="${escapeHtml(node.href)}">${renderInline(node.children)}</a>`;
        break;
      case 'wiki':
        out += `<a class="wiki" href="${escapeHtml(node.target)}.html">${escapeHtml(
          node.label === '' ? node.target : node.label,
        )}</a>`;
        break;
      case 'image':
        out += `<img src="${escapeHtml(node.src)}" alt="${escapeHtml(node.alt)}">`;
        break;
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
 * Значения зашиты здесь намеренно: экспортный документ покидает приложение и
 * не может зависеть от рантайм-токенов темы.
 */
const PRINT_CSS = `
:root { color-scheme: light; }
body { margin: 0; background: #FBFAF7; color: #1D1B18; font-family: "Georgia", "Iowan Old Style", serif;
  font-size: 17px; line-height: 1.62; }
main { max-width: 640px; margin: 0 auto; padding: 48px 24px 96px; }
h1, h2, h3, h4, h5, h6 { font-family: "Inter", "Segoe UI", system-ui, sans-serif; line-height: 1.25; margin: 1.6em 0 0.6em; }
h1 { font-size: 30px; margin-top: 0; }
p { margin: 0 0 1em; }
a { color: #2F6F5E; }
mark { background: #F3E7B8; padding: 0 2px; }
code { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 0.9em; background: #F1EFE9; padding: 1px 4px; border-radius: 4px; }
pre { background: #F1EFE9; padding: 14px 16px; border-radius: 12px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: 0 0 1em; padding-left: 16px; border-left: 2px solid #D9D5CB; color: #55524B; }
img { max-width: 100%; border-radius: 12px; }
table { border-collapse: collapse; width: 100%; margin: 0 0 1em; }
th, td { border: 1px solid #D9D5CB; padding: 6px 10px; text-align: left; }
li.task { list-style: none; margin-left: -1.2em; }
.meta { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px; color: #8A867D; margin-bottom: 32px; }
.footnote { font-size: 14px; color: #55524B; }
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
