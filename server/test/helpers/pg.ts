import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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

const PG_BIN_CANDIDATES = [
  '/usr/lib/postgresql/16/bin',
  '/usr/lib/postgresql/15/bin',
  '/usr/lib/postgresql/14/bin',
  '/usr/pgsql-16/bin',
  '/opt/homebrew/opt/postgresql@16/bin',
];

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
  for (const dir of PG_BIN_CANDIDATES) {
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
