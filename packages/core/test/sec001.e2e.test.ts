/**
 * SEC-001 — сквозной сценарий двух устройств.
 *
 * Это не проверка отдельных классов, а проверка ПРОДУКТА: то, что человек
 * реально делает. Один «сервер» в памяти, повторяющий поведение настоящего
 * (адресация по пути-токену, хранение непрозрачных байт), и два устройства
 * со своими хранилищами ключей.
 *
 * Сценарий целиком:
 *   включил облако → получил код → заметка синхронизировалась → сервер видит
 *   только шифротекст → второе устройство → ввёл код → получил манифест →
 *   увидел заметку по настоящему пути → правки едут в обе стороны →
 *   перезапуск не спрашивает код заново.
 */
import { describe, expect, it } from 'vitest';

import type { BiometricProvider } from '../src/contract.js';
import { formatRecoveryCode } from '../src/crypto/sync-keys.js';
import { SyncKeyOnboarding } from '../src/sync/sync-key-onboarding.js';
import { ZapiskiCloudBackend } from '../src/sync/zapiski-cloud.js';
import { fromUtf8, utf8 } from '../src/util/bytes.js';

const SENTINEL = 'SEC001_E2E_SENTINEL_x7f3q9';
const NOTE = `# Личное\n\n${SENTINEL}\n\nтекст заметки.\n`;
const NOTE_PATH = 'Личное/Дневник 12 марта.md';

/** Сервер: ключ аккаунта + блобы по адресам. Никакой расшифровки. */
function fakeCloud(): {
  fetch: typeof fetch;
  blobs: Map<string, Uint8Array>;
  syncKey: () => Record<string, string> | null;
} {
  const blobs = new Map<string, Uint8Array>();
  let syncKeyRow: Record<string, string> | null = null;

  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'https://zapiski.test');

    if (url.pathname.endsWith('/vault/sync-key')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, string>;
        if (syncKeyRow !== null) return new Response(null, { status: 409 });
        syncKeyRow = body;
        return json({ enrolled: true }, 201);
      }
      return syncKeyRow === null ? json({ enrolled: false }, 200) : json({ enrolled: true, ...syncKeyRow }, 200);
    }

    if (url.pathname.endsWith('/vault/blob')) {
      const address = url.searchParams.get('path') ?? '';
      if (init?.method === 'PUT') {
        const body = new Uint8Array(init.body as unknown as Uint8Array);
        /* Сервер настоящего продукта отбивает открытый текст у аккаунта с
           ключом. Повторяем это здесь, иначе тест не заметил бы регрессии. */
        if (syncKeyRow !== null && !(body.length > 29 && body[0] === 1)) {
          return json({ error: { code: 'upgrade_required' } }, 409);
        }
        blobs.set(address, body);
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

  return { fetch: fetchImpl, blobs, syncKey: () => syncKeyRow };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Платформенное хранилище устройства. Переживает «перезапуск приложения». */
function deviceKeychain(): BiometricProvider & { wipe: () => void } {
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
    wipe: () => store.clear(),
  };
}

describe('SEC-001 сквозной: два устройства, настоящий сценарий', () => {
  it('весь путь от включения облака до синка в обе стороны', async () => {
    const cloud = fakeCloud();
    const keychainA = deviceKeychain();

    // ── 1–5. Первое устройство: включаем облако, получаем код ────────────
    const onboardingA = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: cloud.fetch as never,
      biometrics: keychainA,
    });
    expect((await onboardingA.state()).status).toBe('none');

    const created = await onboardingA.create();
    expect(created).not.toBeNull();
    const recoveryCode = formatRecoveryCode(created!.recovery);
    expect(recoveryCode.length).toBeGreaterThan(20);

    // ── 6–7. SyncCrypto в бэкенд, заметка синхронизируется ───────────────
    const deviceA = new ZapiskiCloudBackend({
      baseUrl: 'https://zapiski.test',
      token: 'токен',
      deviceId: 'device-a',
      fetch: cloud.fetch as never,
      sync: created!.crypto,
    });
    expect(deviceA.encrypts).toBe(true);

    await deviceA.put(NOTE_PATH, utf8(NOTE));
    await deviceA.pushManifest([NOTE_PATH]);

    // ── 8. Сервер видит только шифротекст и непрозрачные адреса ──────────
    for (const [address, data] of cloud.blobs) {
      expect(fromUtf8(data)).not.toContain(SENTINEL);
      expect(fromUtf8(data)).not.toContain('Дневник');
      if (address !== '.zapiski-manifest') {
        expect(address, 'адрес обязан быть токеном').toMatch(/^[0-9a-f]{32}$/);
      }
    }
    // Обёрнутый ключ на сервере — не сам ключ.
    expect(JSON.stringify(cloud.syncKey())).not.toContain(SENTINEL);

    // ── 9–11. Второе устройство: код → манифест → настоящий путь ─────────
    const keychainB = deviceKeychain();
    const onboardingB = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: cloud.fetch as never,
      biometrics: keychainB,
    });
    expect(
      (await onboardingB.state()).status,
      'ключ у аккаунта есть, локально нет → нужен код',
    ).toBe('needs-code');

    const unlocked = await onboardingB.unlock(recoveryCode);
    expect(unlocked.ok).toBe(true);
    if (!unlocked.ok) return;

    const deviceB = new ZapiskiCloudBackend({
      baseUrl: 'https://zapiski.test',
      token: 'токен',
      deviceId: 'device-b',
      fetch: cloud.fetch as never,
      sync: unlocked.crypto,
    });

    // До манифеста устройство B не знает чужих адресов — и честно
    // показывает пусто, а не файлы с именами-токенами.
    expect(await deviceB.list()).toEqual([]);

    const learned = await deviceB.pullManifest();
    expect(learned).toBe(1);

    const listed = await deviceB.list();
    expect(listed.map((e) => e.path), 'путь восстановлен настоящим').toEqual([NOTE_PATH]);

    const fetched = await deviceB.get(NOTE_PATH);
    expect(fetched).not.toBeNull();
    expect(fromUtf8(fetched!.data)).toBe(NOTE);

    // ── 12. Правки едут в обе стороны ────────────────────────────────────
    const edited = `${NOTE}\nдописано на втором устройстве.\n`;
    await deviceB.put(NOTE_PATH, utf8(edited));
    const backOnA = await deviceA.get(NOTE_PATH);
    expect(fromUtf8(backOnA!.data)).toBe(edited);

    // ── 13. Перезапуск приложения не требует кода заново ─────────────────
    const afterRestart = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: cloud.fetch as never,
      biometrics: keychainB, // то же хранилище устройства — как после перезапуска
    });
    const restored = await afterRestart.state();
    expect(restored.status, 'ключ поднялся из хранилища платформы').toBe('ready');
    if (restored.status === 'ready') {
      const sameNote = await new ZapiskiCloudBackend({
        baseUrl: 'https://zapiski.test',
        token: 'токен',
        deviceId: 'device-b',
        fetch: cloud.fetch as never,
        sync: restored.crypto,
      }).get(NOTE_PATH);
      expect(fromUtf8(sameNote!.data)).toBe(edited);
    }
  });

  it('неверный код: ничего не открылось, ничего не сломалось', async () => {
    const cloud = fakeCloud();
    const first = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: cloud.fetch as never,
      biometrics: deviceKeychain(),
    });
    const created = await first.create();
    await new ZapiskiCloudBackend({
      baseUrl: 'https://zapiski.test',
      token: 'токен',
      deviceId: 'device-a',
      fetch: cloud.fetch as never,
      sync: created!.crypto,
    }).put(NOTE_PATH, utf8(NOTE));
    const before = new Map(cloud.blobs);
    const keyBefore = JSON.stringify(cloud.syncKey());

    const keychain = deviceKeychain();
    const second = new SyncKeyOnboarding({
      baseUrl: 'https://zapiski.test',
      fetch: cloud.fetch as never,
      biometrics: keychain,
    });
    const wrong = await second.unlock('ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ');

    expect(wrong.ok).toBe(false);
    // Ключ на сервере не перезаписан, блобы не тронуты, локально пусто.
    expect(JSON.stringify(cloud.syncKey())).toBe(keyBefore);
    expect([...cloud.blobs.keys()]).toEqual([...before.keys()]);
    expect(await keychain.unlock('sync')).toBeNull();
  });
});
