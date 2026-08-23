/**
 * Диагностический шаг выкладки не должен врать о причине.
 *
 * ── Что случилось ────────────────────────────────────────────────────────────
 *
 * Шаг «Проверить аналитику и мост в ПРАКТИКУ» считал события так:
 * `count(*) FILTER (WHERE created_at > now() - interval '1 day')`. Колонки
 * `created_at` в `analytics_events` нет и никогда не было — она называется
 * `received_at` (`server/migrations/0005_analytics_events.sql`). psql ответил
 * `ERROR: column "created_at" does not exist`, сработал `||`-фолбэк, и в лог
 * выкладки ушло «таблицы analytics_events нет или база не ответила».
 *
 * Оба утверждения были ложью: таблица есть, база ответила. Диагностика,
 * которая на свою же опечатку отвечает диагнозом про чужую поломку, хуже
 * молчания — молчание хотя бы не уводит в сторону.
 *
 * ── Что стережём ─────────────────────────────────────────────────────────────
 *
 * 1. Каждое имя колонки, которое диагностика упоминает у известной ей таблицы,
 *    существует в миграциях. Это ловит ровно ту опечатку и любую следующую.
 * 2. Фолбэки этих запросов не утверждают причину, которую не проверяли:
 *    «таблицы нет», «база не ответила», «событий нет» — это выводы, а отказ
 *    запроса их не даёт.
 *
 * Сверка идёт по ТЕКСТУ настоящего workflow и настоящих миграций — поднять
 * Postgres в этом тесте нельзя, но опечатка в имени колонки видна и так.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/deploy-zapiski.yml');
const MIGRATIONS = path.join(ROOT, 'server/migrations');

const workflow = readFileSync(WORKFLOW, 'utf8');

/** Таблицы, по которым диагностика задаёт вопросы, и их колонки из миграций. */
const WATCHED_TABLES = ['analytics_events', 'users'] as const;

/**
 * Колонки таблицы, собранные из ВСЕХ миграций: и `CREATE TABLE`, и
 * последующие `ALTER TABLE ... ADD COLUMN` (practice_forwarded_at и
 * practice_reject_reason приезжают именно так, в 0010 и 0011).
 */
function columnsOf(table: string): Set<string> {
  const columns = new Set<string>();
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const name of files) {
    const sql = readFileSync(path.join(MIGRATIONS, name), 'utf8');

    const create = new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i');
    const body = create.exec(sql)?.[1];
    if (body !== undefined) {
      for (const line of body.split('\n')) {
        const bare = line.trim();
        if (bare === '' || bare.startsWith('--')) continue;
        const column = /^([a-z_][a-z0-9_]*)\s/i.exec(bare)?.[1];
        if (column !== undefined && !/^(primary|unique|foreign|constraint|check)$/i.test(column)) {
          columns.add(column);
        }
      }
    }

    const alters = sql.matchAll(
      new RegExp(`ALTER TABLE\\s+${table}\\s+ADD COLUMN\\s+(?:IF NOT EXISTS\\s+)?([a-z_][a-z0-9_]*)`, 'gi'),
    );
    for (const match of alters) if (match[1] !== undefined) columns.add(match[1]);

    // Форма 0010: ALTER TABLE t \n ADD COLUMN a ..., \n ADD COLUMN b ...;
    const grouped = new RegExp(`ALTER TABLE\\s+${table}\\s*\\n([\\s\\S]*?);`, 'gi');
    for (const match of sql.matchAll(grouped)) {
      const chunk = match[1];
      if (chunk === undefined) continue;
      for (const add of chunk.matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
        if (add[1] !== undefined) columns.add(add[1]);
      }
    }
  }
  return columns;
}

/**
 * Тела всех psql-запросов диагностики: то, что стоит в кавычках после `-c \`.
 * Закрывающая кавычка — та, за которой идёт продолжение строки (` \`), иначе
 * выборка утекала бы в соседний shell-текст и тест ругался бы на слова вроде
 * `deploy_key`, которых в SQL нет вовсе.
 */
function diagnosticQueries(): string[] {
  const queries: string[] = [];
  const pattern = /psql -U zapiski -d zapiski -At -c \\\n\s*"([\s\S]*?)"\s*\\\n/g;
  for (const match of workflow.matchAll(pattern)) {
    if (match[1] !== undefined) queries.push(match[1]);
  }
  return queries;
}

describe('диагностика выкладки: SQL против настоящей схемы', () => {
  it('запросы вообще найдены — иначе тест зелен впустую', () => {
    expect(diagnosticQueries().length).toBeGreaterThanOrEqual(3);
  });

  it.each(WATCHED_TABLES)('в миграциях есть колонки таблицы %s', (table) => {
    expect(columnsOf(table).size).toBeGreaterThan(0);
  });

  it('ни один запрос не упоминает колонку, которой нет в миграциях', () => {
    const known = new Map(WATCHED_TABLES.map((table) => [table, columnsOf(table)]));
    const unknown: string[] = [];

    for (const query of diagnosticQueries()) {
      const table = WATCHED_TABLES.find((name) => new RegExp(`FROM\\s+${name}\\b`, 'i').test(query));
      if (table === undefined) continue;
      const columns = known.get(table);
      if (columns === undefined) continue;

      // Слова-кандидаты: всё, что похоже на идентификатор и не является
      // ключевым словом SQL, литералом в кавычках или именем таблицы.
      const withoutLiterals = query.replace(/'[^']*'/g, "''");
      const RESERVED = new Set([
        'select', 'from', 'where', 'group', 'by', 'order', 'limit', 'count', 'filter',
        'coalesce', 'is', 'not', 'null', 'and', 'or', 'desc', 'asc', 'text', 'now',
        'interval', 'day', 'as', 'case', 'when', 'then', 'else', 'end', 'distinct',
      ]);
      for (const word of withoutLiterals.matchAll(/[a-z_][a-z0-9_]*/gi)) {
        const name = word[0].toLowerCase();
        if (RESERVED.has(name)) continue;
        if ((WATCHED_TABLES as readonly string[]).includes(name)) continue;
        if (!columns.has(name)) unknown.push(`${table}.${name}`);
      }
    }

    expect(unknown).toEqual([]);
  });

  it('фолбэк не выдаёт отказ запроса за отсутствие таблицы или событий', () => {
    // Ровно та формулировка, что соврала: отказ psql печатался как вывод про
    // отсутствие таблицы. Причину отказа знает только строка ERROR от самого
    // psql — фолбэк обязан отсылать к ней, а не подменять её догадкой.
    const step = workflow.slice(workflow.indexOf('Проверить аналитику и мост в ПРАКТИКУ'));
    const body = step.slice(0, step.indexOf('\n      - name:'));
    expect(body).not.toMatch(/таблицы analytics_events нет/);
    expect(body).not.toMatch(/\|\| echo "событий нет/);
  });
});
