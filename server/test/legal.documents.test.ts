/**
 * Публикация юридических документов пакета CMPAS.
 *
 * ── Что проверяется ─────────────────────────────────────────────────────────
 *
 * Инструкция §11 требует от каждой опубликованной версии пяти вещей: адрес,
 * номер версии, дату вступления, отпечаток содержимого и восстановимость
 * текста, который действовал в момент принятия. Без последнего невозможно
 * доказать, с чем именно человек согласился, — и §11 прямо называет это
 * запрещённым вариантом реализации.
 *
 * Базы данных здесь не нужно: страницы — статика из файлов, и набор проверок
 * поднимает Fastify только с этими маршрутами. Это осознанно: наборы с базой
 * пропускаются там, где Postgres нет, а публикация документов — то место, где
 * молчаливый пропуск обходится дороже всего.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LEGAL_DOCUMENTS, LEGAL_PACK_VERSION, registerLegalRoutes } from '../src/routes/legal.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await registerLegalRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('документы пакета опубликованы', () => {
  it('все четыре открываются по адресам из таблицы §2', async () => {
    for (const meta of Object.values(LEGAL_DOCUMENTS)) {
      const response = await app.inject({ method: 'GET', url: meta.route });
      expect(response.statusCode, `${meta.route} не открывается`).toBe(200);
      expect(response.body).toContain('<main class="sheet">');
    }
  });

  it('прежние адреса продолжают работать: их знают выложенные сборки', async () => {
    /* Ссылка на экране входа вшита в APK, который стоит у человека. Ломать
       адрес, по которому он читает то, что принимает, нельзя. */
    for (const route of ['/terms', '/privacy']) {
      const response = await app.inject({ method: 'GET', url: route });
      expect(response.statusCode, `${route} перестал отвечать`).toBe(200);
    }
  });

  it('текст — дословно из пакета, а не наш пересказ', async () => {
    const response = await app.inject({ method: 'GET', url: '/legal/notes' });
    /* Пункт 2.3 Особых условий ЗАПИСОК — про то, чего мы не делаем с
       содержимым заметок. Если он исчез, значит текст правили. */
    expect(response.body).toContain('рекламного профилирования');
    expect(response.body).toContain('ОСОБЫЕ УСЛОВИЯ ИСПОЛЬЗОВАНИЯ СЕРВИСА');
  });

  it('ФИО, ОГРНИП, ИНН и адрес Оператора заполнены владельцем — не плейсхолдеры', async () => {
    /* Реквизиты ИП внесены 29 августа 2026 по официальным документам
       (справка Т-Банка, лист записи ЕГРИП) — не выдуманы, §18/§21 это и
       требуют. */
    const response = await app.inject({ method: 'GET', url: '/legal/terms' });
    expect(response.body).not.toContain('{{ФИО ОПЕРАТОРА}}');
    expect(response.body).toContain('Мартынов Илья Николаевич');
    expect(response.body).toContain('324774600361792');
    expect(response.body).toContain('505003226577');
  });

  it('контактные email Оператора остались плейсхолдерами — и страница честно называет себя рабочей редакцией', async () => {
    /* §18 и §21 запрещают их выдумывать. Пока владелец не назвал реальные
       адреса, в тексте обязаны стоять метки — и страница обязана называть
       себя рабочей редакцией. Как только последний плейсхолдер закроют,
       баннер обязан исчезнуть сам (см. `isDraft` в legal.ts) — вот это и
       проверяет второе утверждение теста ниже. */
    const response = await app.inject({ method: 'GET', url: '/legal/terms' });
    expect(response.body).toContain('{{LEGAL_EMAIL}}');
    expect(response.body).toContain('{{SUPPORT_EMAIL}}');
    expect(response.body).toContain('Рабочая редакция');
  });

  it('баннер черновика гаснет сам, когда в тексте не остаётся плейсхолдеров', async () => {
    /* Не полагаемся на память будущей правки: баннер обязан быть функцией от
       содержимого файла, а не отдельной фразой, которую надо не забыть убрать
       в день, когда владелец впишет последний email. Подменяем файл на диске
       временно и убеждаемся, что страница это отражает без единой правки
       кода. */
    const filePath = path.join(ROOT, `legal/terms-${LEGAL_PACK_VERSION}.md`);
    const original = await readFile(filePath, 'utf8');
    const resolved = original.replace(/\{\{[^}]+\}\}/g, 'значение@example.test');
    await writeFile(filePath, resolved, 'utf8');
    try {
      const response = await app.inject({ method: 'GET', url: '/legal/terms' });
      expect(response.body).not.toContain('Рабочая редакция');
      expect(response.body).not.toContain('{{');
    } finally {
      await writeFile(filePath, original, 'utf8');
    }
  });
});

describe('версия восстановима', () => {
  it('на странице есть номер, дата и отпечаток текста', async () => {
    const response = await app.inject({ method: 'GET', url: '/legal/terms' });
    const file = await readFile(path.join(ROOT, `legal/terms-${LEGAL_PACK_VERSION}.md`), 'utf8');
    const hash = createHash('sha256').update(file, 'utf8').digest('hex');

    expect(response.body).toContain(`Редакция ${LEGAL_PACK_VERSION}`);
    expect(response.body).toContain('14 августа 2026 года');
    expect(response.body, 'отпечатка текста нет — доказать редакцию нечем').toContain(hash);
  });

  it('архивный адрес отдаёт ту же самую редакцию', async () => {
    const current = await app.inject({ method: 'GET', url: '/legal/terms' });
    const archived = await app.inject({ method: 'GET', url: `/legal/terms/${LEGAL_PACK_VERSION}` });
    expect(archived.statusCode).toBe(200);
    expect(archived.body).toBe(current.body);
  });

  it('несуществующая редакция отвечает 404, а не текущим текстом', async () => {
    /* Подсунуть человеку текущий текст под видом старого — ровно то, из-за
       чего требование про архив и появилось. */
    const response = await app.inject({ method: 'GET', url: '/legal/terms/0.1' });
    expect(response.statusCode).toBe(404);
  });
});

describe('машиночитаемый список', () => {
  it('отдаёт код, версию, адреса и отпечаток каждого документа', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/legal/documents' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      pack: string;
      documents: Array<{ code: string; contentHash: string; acceptance: string; archiveUrl: string }>;
    };
    expect(body.pack).toBe(LEGAL_PACK_VERSION);
    expect(body.documents).toHaveLength(4);

    const codes = body.documents.map((item) => item.code);
    expect(codes).toContain('cmpas_terms');
    expect(codes).toContain('cmpas_notes_terms');

    /* Политика не принимается никогда (§3.2) — и список обязан говорить это
       вслух, чтобы клиент не завёл ей галочку по недосмотру. */
    const privacy = body.documents.find((item) => item.code === 'cmpas_privacy');
    expect(privacy?.acceptance).toBe('none');

    for (const document of body.documents) {
      expect(document.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(document.archiveUrl).toContain(LEGAL_PACK_VERSION);
    }
  });
});

describe('реестр сервисов', () => {
  it('называет ЗАПИСКИ и ведёт к центральному реестру Экосистемы', async () => {
    const response = await app.inject({ method: 'GET', url: '/legal/services' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('ЗАПИСКИ');
    /* Центральный реестр ведёт Оператор — так сказано в п. 1.2 самого
       Соглашения, и подменять его собой мы не вправе. */
    expect(response.body).toContain('cmpas.ru/legal/services');
  });
});
