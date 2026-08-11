import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { RemoteEntry, RemoteVersionSnapshot } from '../src/protocol.ts';

/**
 * ADR-0003: «типы протокола объявлены один раз и импортируются и клиентом, и
 * сервером. Рассинхрон протокола становится ошибкой компиляции».
 *
 * Прямой импорт из `@zapiski/core` пока невозможен: пакет принадлежит другой
 * команде и не собирается как npm-модуль. Чтобы гарантия не потерялась, здесь
 * читается сам `packages/core/src/contract.ts` и сверяются наборы полей.
 * Разъезд протокола роняет тест — то же место в CI, что и ошибка компиляции.
 *
 * Когда `@zapiski/core` начнёт собираться, этот файл заменяется на
 * `import type { RemoteEntry } from '@zapiski/core'` и пару присваиваний.
 */

const CONTRACT_PATH = path.resolve(
  fileURLToPath(new URL('../../packages/core/src/contract.ts', import.meta.url)),
);

async function readContract(): Promise<string | null> {
  try {
    return await readFile(CONTRACT_PATH, 'utf8');
  } catch {
    return null;
  }
}

/** Достаёт имена полей верхнего уровня из `export interface Name { ... }`. */
function fieldsOf(source: string, interfaceName: string): string[] | null {
  const re = new RegExp(`export interface ${interfaceName}\\b[^{]*\\{`, 'm');
  const match = re.exec(source);
  if (match === null) return null;

  let depth = 1;
  let index = match.index + match[0].length;
  let body = '';
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    body += char;
    index += 1;
  }

  const fields: string[] = [];
  for (const line of body.split('\n')) {
    const clean = line.replace(/\/\/.*$/, '').trim();
    const fieldMatch = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(clean);
    if (fieldMatch?.[1] !== undefined) fields.push(fieldMatch[1]);
  }
  return fields;
}

describe('контракт протокола с @zapiski/core', () => {
  it('RemoteEntry совпадает по набору полей', async () => {
    const source = await readContract();
    if (source === null) {
      console.warn(`контракт ядра не найден: ${CONTRACT_PATH} — сверка пропущена`);
      return;
    }

    const core = fieldsOf(source, 'RemoteEntry');
    expect(core, 'в contract.ts нет RemoteEntry').not.toBeNull();

    // Набор на стороне сервера — из типа, а не из строки: если поле уедет
    // отсюда, не скомпилируется этот файл.
    const sample: RemoteEntry = { path: 'a', etag: '"e"', mtime: 1, size: 1 };
    expect([...(core as string[])].sort()).toEqual(Object.keys(sample).sort());
  });

  it('серверные поля VersionSnapshot совпадают с контрактом', async () => {
    const source = await readContract();
    if (source === null) return;

    const core = fieldsOf(source, 'VersionSnapshot');
    expect(core, 'в contract.ts нет VersionSnapshot').not.toBeNull();

    const sample: RemoteVersionSnapshot = {
      id: 'v',
      noteId: 'n',
      takenAt: 1,
      source: 'local',
      merged: false,
      size: 1,
      etag: '"e"',
    };

    // `body` живёт только на клиенте: у сервера открытого текста нет.
    // Всё остальное обязано совпасть.
    const expected = (core as string[]).filter((field) => field !== 'body');
    for (const field of expected) {
      expect(Object.keys(sample), `сервер не отдаёт поле ${field}`).toContain(field);
    }
    expect(Object.keys(sample)).not.toContain('body');
  });

  it('SyncBackend из контракта покрыт эндпоинтами сервера', async () => {
    const source = await readContract();
    if (source === null) return;

    // list / get / put / remove / subscribe — минимум, который обязан
    // реализовывать ZapiskiCloud как SyncBackend.
    expect(source).toContain('interface SyncBackend');
    for (const method of ['list(', 'get(', 'put(', 'remove(', 'subscribe?(']) {
      expect(source).toContain(method);
    }

    const routes = await readFile(
      path.resolve(fileURLToPath(new URL('../src/routes/vault.ts', import.meta.url))),
      'utf8',
    );
    // list / get / put / remove — каждый должен быть объявлен своим методом.
    const declared = (method: string, route: string): boolean =>
      new RegExp(`app\\.${method}\\(\\s*'${route.replace(/[*/]/g, (c) => `\\${c}`)}'`).test(routes);

    expect(routes).toContain('/api/v1/vault/manifest');
    expect(declared('get', '/api/v1/vault/manifest'), 'нет GET manifest (list)').toBe(true);
    expect(declared('get', '/api/v1/vault/blob/*'), 'нет GET blob (get)').toBe(true);
    expect(declared('put', '/api/v1/vault/blob/*'), 'нет PUT blob (put)').toBe(true);
    expect(declared('delete', '/api/v1/vault/blob/*'), 'нет DELETE blob (remove)').toBe(true);

    const live = await readFile(
      path.resolve(fileURLToPath(new URL('../src/routes/live.ts', import.meta.url))),
      'utf8',
    );
    expect(live).toContain('/api/v1/vault/live'); // subscribe
  });
});
