import { readFile } from 'node:fs/promises';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { UpdateFeedResponse } from '../protocol.ts';

/**
 * Фид автообновлений в формате, который понимает Tauri updater.
 *
 * Клиент настраивается на `.../api/v1/updates/{{target}}/{{current_version}}`.
 * Ответ — либо 200 с манифестом, либо **204 без тела**: именно так Tauri
 * понимает «обновления нет». Возвращать 200 с той же версией нельзя — клиент
 * начнёт скачивать то, что у него уже стоит.
 *
 * Для Android в `platforms` лежит ключ `android-*` со ссылкой на APK: там
 * подписи Tauri нет, обновление ставит сам пользователь.
 *
 * Источник — JSON-файл в томе (UPDATES_MANIFEST_PATH), который кладёт релизный
 * пайплайн. Файла нет — фид молча отвечает 204: отсутствие релиза не повод
 * ронять запросы клиентов.
 */

const params = z.object({
  platform: z.string().min(2).max(64).regex(/^[a-z0-9_.-]+$/i),
  currentVersion: z.string().min(1).max(64).regex(/^[0-9A-Za-z.+-]+$/),
});

const manifestSchema = z.object({
  version: z.string().min(1),
  notes: z.string().default(''),
  pub_date: z.string().min(1),
  platforms: z.record(
    z.string(),
    z.object({ signature: z.string().default(''), url: z.string().min(1) }),
  ),
});

export type UpdateManifest = z.infer<typeof manifestSchema>;

export async function registerUpdateRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.get('/api/v1/updates/:platform/:currentVersion', async (request, reply) => {
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(204).send();

    const manifestPath = ctx.env.UPDATES_MANIFEST_PATH;
    if (manifestPath === undefined || manifestPath.length === 0) return reply.code(204).send();

    const manifest = await loadManifest(manifestPath);
    if (manifest === null) return reply.code(204).send();

    // Уже стоит эта версия или новее — «обновления нет».
    if (compareVersions(parsed.data.currentVersion, manifest.version) >= 0) {
      return reply.code(204).send();
    }

    const platforms = selectPlatforms(manifest, parsed.data.platform);
    if (Object.keys(platforms).length === 0) return reply.code(204).send();

    const body: UpdateFeedResponse = {
      version: manifest.version,
      notes: manifest.notes,
      pub_date: manifest.pub_date,
      platforms,
    };
    return reply.send(body);
  });
}

async function loadManifest(path: string): Promise<UpdateManifest | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = manifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Tauri зовёт эндпоинт с `{{target}}` (`windows`, `linux`, `darwin`), а ключи
 * в манифесте — `windows-x86_64`. Поэтому подходит и точное совпадение, и
 * префикс. Совсем ничего не подошло — 204, а не пустой манифест.
 */
export function selectPlatforms(
  manifest: UpdateManifest,
  requested: string,
): UpdateFeedResponse['platforms'] {
  const key = requested.toLowerCase();
  const exact = manifest.platforms[key];
  if (exact !== undefined) return { [key]: exact };

  const out: UpdateFeedResponse['platforms'] = {};
  for (const [name, value] of Object.entries(manifest.platforms)) {
    if (name.toLowerCase().startsWith(`${key}-`) || name.toLowerCase() === key) {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Сравнение версий по semver: -1 / 0 / 1. Предрелиз считается младше релиза
 * (`1.2.0-beta.1` < `1.2.0`), иначе бета «съедала» бы стабильный выпуск.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA = '', preA] = splitPrerelease(a);
  const [coreB = '', preB] = splitPrerelease(b);

  const partsA = coreA.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const partsB = coreB.split('.').map((n) => Number.parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
    const left = partsA[i] ?? 0;
    const right = partsB[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }

  if (preA === undefined && preB === undefined) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA === preB ? 0 : preA < preB ? -1 : 1;
}

function splitPrerelease(version: string): [string, string | undefined] {
  const clean = version.replace(/^v/i, '').split('+')[0] ?? '';
  const index = clean.indexOf('-');
  if (index === -1) return [clean, undefined];
  return [clean.slice(0, index), clean.slice(index + 1)];
}
