/**
 * Обратный перевод: шифротекст → открытый текст.
 *
 * ── Зачем это понадобилось ───────────────────────────────────────────────────
 *
 * Решение владельца: убрать сквозное шифрование из MVP и вернуть его позже
 * через внешнюю ключницу. У аккаунта, который успел пройти онбординг, на
 * сервере лежит шифротекст по токенизированным адресам, а сервер не примет
 * поверх него открытый текст (`assertEnvelopeIfEncrypted`). Клиент, который
 * больше не шифрует, увидел бы у такого аккаунта пустое облако и не смог бы
 * ничего записать. Это ровно тот исход, который запрещён: человек не должен
 * терять доступ к своим заметкам из-за смены нашего решения.
 *
 * ── Что здесь стережётся ─────────────────────────────────────────────────────
 *
 * Не «перевод вызывается», а два свойства, ради которых он существует:
 *
 *   1. после перевода заметка читается по своему НАСТОЯЩЕМУ пути, а токенов и
 *      манифеста в облаке не остаётся;
 *   2. перевод, который не может пройти целиком, не трогает НИЧЕГО.半-переезд
 *      здесь хуже отказа: снятый ключ плюс нерасшифрованный остаток — это
 *      заметки, которые уже не открыть ничем.
 */
import { describe, expect, it } from 'vitest';

import type { BiometricProvider } from '../src/contract.js';
import { SyncKeyOnboarding } from '../src/sync/sync-key-onboarding.js';
import { ZapiskiCloudBackend } from '../src/sync/zapiski-cloud.js';
import { MANIFEST_ADDRESS } from '../src/sync/manifest.js';
import { fromUtf8, utf8 } from '../src/util/bytes.js';

const NOTE_PATH = 'Личное/Дневник.md';
const NOTE = '# Личное\n\nтекст заметки.\n';

function keychain(): BiometricProvider {
  const store = new Map<string, Uint8Array>();
  return {
    isAvailable: async () => true,
    enroll: async (id, secret) => {
      store.set(id, secret);
    },
    unlock: async (id) => store.get(id) ?? null,
    remove: async (id) => {
      store.delete(id);
    },
  };
}

/** Сервер: ключ аккаунта со снятием + блобы по адресам. */
function fakeCloud(): { fetch: typeof fetch; blobs: Map<string, Uint8Array>; hasKey: () => boolean } {
  const blobs = new Map<string, Uint8Array>();
  let syncKeyRow: Record<string, string> | null = null;

  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'https://zapiski.test');
    if (url.pathname.endsWith('/vault/sync-key')) {
      if (init?.method === 'PUT') {
        if (syncKeyRow !== null) return new Response(null, { status: 409 });
        syncKeyRow = JSON.parse(String(init.body)) as Record<string, string>;
        return json({ enrolled: true }, 201);
      }
      if (init?.method === 'DELETE') {
        const had = syncKeyRow !== null;
        syncKeyRow = null;
        return json({ removed: had }, 200);
      }
      return syncKeyRow === null
        ? json({ enrolled: false }, 200)
        : json({ enrolled: true, ...syncKeyRow }, 200);
    }
    if (url.pathname.endsWith('/vault/blob')) {
      const address = url.searchParams.get('path') ?? '';
      if (init?.method === 'PUT') {
        const bytes = new Uint8Array(init.body as unknown as Uint8Array);
        /* Тот же заслон, что на настоящем сервере (assertEnvelopeIfEncrypted):
           пока у аккаунта есть ключ, открытый текст принимается ТОЛЬКО по
           явному заголовку перевода. Без него стенд врал бы в пользу клиента:
           тест проходил бы и у клиента, который заголовок не шлёт, — а такой
           клиент на проде получил бы 409 и не перевёл бы ничего. */
        /* Заголовки читаем из объекта, а не через `new Headers`: тот
           отвергает значения вне latin-1, а токен в этом тесте — русское
           слово. Стенд не должен падать там, где настоящий сервер работает. */
        const sent = (init.headers ?? {}) as Record<string, string>;
        const migrating =
          Object.entries(sent).some(
            ([name, value]) => name.toLowerCase() === 'x-migrate-plaintext' && value === '1',
          );
        const envelope = bytes.length >= 29 && bytes[0] === 1;
        if (syncKeyRow !== null && !envelope && !migrating) {
          return json({ code: 'upgrade_required' }, 409);
        }
        blobs.set(address, bytes);
        return new Response(null, { status: 200, headers: { etag: '"1"' } });
      }
      if (init?.method === 'DELETE') {
        blobs.delete(address);
        return new Response(null, { status: 200 });
      }
      const found = blobs.get(address);
      if (!found) return new Response(null, { status: 404 });
      return new Response(found as unknown as BodyInit, { status: 200, headers: { etag: '"1"' } });
    }
    if (url.pathname.endsWith('/vault/list')) {
      return json(
        {
          entries: [...blobs.entries()].map(([path, data]) => ({
            path,
            etag: '1',
            mtime: 1,
            size: data.length,
          })),
        },
        200,
      );
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, blobs, hasKey: () => syncKeyRow !== null };
}

/** Аккаунт, прошедший онбординг, с одной заметкой в облаке. */
async function encryptedAccount(): Promise<{
  cloud: ReturnType<typeof fakeCloud>;
  backend: ZapiskiCloudBackend;
  dropKey: () => Promise<boolean>;
}> {
  const cloud = fakeCloud();
  const onboarding = new SyncKeyOnboarding({
    baseUrl: 'https://zapiski.test',
    fetch: cloud.fetch as never,
    biometrics: keychain(),
  });
  const created = await onboarding.create();
  const backend = new ZapiskiCloudBackend({
    baseUrl: 'https://zapiski.test',
    token: 'токен',
    deviceId: 'a',
    fetch: cloud.fetch as never,
    sync: created!.crypto,
  });
  await backend.put(NOTE_PATH, utf8(NOTE));
  await backend.pushManifest([NOTE_PATH]);
  return { cloud, backend, dropKey: () => onboarding.dropAccountKey() };
}

describe('обратный перевод аккаунта на открытый текст', () => {
  it('заметка возвращается по своему пути, токены и манифест исчезают, ключ снят', async () => {
    const { cloud, backend, dropKey } = await encryptedAccount();

    // До перевода: адрес токенизирован, содержимого не видно.
    expect([...cloud.blobs.keys()].some((a) => /^[0-9a-f]{32}$/.test(a))).toBe(true);

    const moved = await backend.migrateToPlaintext(dropKey);
    expect(moved, 'одна заметка обязана перевестись').toBe(1);

    expect(cloud.hasKey(), 'ключ аккаунта обязан быть снят').toBe(false);
    expect([...cloud.blobs.keys()]).toEqual([NOTE_PATH]);
    expect(fromUtf8(cloud.blobs.get(NOTE_PATH)!)).toBe(NOTE);
    expect(cloud.blobs.has(MANIFEST_ADDRESS)).toBe(false);
  });

  it('повторный вызов — ноль, а не ошибка', async () => {
    const { backend, dropKey } = await encryptedAccount();
    await backend.migrateToPlaintext(dropKey);
    expect(await backend.migrateToPlaintext(dropKey)).toBe(0);
  });

  it('обрыв на снятии ключа не теряет данные и доводится повтором', async () => {
    /* Порядок шагов выбран так, чтобы обрыв связи был безопасен: содержимое
       уже лежит открытым текстом по своим путям, а ключ ещё на месте. Это
       НЕ успех — перевод не завершён и повторится, — но и не потеря. */
    const { cloud, backend, dropKey } = await encryptedAccount();

    const first = await backend.migrateToPlaintext(async () => false);
    expect(first, 'незавершённый перевод обязан быть отличим от успеха').toBeNull();

    expect(cloud.hasKey(), 'ключ ещё на месте — снять не удалось').toBe(true);
    expect(fromUtf8(cloud.blobs.get(NOTE_PATH)!), 'заметка уже читается по пути').toBe(NOTE);
    expect([...cloud.blobs.keys()].some((a) => /^[0-9a-f]{32}$/.test(a))).toBe(false);

    // Повтор доводит начатое до конца, ничего не сломав по дороге.
    expect(await backend.migrateToPlaintext(dropKey)).toBe(0);
    expect(cloud.hasKey()).toBe(false);
    expect(fromUtf8(cloud.blobs.get(NOTE_PATH)!)).toBe(NOTE);
  });

  it('нерасшифровываемый объект отменяет перевод — половина хуже отказа', async () => {
    const { cloud, backend, dropKey } = await encryptedAccount();
    // Объект по токенизированному адресу, которого нет в манифесте: его путь
    // восстановить нечем, и молча бросить его значило бы потерять заметку.
    cloud.blobs.set('ffffffffffffffffffffffffffffffff', utf8('чужие или испорченные байты'));
    const before = new Map(cloud.blobs);

    const result = await backend.migrateToPlaintext(dropKey);

    expect(result).toBeNull();
    expect(cloud.hasKey(), 'ключ не снимается, пока перевод невозможен').toBe(true);
    expect([...cloud.blobs.keys()].sort()).toEqual([...before.keys()].sort());
  });
});
