import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { UpdateFeedResponse } from '../src/protocol.ts';
import { createHarness, noDatabase, type Harness } from './helpers/app.ts';

/**
 * Фид автообновлений (Tauri updater).
 *
 * Ключевая деталь протокола: «обновления нет» — это **204 без тела**. Если
 * ответить 200 с той же версией, клиент начнёт скачивать то, что у него уже
 * установлено.
 */

describe.skipIf(noDatabase())('фид обновлений', () => {
  let harness: Harness;
  let manifestPath: string;

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zapiski-updates-'));
    manifestPath = path.join(dir, 'latest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: '1.4.0',
        notes: 'Починили ввод на Gboard',
        pub_date: '2026-08-09T10:00:00Z',
        platforms: {
          'windows-x86_64': { signature: 'dW5kZXJzaWduZWQ=', url: 'https://cdn/zapiski_1.4.0.msi' },
          'android-universal': { signature: '', url: 'https://cdn/zapiski-1.4.0.apk' },
        },
      }),
      'utf8',
    );

    harness = await createHarness({ env: { UPDATES_MANIFEST_PATH: manifestPath } });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('старой версии отдаётся манифест в формате Tauri', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/updates/windows-x86_64/1.3.9',
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as UpdateFeedResponse;
    expect(body.version).toBe('1.4.0');
    expect(body.notes).toBe('Починили ввод на Gboard');
    expect(body.pub_date).toBe('2026-08-09T10:00:00Z');
    expect(body.platforms['windows-x86_64']).toEqual({
      signature: 'dW5kZXJzaWduZWQ=',
      url: 'https://cdn/zapiski_1.4.0.msi',
    });
  });

  it('вызов с одним лишь target тоже находит платформу', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/updates/windows/1.0.0',
    });
    expect(response.statusCode).toBe(200);
    expect(Object.keys((response.json() as UpdateFeedResponse).platforms)).toEqual([
      'windows-x86_64',
    ]);
  });

  it('для Android отдаётся ссылка на APK', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/updates/android/1.0.0',
    });
    expect(response.statusCode).toBe(200);
    const platform = (response.json() as UpdateFeedResponse).platforms['android-universal'];
    expect(platform?.url).toMatch(/\.apk$/);
  });

  it('актуальной версии — 204 без тела', async () => {
    for (const version of ['1.4.0', '1.5.0', '2.0.0']) {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/v1/updates/windows-x86_64/${version}`,
      });
      expect(response.statusCode, version).toBe(204);
      expect(response.body, version).toBe('');
    }
  });

  it('неизвестная платформа — 204, а не пустой манифест', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/updates/darwin-aarch64/1.0.0',
    });
    expect(response.statusCode).toBe(204);
  });

  it('без настроенного манифеста фид молчит, а не падает', async () => {
    const bare = await createHarness();
    try {
      const response = await bare.app.inject({
        method: 'GET',
        url: '/api/v1/updates/windows-x86_64/1.0.0',
      });
      expect(response.statusCode).toBe(204);
    } finally {
      await bare.close();
    }
  });

  it('фид не требует аутентификации', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/updates/windows-x86_64/1.0.0',
    });
    expect(response.statusCode).toBe(200);
  });
});
