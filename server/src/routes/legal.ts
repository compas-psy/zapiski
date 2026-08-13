import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { errors } from '../lib/errors.ts';
import { escapeHtml } from '../lib/sanitizeHtml.ts';

/**
 * Документы, на которые человек даёт согласие: `/terms` и `/privacy`.
 *
 * ── Почему они на сервере, а не в приложении ────────────────────────────────
 *
 * Документы правятся без выпуска новой версии приложения, и человек со старой
 * сборкой обязан читать ДЕЙСТВУЮЩУЮ редакцию, а не ту, что вшита в его
 * установленный APK.
 *
 * ── Почему пометка «черновик» ───────────────────────────────────────────────
 *
 * Тексты написаны разработчиком, а не юристом. Инженерная часть в них точна —
 * что именно собирается и зачем, — но формулировки, реквизиты оператора и
 * сроки обязан выверить юрист. Пока этого не случилось, страница честно
 * говорит, что перед человеком черновик: документ, который ВЫГЛЯДИТ
 * утверждённым, не будучи им, — обман, а честный черновик обманом не является.
 *
 * Снять пометку: `DRAFT = false` после юридической проверки.
 */
const DRAFT = true;

/*
 * Тексты лежат в `server/legal/`, а не в `docs/`: образ API собирается с
 * контекстом `server/` (deploy/api.Dockerfile), и всё, что вне его, в
 * контейнер просто не попадает. Документ, которого нет на диске, — это
 * страница «ничего не нашли» на месте соглашения.
 */
const DOCS_DIR = path.resolve(fileURLToPath(new URL('../../legal', import.meta.url)));

const PAGES = {
  terms: { file: 'terms.md', title: 'Пользовательское соглашение' },
  privacy: { file: 'privacy.md', title: 'Политика обработки персональных данных' },
} as const;

const STYLE = `
:root { --bg:#FBFAF7; --surface:#F3F1EA; --line:#EAE6DB; --text:#38342E; --muted:#8A8375; --warn:#8A6A1F; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#232120; --surface:#2C2A28; --line:#393630; --text:#E9E5DC; --muted:#9B948A; --warn:#D2AC5A; }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 17px; line-height: 1.7;
}
.sheet { max-width: 680px; margin: 0 auto; padding: 56px 24px 96px; }
h1 { font-size: 30px; line-height: 1.2; margin: 0 0 24px; }
h2 { font-size: 20px; margin: 36px 0 12px; }
p, li { margin: 0 0 14px; }
ul { padding-left: 22px; }
strong { font-weight: 600; }
.draft {
  margin: 0 0 28px; padding: 14px 16px; border-radius: 12px;
  background: var(--surface); border: 1px solid var(--line);
  color: var(--warn); font-size: 15px; line-height: 1.5;
}
.mark { margin-top: 40px; color: var(--muted); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
`;

/**
 * Markdown → HTML для этих двух документов и только для них.
 *
 * Полноценный конвертер здесь не нужен и вреден: чем он мощнее, тем больше в
 * нём поверхностей. Разбираются ровно те построения, которые в документах и
 * используются, а всё остальное едет экранированным текстом.
 */
export function renderLegalMarkdown(markdown: string): string {
  const out: string[] = [];
  let list = false;
  const closeList = (): void => {
    if (list) {
      out.push('</ul>');
      list = false;
    }
  };
  const inline = (text: string): string =>
    escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      closeList();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (line.startsWith('# ')) {
      closeList();
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
    } else if (line.startsWith('- ')) {
      if (!list) {
        out.push('<ul>');
        list = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}

export async function registerLegalRoutes(app: FastifyInstance): Promise<void> {
  for (const [slug, page] of Object.entries(PAGES)) {
    app.get(`/${slug}`, async (_request, reply) => {
      let markdown: string;
      try {
        markdown = await readFile(path.join(DOCS_DIR, page.file), 'utf8');
      } catch {
        /* Документа нет на диске — это наша беда, и врать про неё нельзя:
           страница согласия обязана либо показать текст, либо честно сказать,
           что его сейчас нет. */
        throw errors.notFound('legal_document_missing');
      }

      const draft = DRAFT
        ? '<p class="draft">Черновик. Текст готовится к юридической проверке и будет уточнён.</p>'
        : '';

      return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(page.title)} · ЗАПИСКИ</title>
<style>${STYLE}</style>
</head>
<body>
<main class="sheet">
${draft}
${renderLegalMarkdown(markdown)}
<p class="mark">Записки</p>
</main>
</body>
</html>`);
    });
  }
}
