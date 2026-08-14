import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { errors } from '../lib/errors.ts';
import { escapeHtml } from '../lib/sanitizeHtml.ts';

/**
 * Юридические документы CMPAS: публикация, версии, неизменяемый архив.
 *
 * ── Что здесь лежит ─────────────────────────────────────────────────────────
 *
 * Тексты пакета «CMPAS Legal Pack v0.9 от 14 августа 2026» — дословно, без
 * единой нашей правки. Их четыре: центральное Пользовательское соглашение,
 * центральная Политика ПДн, Особые условия ЗАПИСОК и рекламное согласие.
 * Остальные три документа пакета (профессиональное соглашение, ПРАКТИКА,
 * МОМЕНТЫ) относятся к другим сервисам Экосистемы и здесь не публикуются.
 *
 * ── Почему на сервере, а не в приложении ────────────────────────────────────
 *
 * Документы правятся без выпуска новой версии приложения, и человек со старой
 * сборкой обязан читать ДЕЙСТВУЮЩУЮ редакцию, а не ту, что вшита в его APK.
 *
 * ── Почему имя файла содержит версию ────────────────────────────────────────
 *
 * Юридическая инструкция §11 требует восстановимости: по записи о принятии
 * должно быть видно, ЧТО именно человек принял. Значит текст версии обязан
 * оставаться доступным и после выхода следующей. Версия в имени файла делает
 * архив естественным: `/legal/terms` показывает текущую, `/legal/terms/0.9` —
 * ту самую. Исправление текста = новый файл с новой версией, правка на месте
 * запрещена.
 *
 * ── Почему пометка «рабочая редакция» ───────────────────────────────────────
 *
 * Так помечен сам пакет: реквизиты Оператора в нём — плейсхолдеры
 * `{{ФИО ОПЕРАТОРА}}`, и заполнить их может только владелец. Придумывать их
 * запрещено прямо (§18, §21), поэтому страница честно говорит, что перед
 * человеком рабочая редакция, а плейсхолдеры видны как есть.
 */

/*
 * Тексты лежат в `server/legal/`, а не в `docs/`: образ API собирается с
 * контекстом `server/` (deploy/api.Dockerfile), и всё, что вне его, в
 * контейнер просто не попадает. Документ, которого нет на диске, — это
 * страница «ничего не нашли» на месте соглашения.
 */
const DOCS_DIR = path.resolve(fileURLToPath(new URL('../../legal', import.meta.url)));

/** Действующая редакция пакета. Меняется вместе с файлами. */
export const LEGAL_PACK_VERSION = '0.9';
const EFFECTIVE_AT = '14 августа 2026 года';

/**
 * Документы и их адреса — по таблице §2 инструкции.
 *
 * `code` — тот же, что в пакете: по нему пишется запись о принятии, и по нему
 * же документ ищется в архиве.
 */
export const LEGAL_DOCUMENTS = {
  terms: {
    code: 'cmpas_terms',
    route: '/legal/terms',
    title: 'Пользовательское соглашение Экосистемы CMPAS',
    /** Принимается действием при создании аккаунта (§3.3). */
    acceptance: 'action' as const,
  },
  privacy: {
    code: 'cmpas_privacy',
    route: '/legal/privacy',
    title: 'Политика обработки персональных данных и конфиденциальности',
    /** Информационный документ: не принимается никогда (§3.2). */
    acceptance: 'none' as const,
  },
  notes: {
    code: 'cmpas_notes_terms',
    route: '/legal/notes',
    title: 'Особые условия ЗАПИСОК',
    acceptance: 'action' as const,
  },
  marketing: {
    code: 'cmpas_marketing_consent',
    route: '/legal/consent/marketing',
    title: 'Согласие на рекламу',
    /** Добровольное согласие, снятое по умолчанию (§3.1). */
    acceptance: 'consent' as const,
  },
} as const;

export type LegalSlug = keyof typeof LEGAL_DOCUMENTS;

/**
 * Прежние адреса `/terms` и `/privacy`.
 *
 * Их знают уже выложенные приложения: ссылка на экране входа вшита в APK,
 * который стоит у человека. Ломать её нельзя — она ведёт на согласие,
 * которое он даёт прямо сейчас. Поэтому старые адреса остаются и отвечают
 * тем же документом.
 */
const LEGACY_ROUTES: Record<string, LegalSlug> = { '/terms': 'terms', '/privacy': 'privacy' };

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
table { width: 100%; border-collapse: collapse; margin: 0 0 20px; font-size: 15px; }
th, td { padding: 8px 10px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
th { background: var(--surface); font-weight: 600; }
.wide { overflow-x: auto; }
a { color: inherit; }
.draft {
  margin: 0 0 28px; padding: 14px 16px; border-radius: 12px;
  background: var(--surface); border: 1px solid var(--line);
  color: var(--warn); font-size: 15px; line-height: 1.5;
}
.docs { margin: 0 0 28px; padding: 0 0 0 22px; color: var(--muted); font-size: 15px; }
.stamp {
  margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 13px; line-height: 1.6; word-break: break-all;
}
.mark { margin-top: 24px; color: var(--muted); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
`;

/**
 * Markdown → HTML для этих документов и только для них.
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

  /*
    Таблицы. В пакете таблицей записаны цели обработки и категории данных — то
    есть самое читаемое место Политики. Развернуть её в вереницу абзацев
    значило бы превратить понятную сетку «цель · данные · основание» в кашу,
    где не видно, что к чему относится.
  */
  let table = false;
  const closeTable = (): void => {
    if (table) {
      out.push('</tbody></table>');
      table = false;
    }
  };
  const cells = (line: string): string[] =>
    line
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());

  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('|') && line.endsWith('|')) {
      /* Строка-разделитель `| --- |` только объявляет таблицу, показывать её
         нечего. */
      if (/^\|[\s|:-]+\|$/.test(line)) continue;
      closeList();
      if (!table) {
        out.push('<table><thead><tr>');
        out.push(cells(line).map((cell) => `<th>${inline(cell)}</th>`).join(''));
        out.push('</tr></thead><tbody>');
        table = true;
        continue;
      }
      out.push(`<tr>${cells(line).map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`);
      continue;
    }
    closeTable();
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
  closeTable();
  return out.join('\n');
}

/** Текст версии и его отпечаток. Отпечаток — от байтов файла, как они есть. */
async function readVersion(slug: LegalSlug, version: string): Promise<{ text: string; hash: string }> {
  let text: string;
  try {
    text = await readFile(path.join(DOCS_DIR, `${slug}-${version}.md`), 'utf8');
  } catch {
    /* Документа нет на диске — это наша беда, и врать про неё нельзя:
       страница согласия обязана либо показать текст, либо честно сказать,
       что его сейчас нет. */
    throw errors.notFound('legal_document_missing');
  }
  return { text, hash: createHash('sha256').update(text, 'utf8').digest('hex') };
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · ЗАПИСКИ</title>
<style>${STYLE}</style>
</head>
<body>
<main class="sheet">
${body}
<p class="mark">Записки</p>
</main>
</body>
</html>`;
}

export async function registerLegalRoutes(app: FastifyInstance): Promise<void> {
  const document = async (slug: LegalSlug, version: string): Promise<string> => {
    const meta = LEGAL_DOCUMENTS[slug];
    const { text, hash } = await readVersion(slug, version);
    const archive = `${meta.route}/${version}`;
    /*
      Штамп внизу — не украшение. По инструкции §11 у опубликованной версии
      обязаны быть номер, дата вступления, отпечаток содержимого и адрес
      неизменяемой копии: без них невозможно доказать, с чем именно человек
      согласился.
    */
    const stamp =
      `<p class="stamp">Редакция ${escapeHtml(version)} · действует с ${escapeHtml(EFFECTIVE_AT)}` +
      `<br>Отпечаток текста (SHA-256): ${escapeHtml(hash)}` +
      `<br>Неизменяемая копия этой редакции: <a href="${escapeHtml(archive)}">${escapeHtml(archive)}</a></p>`;
    const draft =
      '<p class="draft">Рабочая редакция пакета. Реквизиты Оператора в тексте отмечены как ' +
      '<code>{{…}}</code> и будут заполнены владельцем перед финальной публикацией.</p>';
    return page(meta.title, `${draft}\n${renderLegalMarkdown(text)}\n${stamp}`);
  };

  for (const [slug, meta] of Object.entries(LEGAL_DOCUMENTS) as Array<[LegalSlug, { route: string }]>) {
    app.get(meta.route, async (_request, reply) =>
      reply.type('text/html; charset=utf-8').send(await document(slug, LEGAL_PACK_VERSION)),
    );
    /* Архив: адрес версии не меняет содержимого никогда. */
    app.get(`${meta.route}/:version`, async (request, reply) => {
      const version = String((request.params as { version?: string }).version ?? '');
      if (!/^[0-9]+\.[0-9]+$/.test(version)) throw errors.notFound('legal_document_missing');
      return reply.type('text/html; charset=utf-8').send(await document(slug, version));
    });
  }

  for (const [route, slug] of Object.entries(LEGACY_ROUTES)) {
    app.get(route, async (_request, reply) =>
      reply.type('text/html; charset=utf-8').send(await document(slug, LEGAL_PACK_VERSION)),
    );
  }

  /**
   * Реестр сервисов (§2 инструкции).
   *
   * Центральный реестр Экосистемы живёт на cmpas.ru — так сказано в самом
   * Соглашении (п. 1.2), и подменять его собой мы не вправе. Здесь — та часть,
   * за которую отвечает этот сервер: ЗАПИСКИ и их документы.
   */
  app.get('/legal/services', async (_request, reply) => {
    const rows = (['terms', 'privacy', 'notes', 'marketing'] as LegalSlug[])
      .map((slug) => {
        const meta = LEGAL_DOCUMENTS[slug];
        return `<li><a href="${meta.route}">${escapeHtml(meta.title)}</a> — <code>${meta.code}</code></li>`;
      })
      .join('\n');
    return reply.type('text/html; charset=utf-8').send(
      page(
        'Реестр сервисов',
        `<h1>Реестр сервисов</h1>
<p>ЗАПИСКИ — сервис Экосистемы CMPAS: личные заметки в файлах Markdown, синхронизация и экспорт.</p>
<p>Полный реестр сервисов Экосистемы ведёт Оператор по адресу
<a href="https://cmpas.ru/legal/services">cmpas.ru/legal/services</a>.</p>
<h2>Документы, действующие для ЗАПИСОК</h2>
<ul class="docs">
${rows}
</ul>
<p>Редакция пакета ${escapeHtml(LEGAL_PACK_VERSION)}, действует с ${escapeHtml(EFFECTIVE_AT)}.</p>`,
      ),
    );
  });

  /**
   * Машиночитаемый список версий: код документа, версия, дата, отпечаток.
   *
   * Нужен приложению и проверкам: по нему видно, ту ли редакцию показывает
   * клиент, и по нему же сверяется запись о принятии.
   */
  app.get('/api/v1/legal/documents', async (_request, reply) => {
    const documents = await Promise.all(
      (Object.keys(LEGAL_DOCUMENTS) as LegalSlug[]).map(async (slug) => {
        const meta = LEGAL_DOCUMENTS[slug];
        const { hash } = await readVersion(slug, LEGAL_PACK_VERSION);
        return {
          code: meta.code,
          version: LEGAL_PACK_VERSION,
          effectiveAt: EFFECTIVE_AT,
          acceptance: meta.acceptance,
          url: meta.route,
          archiveUrl: `${meta.route}/${LEGAL_PACK_VERSION}`,
          contentHash: hash,
        };
      }),
    );
    return reply.send({ pack: LEGAL_PACK_VERSION, documents });
  });
}
