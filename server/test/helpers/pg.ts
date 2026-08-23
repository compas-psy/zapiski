import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Postgres для тестов.
 *
 * Порядок поиска базы:
 *  1. `TEST_DATABASE_URL` — если CI или разработчик подсунул готовую.
 *  2. Локальный `initdb`/`pg_ctl` — поднимаем одноразовый кластер во временном
 *     каталоге на свободном порту и гасим его после прогона.
 *  3. Ничего не нашлось — тесты, которым нужна база, помечаются пропущенными,
 *     а те, что её не требуют (санитайзер, JWT, схема, контракт), идут как есть.
 *
 * Настоящий Postgres, а не эмулятор: проверяются `FOR UPDATE`, частичные
 * индексы и `ON CONFLICT` — то, на чём держатся квота и одноразовость токена.
 */

export interface EphemeralCluster {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Куда смотреть, если готовой базы не подсунули.
 *
 * Версии НЕ перечисляются: раньше здесь стоял жёсткий список 14/15/16, и в
 * день, когда раннер переехал бы на 17, поиск перестал бы находить Postgres.
 * Отказ при этом выглядел бы не как упавшая сборка, а как «тестов стало вдвое
 * меньше» — то есть никак. Поэтому версии вычитываются из каталога, новая
 * пробуется раньше старой, а фиксированными остаются только пути вне
 * `/usr/lib/postgresql` (RHEL, homebrew), где такого каталога нет.
 */
const PG_LIB_DIR = '/usr/lib/postgresql';

const PG_FALLBACK_CANDIDATES = [
  '/usr/pgsql-17/bin',
  '/usr/pgsql-16/bin',
  '/opt/homebrew/opt/postgresql@17/bin',
  '/opt/homebrew/opt/postgresql@16/bin',
];

/** Чистая часть поиска — её и проверяет `test/pg-discovery.test.ts`. */
export function orderedBinCandidates(installedVersions: readonly string[]): string[] {
  const versions = installedVersions
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => b - a)
    .map((version) => `${PG_LIB_DIR}/${version}/bin`);
  return [...versions, ...PG_FALLBACK_CANDIDATES];
}

/**
 * Обязана ли база быть. На машине разработчика Postgres может отсутствовать
 * законно — тесты, которым он нужен, помечаются пропущенными, остальные идут.
 * В CI это недопустимо: 22 файла ушли бы в пропуск при зелёном прогоне.
 *
 * Снять требование можно, но только руками и явно — переменной, которую
 * нельзя выставить случайно.
 */
export function requireDatabase(env: Record<string, string | undefined>): boolean {
  if (env['ZAPISKI_ALLOW_NO_DATABASE'] !== undefined && env['ZAPISKI_ALLOW_NO_DATABASE'] !== '') {
    return false;
  }
  const truthy = (value: string | undefined): boolean =>
    value !== undefined && value !== '' && value !== 'false' && value !== '0';
  return truthy(env['CI']) || truthy(env['GITHUB_ACTIONS']);
}

export async function startEphemeralPostgres(): Promise<EphemeralCluster | null> {
  const bin = await findBinDir();
  if (bin === null) return null;

  const dataDir = await mkdtemp(path.join(tmpdir(), 'zapiski-pg-'));
  const socketDir = await mkdtemp(path.join(tmpdir(), 'zapiski-sock-'));
  const port = 5000 + Math.floor(Math.random() * 4000);
  // Postgres отказывается работать от root; под root запускаем от `postgres`.
  const asPostgres = process.getuid?.() === 0;

  const exec = async (command: string, args: string[]): Promise<void> => {
    if (asPostgres) {
      const quoted = [command, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      await run('su', ['postgres', '-c', quoted]);
    } else {
      await run(command, args);
    }
  };

  try {
    if (asPostgres) {
      await run('chown', ['-R', 'postgres:postgres', dataDir, socketDir]);
      await run('chmod', ['777', tmpdir()]).catch(() => undefined);
    }

    await exec(path.join(bin, 'initdb'), [
      '-D', dataDir,
      '-A', 'trust',
      '-U', 'postgres',
      '--encoding=UTF8',
      '--locale=C',
    ]);
    await exec(path.join(bin, 'pg_ctl'), [
      '-D', dataDir,
      '-o', `-p ${port} -k ${socketDir} -c listen_addresses= -c fsync=off -c full_page_writes=off`,
      '-l', path.join(dataDir, 'server.log'),
      '-w',
      'start',
    ]);
    await exec(path.join(bin, 'createdb'), [
      '-h', socketDir,
      '-p', String(port),
      '-U', 'postgres',
      'zapiski_test',
    ]);
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
    console.warn(`не удалось поднять Postgres для тестов: ${(error as Error).message}`);
    return null;
  }

  const url = `postgresql://postgres@localhost/zapiski_test?host=${encodeURIComponent(socketDir)}&port=${port}`;

  return {
    url,
    stop: async () => {
      await exec(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop']).catch(
        () => undefined,
      );
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function findBinDir(): Promise<string | null> {
  let installed: string[] = [];
  try {
    installed = await readdir(PG_LIB_DIR);
  } catch {
    installed = [];
  }

  for (const dir of orderedBinCandidates(installed)) {
    try {
      await run(path.join(dir, 'initdb'), ['--version']);
      return dir;
    } catch {
      continue;
    }
  }
  // Возможно, бинарники просто в PATH.
  try {
    await run('initdb', ['--version']);
    return '';
  } catch {
    return null;
  }
}
