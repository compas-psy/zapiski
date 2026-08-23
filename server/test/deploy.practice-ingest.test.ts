/**
 * Самонастройка моста в приёмник ПРАКТИКИ на выкладке (G-Z1, `deploy/
 * deploy-production-remote.sh`).
 *
 * ── Чего не хватало ──────────────────────────────────────────────────────────
 *
 * `createPracticeBridge` (`server/src/services/practiceBridge.ts`) включается,
 * только когда заданы ОБА `PRACTICE_INGEST_URL` и `PRACTICE_INGEST_SECRET`.
 * До этой правки скрипт выкладки их вообще не касался — учредителю пришлось бы
 * прописывать секрет на сервере руками и вручную согласовывать его значение с
 * соседним продуктом (ПРАКТИКА), у которого этот же секрет генерируется сам
 * (`ANALYTICS_INGEST_SECRET`) и пишется в общий на обе выкладки файл
 * `/etc/simpas/ingest-secret` (права 600, владелец root) при каждом её
 * деплое.
 *
 * ── Что проверяется ──────────────────────────────────────────────────────────
 *
 * Скрипт исполняется НА СЕРВЕРЕ и не имеет модульных границ — поэтому, как и
 * `deploy.cors.test.ts`/`deploy.ssh-timeouts.test.ts`, часть проверок читает
 * его текст. Но три конкретных правила разрешения секрета (G-Z3: «секрет
 * берётся из файла», «заданное окружением не перебивается», «отсутствие файла
 * оставляет мост выключенным и печатает это в лог») — это утверждения про
 * ПОВЕДЕНИЕ, а не про текст, и голым чтением строк их не доказать. Точного
 * прецедента с исполнением bash в этом репозитории нет (см. поиск вокруг
 * `deploy/` в других тестах), поэтому здесь функция `resolve_practice_ingest`
 * выполняется НАСТОЯЩИМ bash, взятым из НАСТОЯЩЕГО файла скрипта (`source`,
 * не копия и не пересказ) — с `ENV_FILE` и `SHARED_INGEST_SECRET_FILE`,
 * подменёнными на временные пути ПОСЛЕ `source`. `main` при этом не
 * вызывается: последняя строка скрипта запускает его только при прямом
 * исполнении (`BASH_SOURCE[0] == $0`), а не при `source`, — иначе тест поднял
 * бы docker и стучался бы на настоящий cmpas.ru.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../deploy/deploy-production-remote.sh',
);
const source = readFileSync(SCRIPT, 'utf8');

/** Адрес приёмника ПРАКТИКИ, подтверждённый ПО КОДУ приёмника (не со слов):
 * `src/app/api/ingest/route.ts` лежит по маршруту App Router `/api/ingest`,
 * без `basePath` (`next.config.ts` его не задаёт) — то есть на домене
 * ПРАКТИКИ ровно `/api/ingest`. Тот же литерал уже используют
 * `practice-bridge.test.ts` и `env.ts` для действующего адреса ПРАКТИКИ. */
const EXPECTED_DEFAULT_URL = 'https://cmpas.ru/api/ingest';

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface RunOptions {
  /** Содержимое deploy/.env ДО вызова функции. По умолчанию — пустой файл. */
  envFileContent?: string;
  /** Содержимое общего файла секрета. Пропущено => файла нет вовсе. */
  sharedFileContent?: string;
  /**
   * Содержимое запасной копии, которую выкладка ПРАКТИКИ кладёт внутрь
   * /var/www/zapiski и отдаёт владельцу ЭТОГО каталога. Нужна ровно на
   * случай, когда выкладка ЗАПИСОК идёт не от root и канонический файл
   * (600, root) ей не читается. Пропущено => копии нет.
   */
  localFileContent?: string;
  /** PRACTICE_INGEST_SECRET в окружении ssh-сессии, если задан. */
  envVar?: string;
}

interface RunResult {
  stdout: string;
  /** Итоговое содержимое deploy/.env после вызова функции. */
  envContent: string;
}

/** Выполняет resolve_practice_ingest() из настоящего скрипта в изоляции. */
function run(opts: RunOptions): RunResult {
  const dir = mkdtempSync(path.join(tmpdir(), 'zapiski-deploy-test-'));
  cleanupDirs.push(dir);

  const envFile = path.join(dir, '.env');
  writeFileSync(envFile, opts.envFileContent ?? '', { mode: 0o600 });

  const sharedFile = path.join(dir, 'ingest-secret');
  if (opts.sharedFileContent !== undefined) {
    writeFileSync(sharedFile, opts.sharedFileContent, { mode: 0o600 });
  }
  // Иначе sharedFile просто не существует — ровно случай «общего файла нет».

  const localFile = path.join(dir, 'local-ingest-secret');
  if (opts.localFileContent !== undefined) {
    writeFileSync(localFile, opts.localFileContent, { mode: 0o600 });
  }

  const harness = [
    'set -Eeuo pipefail',
    `source '${SCRIPT}'`,
    // Подмена ПОСЛЕ source: сам скрипт компьютерует эти пути от
    // BASH_SOURCE[0] на настоящий репозиторий, и трогать его /var/www или
    // deploy/.env из теста нельзя. LOCAL_INGEST_SECRET_FILE подменяется по
    // той же причине и обязательно: без подмены тест читал бы настоящий
    // /var/www/zapiski/.ingest-secret машины, на которой его запустили.
    `ENV_FILE='${envFile}'`,
    `SHARED_INGEST_SECRET_FILE='${sharedFile}'`,
    `LOCAL_INGEST_SECRET_FILE='${localFile}'`,
    'resolve_practice_ingest',
  ].join('\n');

  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  if (opts.envVar !== undefined) env['PRACTICE_INGEST_SECRET'] = opts.envVar;

  const stdout = execFileSync('bash', ['-c', harness], { env, encoding: 'utf8' });

  return { stdout, envContent: readFileSync(envFile, 'utf8') };
}

/** Значение ключа из содержимого .env, или undefined, если ключа нет. */
function envValue(content: string, key: string): string | undefined {
  const line = content.split('\n').find((row) => row.startsWith(`${key}=`));
  return line?.slice(key.length + 1);
}

describe('bash -n', () => {
  it('изменённый скрипт синтаксически валиден', () => {
    // То же самое, чем это стережёт preflight деплоя (.github/workflows/
    // deploy-zapiski.yml, шаг «Проверить скрипты, исполняемые на сервере») —
    // здесь ещё и локально, без ожидания CI.
    expect(() => execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })).not.toThrow();
  });
});

describe('мост в ПРАКТИКУ: разрешение секрета на выкладке (G-Z1)', () => {
  it('секрет берётся из общего файла, когда ничего не задано руками', () => {
    const { stdout, envContent } = run({ sharedFileContent: 'shared-secret-value\n' });

    expect(envValue(envContent, 'PRACTICE_INGEST_SECRET')).toBe('shared-secret-value');
    expect(envValue(envContent, 'PRACTICE_INGEST_URL')).toBe(EXPECTED_DEFAULT_URL);
    expect(stdout, 'лог обязан назвать источник секрета').toMatch(/ingest-secret/);
  });

  it('заданное в окружении ssh-сессии не перебивается общим файлом', () => {
    const { envContent } = run({
      envVar: 'from-ssh-env',
      sharedFileContent: 'from-shared-file',
    });

    expect(envValue(envContent, 'PRACTICE_INGEST_SECRET')).toBe('from-ssh-env');
  });

  it('заданное руками в deploy/.env не перебивается общим файлом', () => {
    const { envContent } = run({
      envFileContent: 'PRACTICE_INGEST_SECRET=from-dotenv\n',
      sharedFileContent: 'from-shared-file',
    });

    expect(envValue(envContent, 'PRACTICE_INGEST_SECRET')).toBe('from-dotenv');
  });

  it('заданный руками PRACTICE_INGEST_URL не перебивается умолчанием', () => {
    const { envContent } = run({
      envFileContent: 'PRACTICE_INGEST_URL=https://staging.example.test/ingest\n',
      sharedFileContent: 'shared-secret',
    });

    expect(envValue(envContent, 'PRACTICE_INGEST_URL')).toBe('https://staging.example.test/ingest');
  });

  it('отсутствие общего файла и переменных оставляет мост выключенным и говорит об этом в логе', () => {
    const { stdout, envContent } = run({});

    expect(envValue(envContent, 'PRACTICE_INGEST_SECRET')).toBeUndefined();
    // createPracticeBridge требует url И secret вместе (practiceBridge.ts) —
    // раз секрета нет, мост не поднимется, даже если URL проставлен.
    expect(envValue(envContent, 'PRACTICE_INGEST_URL')).toBe(EXPECTED_DEFAULT_URL);
    expect(stdout, 'молчания вместо явного предупреждения быть не должно').toMatch(/ВНИМАНИЕ/);
    expect(stdout).toMatch(/выключен/i);
  });

  it('пустой общий файл — то же самое, что его отсутствие', () => {
    const { stdout, envContent } = run({ sharedFileContent: '' });

    expect(envValue(envContent, 'PRACTICE_INGEST_SECRET')).toBeUndefined();
    expect(stdout).toMatch(/ВНИМАНИЕ/);
  });
});

describe('умолчание PRACTICE_INGEST_URL проверено по коду приёмника', () => {
  it('в скрипте зашит адрес, подтверждённый маршрутом ПРАКТИКИ', () => {
    expect(source).toContain(EXPECTED_DEFAULT_URL);
  });
});

describe('комментарий о межпродуктовой границе (G-Z2)', () => {
  it('назван писатель файла — выкладка ПРАКТИКИ', () => {
    expect(source).toMatch(/ПИШЕТ[^\n]*\n[\s\S]{0,400}ПРАКТИК/);
  });

  it('назван читатель — эта выкладка', () => {
    expect(source).toMatch(/ЧИТАЕТ/);
  });

  it('объяснено, почему файл, а не переменная окружения CI', () => {
    // Суть объяснения: у продуктов разные репозитории и разные хранилища
    // секретов GitHub, поэтому ни один пайплайн не видит секрет другого
    // напрямую — общий файл на общей машине единственная точка совпадения.
    expect(source).toMatch(/разн(ые|ых)[^\n]*(репозитор|секрет)/i);
  });

  it('назван конкретный источник значения на стороне ПРАКТИКИ', () => {
    // ANALYTICS_INGEST_SECRET — реальное имя переменной на стороне
    // приёмника (src/app/api/ingest/route.ts), не выдуманное здесь.
    expect(source).toContain('ANALYTICS_INGEST_SECRET');
  });

  it('путь общего файла закреплён в комментарии, а не только в коде', () => {
    expect(source).toContain('/etc/simpas/ingest-secret');
  });
});

/**
 * Запасная копия секрета внутри каталога ЗАПИСОК.
 *
 * Канонический файл принадлежит root с правами 600. У двух продуктов разные
 * репозитории и разные секреты SERVER_USER — знать наверняка, от кого ходит
 * эта выкладка, нельзя. Если она идёт не от root, `[ -r ]` на каноническом
 * пути честно вернёт «нет», и без этой копии мост остался бы выключен, а
 * человеку пришлось бы руками разбираться с правами на чужой файл. Выкладка
 * ПРАКТИКИ поэтому кладёт то же значение и в /var/www/zapiski/.ingest-secret,
 * отдавая его владельцу этого каталога.
 */
describe('запасная копия секрета в каталоге ЗАПИСОК', () => {
  it('берётся, когда канонического файла не видно', () => {
    const { stdout, envContent } = run({ localFileContent: 'secret-from-local\n' });
    expect(envValue(envContent, 'PRACTICE_INGEST_SECRET')).toBe('secret-from-local');
    expect(stdout).toContain('local-ingest-secret');
  });

  it('канонический файл имеет приоритет: он всегда свежее', () => {
    const { envContent } = run({
      sharedFileContent: 'secret-canonical\n',
      localFileContent: 'secret-stale\n',
    });
    expect(envValue(envContent, 'PRACTICE_INGEST_SECRET')).toBe('secret-canonical');
  });

  it('заданное человеком не перебивается и запасной копией тоже', () => {
    const { envContent } = run({
      envFileContent: 'PRACTICE_INGEST_SECRET=set-by-hand\n',
      localFileContent: 'secret-from-local\n',
    });
    expect(envValue(envContent, 'PRACTICE_INGEST_SECRET')).toBe('set-by-hand');
  });

  it('нет ни одной копии — мост выключен, и это сказано в лог', () => {
    const { stdout, envContent } = run({});
    expect(envValue(envContent, 'PRACTICE_INGEST_SECRET')).toBeUndefined();
    expect(stdout).toMatch(/ВНИМАНИЕ|выключен/i);
  });

  it('пустой канонический файл не считается значением — падаем на запасную копию', () => {
    const { envContent } = run({ sharedFileContent: '\n', localFileContent: 'secret-from-local\n' });
    expect(envValue(envContent, 'PRACTICE_INGEST_SECRET')).toBe('secret-from-local');
  });
});
