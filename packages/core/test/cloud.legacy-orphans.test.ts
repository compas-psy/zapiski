/**
 * Осиротевшие адреса прошлой схемы не превращаются в мусор на диске.
 *
 * ── Откуда они берутся ──────────────────────────────────────────────────────
 *
 * Пока действовало сквозное шифрование, адресом объекта на сервере был токен
 * `HMAC(K_manifest, путь)` — 32 шестнадцатеричных знака. Шифрование вырезано
 * из MVP, но у аккаунта, успевшего его включить, такие объекты на сервере
 * ОСТАЛИСЬ, и открыть их больше нечем.
 *
 * ── Чем это опасно и что здесь стережётся ───────────────────────────────────
 *
 * Без ключа клиент принимает адрес за обычный путь. Значит он скачал бы эти
 * объекты как заметки с именами вроде `a1b2c3…` и с нечитаемым содержимым —
 * прямо в папку человека, рядом с настоящими заметками. Это не косметика: в
 * папке появляются файлы, которых человек не создавал, и удалять их придётся
 * руками, гадая, что это.
 *
 * Заслон намеренно узкий: ровно 32 знака `[0-9a-f]`, без точки и слэша. Путь
 * настоящей заметки такой формы иметь не может — у неё есть расширение.
 */
import { describe, expect, it } from 'vitest';

import { ZapiskiCloudBackend } from '../src/sync/zapiski-cloud.js';
import { MANIFEST_ADDRESS } from '../src/sync/manifest.js';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function cloudWith(paths: readonly string[]): typeof fetch {
  return (async (input: string) => {
    const url = new URL(String(input), 'https://zapiski.test');
    if (url.pathname.endsWith('/vault/list')) {
      return new Response(
        JSON.stringify({
          entries: paths.map((path) => ({ path, etag: '1', mtime: 1, size: 10 })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function backend(fetchImpl: typeof fetch): ZapiskiCloudBackend {
  return new ZapiskiCloudBackend({
    baseUrl: 'https://zapiski.test',
    token: 'token',
    deviceId: 'dev',
    fetch: fetchImpl as never,
  });
}

describe('облако без шифрования: остатки прошлой схемы', () => {
  it('токенизированный адрес не становится заметкой', async () => {
    const list = await backend(cloudWith(['Идеи.md', TOKEN])).list();

    expect(list.map((entry) => entry.path)).toEqual(['Идеи.md']);
  });

  it('служебное оглавление тоже не становится заметкой', async () => {
    const list = await backend(cloudWith(['Идеи.md', MANIFEST_ADDRESS])).list();

    expect(list.map((entry) => entry.path)).toEqual(['Идеи.md']);
  });

  it('настоящие заметки заслон не трогает — даже с похожими именами', async () => {
    /* Похожее, но НЕ токен: с расширением, с папкой, короче, длиннее, с
       заглавными. Ни одно не имеет права пропасть. */
    const real = [
      'Идеи.md',
      `${TOKEN}.md`,
      `Папка/${TOKEN}`,
      'a1b2c3d4e5f60718293a4b5c6d7e8f9',
      'A1B2C3D4E5F60718293A4B5C6D7E8F90',
    ];
    const list = await backend(cloudWith(real)).list();

    expect(list.map((entry) => entry.path).sort()).toEqual([...real].sort());
  });
});
