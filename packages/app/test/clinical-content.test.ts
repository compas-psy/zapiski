/**
 * Сторож правила клинического контента.
 *
 * `tz/ZAPISKI_TZ_0_Master.md` §7 — правило продукта, обязательное для дизайна,
 * кода и маркетинга: ЗАПИСКИ общегражданский продукт, и мы нигде не предлагаем,
 * не показываем и не подразумеваем хранение в нём данных клиентов помогающих
 * специалистов. Запрещены имена и инициалы клиентов, их цитаты, диагнозы,
 * формулировки «случай N» и «конспект супервизии по клиенту». В Definition of
 * Done это отдельная строка: «Ни одного клинического демо-данного в коде,
 * фикстурах, тестах и скриншотах».
 *
 * Почему тест, а не внимательность. Клиническая демо-строка появляется не по
 * злому умыслу, а потому что она удобная: когда нужен «очень приватный текст»
 * для проверки утечки, сеанс с клиентом и диагноз пишутся сами. Ровно так они
 * и оказались в фикстурах zero-knowledge — и пережили несколько ревью.
 *
 * `3_Agents.md` §7 добавляет: это решение не делегируется агенту и «если агент
 * предлагает демо-данные с клиентом, сессией или диагнозом — это отклоняется
 * без обсуждения». Тест и есть форма такого отклонения.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');

/**
 * Где ищем. Это поверхности, которые доезжают до пользователя или до
 * скриншота: исходники, фикстуры, тесты, документация продукта и эталон
 * дизайна.
 */
const SCANNED = [
  'packages/app/src',
  'packages/app/test',
  'packages/core/src',
  'packages/core/test',
  'packages/editor/src',
  'packages/editor/test',
  'packages/ui/src',
  'packages/ui/test',
  'apps',
  'server/src',
  'docs/user',
  'docs/product',
  'docs/spec/ЗАПИСКИ-Дизайн.reference.html',
];

/**
 * Куда не ходим — и почему именно туда.
 *
 * `docs/spec/tz/**` и `docs/spec/source_tz/**` — тексты заказчика. Само правило
 * §7 перечисляет запрещённые формулировки, чтобы их запретить; ловить его на
 * собственной цитате — значит требовать переписать ТЗ.
 * `docs/dev/security/**` разбирает утечки путей и вынужден называть, что
 * именно утекает, — но и там демо-данные уже заменены на неклинические.
 */
const GENERATED = new Set(['node_modules', 'dist', 'build', 'target', 'gen', '.gradle']);
const TEXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.html', '.md', '.json', '.xml', '.kt', '.rs', '.svg']);

/**
 * Запрещённые формулировки. Каждая — из §7 дословно или её прямая форма.
 *
 * Слово «клиент» само по себе НЕ запрещено и в список не входит: клиентом
 * называется и стороннее приложение синхронизации («папка, которую синкает
 * сторонний клиент»), и http-клиент. Запрещено «клиент» в человеческом
 * смысле — с инициалом, в родительном падеже рядом с сеансом, в кавычках.
 * Поэтому шаблоны узкие и каждый назван.
 */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /случа[йея]\s+[А-ЯЁ]\./g, why: '«случай N» — §7 запрещает прямо' },
  { pattern: /клиент(?:а|ки|ке|ку|ом|ов|ам)?\s+[А-ЯЁ]\./g, why: 'инициал клиента' },
  { pattern: /Клиент\s+[А-ЯЁ](?:\.|\b)/g, why: 'имя клиента в заголовке или пути' },
  { pattern: /сеанс\s+с\s+клиент/gi, why: 'сеанс с клиентом' },
  { pattern: /сесси[ияю]\s+с\s+клиент/gi, why: 'сессия с клиентом' },
  { pattern: /конспект\s+супервизии\s+—?\s*случа/gi, why: '«конспект супервизии по клиенту» — §7' },
  { pattern: /диагноз/gi, why: 'диагноз' },
  { pattern: /карточк[ауи]\s+клиента/gi, why: 'карточка клиента — связь односторонняя, §1.2' },
  { pattern: /цитата\s+клиент/gi, why: 'цитата клиента' },
  { pattern: /формулировка\s+клиент/gi, why: 'прямая речь клиента' },
];

interface Hit {
  file: string;
  line: number;
  text: string;
  why: string;
}

function walk(target: string, found: string[] = []): string[] {
  const stat = statSync(target);
  if (!stat.isDirectory()) {
    if (TEXT.has(extname(target).toLowerCase())) found.push(target);
    return found;
  }
  for (const entry of readdirSync(target)) {
    if (GENERATED.has(entry)) continue;
    walk(join(target, entry), found);
  }
  return found;
}

/* Сам сторож из обхода исключён: он обязан цитировать запрещённые
   формулировки — иначе нечем ловить, — и на собственных шаблонах краснел бы
   вечно. Проверка «сторож умеет краснеть» ниже гоняет их по этим же
   цитатам, так что исключение ничего не ослабляет. */
const SELF = resolve(__dirname, 'clinical-content.test.ts');

const files = SCANNED.flatMap((relativePath) => walk(resolve(REPO_ROOT, relativePath))).filter(
  (file) => file !== SELF,
);

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      for (const { pattern, why } of FORBIDDEN) {
        pattern.lastIndex = 0;
        if (pattern.test(text)) {
          hits.push({ file: relative(REPO_ROOT, file), line: index + 1, text: text.trim().slice(0, 160), why });
        }
      }
    });
  }
  return hits;
}

describe('правило клинического контента (0_Master.md §7)', () => {
  it('обход вообще что-то нашёл — иначе сторож проверяет пустоту', () => {
    expect(files.length).toBeGreaterThan(200);
    const seen = files.map((file) => relative(REPO_ROOT, file));
    /* Файлы, в которых клиника уже заводилась: фикстуры «очень приватного
       текста» и эталон дизайна со скриншотами для сторов. */
    for (const required of [
      'packages/core/test/security.zero-knowledge.test.ts',
      'packages/app/test/security.unlock-delay.test.ts',
      'docs/spec/ЗАПИСКИ-Дизайн.reference.html',
    ]) {
      expect(seen, `${required} выпал из обхода`).toContain(required);
    }
  });

  it('ни одного клинического демо-данного', () => {
    const hits = scan().map((hit) => `${hit.file}:${hit.line} (${hit.why}): ${hit.text}`);
    expect(
      hits,
      'Клинические демо-данные вернулись. §7: заметки о клиентах живут в ' +
        'приложении практики, а не здесь. Замена той же тональности — ' +
        'конспект книги или вебинара, дневник, списки, планы (§1.3).',
    ).toEqual([]);
  });

  it('сторож умеет краснеть: шаблоны ловят то, ради чего написаны', () => {
    // Ровно те строки, что лежали в фикстурах и в эталоне.
    const samples = [
      "const SECRET = '# Дневник\\n\\nСеанс с клиентом К., диагноз и телефон';",
      "await backend.put('Практика/Клиент К.md', utf8(SECRET));",
      '<div>Конспект супервизии — случай М.</div>',
      'КОМПАС.Дневник → карточка клиента',
      'Опорная формулировка клиентки — «тишина после вопроса»',
    ];
    for (const sample of samples) {
      const caught = FORBIDDEN.some(({ pattern }) => {
        pattern.lastIndex = 0;
        return pattern.test(sample);
      });
      expect(caught, `${sample} проехал мимо сторожа`).toBe(true);
    }
    // И не краснеет там, где краснеть не на что: разрешённые §7 темы и
    // «клиент» в техническом смысле.
    for (const sample of [
      'папка, которую синкает сторонний клиент',
      'Конспект книги — «Ясность и внимание»',
      '#практика/супервизия',
      'describe(«клиент облака», () => {',
      'Заметки с вебинара · чек-лист переезда кабинета · планы месяца',
    ]) {
      const caught = FORBIDDEN.some(({ pattern }) => {
        pattern.lastIndex = 0;
        return pattern.test(sample);
      });
      expect(caught, `${sample} — ложная тревога`).toBe(false);
    }
  });
});
