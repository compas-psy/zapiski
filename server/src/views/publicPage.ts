import { escapeHtml } from '../lib/sanitizeHtml.ts';

/**
 * Публичная страница — SCREENS §10b `4j`.
 *
 * Дословно по спецификации: колонка 620, Source Serif 4, дата моно, H1 40/600,
 * лид 19 secondary, линия, текст 18/1.75, цитата с левой линией, подвал
 * «Опубликовано из ЗАПИСОК · только чтение» + вордмарк.
 *
 * И столь же дословно — чего здесь нет: ни шапки, ни кнопок, ни призывов
 * установить приложение, ни счётчиков, ни аналитики (ТЗ §6: аналитика opt-in,
 * а посетитель чужой страницы согласия не давал).
 *
 * Цвета — значения токенов `paper` и `graphite` из DESIGN_TOKENS.md. Страница
 * автономна: собственный тег `<style>` и ни одного обращения к CDN, иначе
 * визит утекал бы третьей стороне.
 */

export interface PublicDocument {
  title: string;
  lead: string | null;
  /** Уже пропущенный через белый список HTML. */
  html: string;
  publishedAt: string;
}

const STYLE = `
:root {
  --bg:#FBFAF7; --surface:#F3F1EA; --line:#EAE6DB;
  --text:#38342E; --text-secondary:#8A8375; --text-tertiary:#B6AFA2;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#232120; --surface:#2C2A28; --line:#393630;
    --text:#E9E5DC; --text-secondary:#9B948A; --text-tertiary:#6E675C;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: 'Source Serif 4', 'Source Serif Pro', Georgia, 'Times New Roman', serif;
  font-size: 18px;
  line-height: 1.75;
  text-rendering: optimizeLegibility;
}
.sheet { max-width: 620px; margin: 0 auto; padding: 72px 24px 96px; }
.date {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px; letter-spacing: .02em; color: var(--text-tertiary);
  margin: 0 0 20px; text-transform: lowercase;
}
h1 { font-size: 40px; line-height: 1.15; font-weight: 600; margin: 0 0 20px; letter-spacing: -.01em; }
.lead { font-size: 19px; line-height: 1.6; color: var(--text-secondary); margin: 0 0 28px; }
.rule { border: 0; border-top: 1px solid var(--line); margin: 0 0 36px; }
.body > :first-child { margin-top: 0; }
.body > :last-child { margin-bottom: 0; }
.body p { margin: 0 0 22px; }
.body h2 { font-size: 27px; line-height: 1.25; font-weight: 600; margin: 44px 0 16px; }
.body h3 { font-size: 22px; line-height: 1.3; font-weight: 600; margin: 36px 0 14px; }
.body h4, .body h5, .body h6 { font-size: 19px; font-weight: 600; margin: 30px 0 12px; }
.body ul, .body ol { margin: 0 0 22px; padding-left: 26px; }
.body li { margin: 0 0 8px; }
.body blockquote {
  margin: 0 0 22px; padding: 2px 0 2px 20px;
  border-left: 2px solid var(--line); color: var(--text-secondary);
}
.body a { color: inherit; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--text-tertiary); }
.body img { max-width: 100%; height: auto; border-radius: 10px; display: block; margin: 0 0 22px; }
.body figure { margin: 0 0 22px; }
.body figcaption { font-size: 14px; color: var(--text-tertiary); margin-top: 8px; }
.body hr { border: 0; border-top: 1px solid var(--line); margin: 36px 0; }
.body code, .body kbd, .body samp {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .87em; background: var(--surface); padding: 1px 5px; border-radius: 5px;
}
.body pre {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--surface); padding: 16px 18px; border-radius: 12px;
  overflow-x: auto; font-size: 14.5px; line-height: 1.6; margin: 0 0 22px;
}
.body pre code { background: none; padding: 0; font-size: inherit; }
.body table { width: 100%; border-collapse: collapse; margin: 0 0 22px; font-size: 16px; }
.body th, .body td { border-bottom: 1px solid var(--line); padding: 9px 10px; text-align: left; }
.body th { font-weight: 600; }
.body mark { background: var(--surface); padding: 0 3px; border-radius: 4px; }
.foot {
  margin-top: 72px; padding-top: 22px; border-top: 1px solid var(--line);
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px; color: var(--text-tertiary);
  display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
}
.wordmark { letter-spacing: .16em; font-weight: 500; }
@media (max-width: 680px) {
  .sheet { padding: 48px 20px 72px; }
  h1 { font-size: 32px; }
  body { font-size: 17px; }
}
@media print {
  body { background: #fff; color: #000; }
  .foot { border-color: #ddd; }
}
`.trim();

export function renderPublicPage(document: PublicDocument): string {
  const title = escapeHtml(document.title);
  const lead =
    document.lead !== null && document.lead.length > 0
      ? `<p class="lead">${escapeHtml(document.lead)}</p>`
      : '';

  return [
    '<!doctype html>',
    '<html lang="ru">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Ни одной внешней ссылки: страница не сообщает о визите никому.
    '<meta name="referrer" content="no-referrer">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${title}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<article class="sheet">',
    `<p class="date">${escapeHtml(formatDate(document.publishedAt))}</p>`,
    `<h1>${title}</h1>`,
    lead,
    '<hr class="rule">',
    `<div class="body">${document.html}</div>`,
    '<footer class="foot">',
    '<span>Опубликовано из ЗАПИСОК · только чтение</span>',
    '<span class="wordmark">ЗАПИСКИ</span>',
    '</footer>',
    '</article>',
    '</body>',
    '</html>',
  ].join('');
}

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

/** Дата по-русски: «9 августа 2026». */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`;
}
