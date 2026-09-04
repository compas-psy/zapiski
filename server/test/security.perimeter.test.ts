import { createHmac } from 'node:crypto';

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';
import { createMagicToken } from '../src/services/accounts.ts';
import { sanitizeHtml } from '../src/lib/sanitizeHtml.ts';
import { parseTrustProxy, resolveTrustProxy } from '../src/config/env.ts';

/**
 * Периметр сервера — проверки безопасности (docs/dev/security/AUDIT.md).
 *
 * Набор написан аудитом, а не командой бэкенда, и намеренно дублирует часть
 * функциональных тестов: функциональный тест проверяет, что фича работает,
 * этот — что она не работает в чужих руках. Если фича переедет, а проверка
 * доступа потеряется, красным станет именно этот файл.
 *
 * Каждый блок отвечает пункту модели угроз (docs/dev/security/THREAT-MODEL.md).
 */

const TRAVERSAL_PATHS = [
  '../../../../etc/passwd',
  '..%2F..%2F..%2Fetc%2Fpasswd',
  '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  '%252e%252e%252fetc%252fpasswd',
  'Проекты/../../secret.md',
  'a/./../../b.md',
  'foo%00.md',
  '....//....//etc/passwd',
  'a/..%5c..%5cwindows%5csystem32',
  'a/\u0000b.md',
];

describe.skipIf(noDatabase())('периметр: путь блоба приходит от клиента', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('ни один атакующий путь не пишет файл за пределами тома', async () => {
    const user = await createUser(harness);

    for (const path of TRAVERSAL_PATHS) {
      const response = await harness.app.inject({
        method: 'PUT',
        url: `/api/v1/vault/blob/${path}`,
        headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
        payload: Buffer.from('вторжение'),
      });
      // 400 — путь отбит валидатором, 404 — маршрутизатор его схлопнул.
      // 200 допустим только если путь остался внутри пространства имён
      // пользователя: тогда ниже сработает проверка тома.
      expect([200, 400, 404], `${path} → ${response.statusCode}`).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = response.json() as { path: string };
        expect(body.path.startsWith('..'), path).toBe(false);
        expect(body.path.startsWith('/'), path).toBe(false);
        expect(body.path.includes('/../'), path).toBe(false);
      }
    }

    // Главная проверка: что бы ни прислали, все файлы лежат под корнем тома
    // и под каталогом этого пользователя.
    const { readdir } = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const collect = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await collect(full)));
        else out.push(full);
      }
      return out;
    };
    for (const file of await collect(harness.blobRoot)) {
      expect(file.startsWith(harness.blobRoot + nodePath.sep)).toBe(true);
      expect(file).toContain(nodePath.join('blobs', user.userId));
    }
  });

  it('заголовок X-Vault-Path в снимке версии проходит ту же валидацию', async () => {
    const user = await createUser(harness);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/versions/note-1',
      headers: {
        ...user.authHeader,
        'content-type': 'application/octet-stream',
        'x-vault-path': '../../../etc/passwd',
      },
      payload: Buffer.from('шифротекст'),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe.skipIf(noDatabase())('периметр: IDOR — аутентификации мало, нужна авторизация', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('чужие блоб, версия, CRDT-лог и публикация недоступны по всем методам', async () => {
    const owner = await createUser(harness);
    const stranger = await createUser(harness);
    const path = 'Личное/Дневник.md.enc';

    const written = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/vault/blob/${path}`,
      headers: { ...owner.authHeader, 'content-type': 'application/octet-stream', 'x-note-id': 'note-idor' },
      payload: Buffer.from('шифротекст владельца'),
    });
    expect(written.statusCode).toBe(200);

    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/crdt/note-idor',
      headers: { ...owner.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('апдейт владельца'),
    });
    const snapshot = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/versions/note-idor',
      headers: { ...owner.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('версия владельца'),
    });
    expect(snapshot.statusCode).toBe(201);
    const versionId = (snapshot.json() as { id: string }).id;

    const published = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/publish',
      headers: owner.authHeader,
      payload: { html: '<p>текст владельца</p>', title: 'Владелец' },
    });
    expect(published.statusCode).toBe(201);
    const slug = (published.json() as { slug: string }).slug;

    // ── Чужой не читает ──────────────────────────────────────────────────────
    const read = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/vault/blob/${path}`,
      headers: stranger.authHeader,
    });
    expect(read.statusCode).toBe(404);

    const version = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/vault/versions/note-idor/${versionId}`,
      headers: stranger.authHeader,
    });
    expect(version.statusCode).toBe(404);

    const versionList = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/versions/note-idor',
      headers: stranger.authHeader,
    });
    expect((versionList.json() as { versions: unknown[] }).versions).toEqual([]);

    const crdt = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/crdt/note-idor',
      headers: stranger.authHeader,
    });
    expect((crdt.json() as { updates: unknown[] }).updates).toEqual([]);

    const manifest = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/manifest',
      headers: stranger.authHeader,
    });
    expect((manifest.json() as { entries: unknown[] }).entries).toEqual([]);

    const pages = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/publish',
      headers: stranger.authHeader,
    });
    expect((pages.json() as { pages: unknown[] }).pages).toEqual([]);

    // ── Чужой не пишет и не удаляет ──────────────────────────────────────────
    const overwrite = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/vault/blob/${path}`,
      headers: { ...stranger.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('подмена'),
    });
    // Запись по тому же пути допустима — это ЕГО собственный путь в его
    // пространстве имён. Важно, что владелец видит свои байты, а не чужие.
    expect(overwrite.statusCode).toBe(200);

    const ownerReads = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/vault/blob/${path}`,
      headers: owner.authHeader,
    });
    expect(ownerReads.rawPayload.toString('utf8')).toBe('шифротекст владельца');

    const removeAlien = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/publish/' + slug,
      headers: stranger.authHeader,
    });
    expect(removeAlien.statusCode).toBe(404);

    // Чужой слаг не перезаписывается публикацией под тем же именем.
    const hijack = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/publish',
      headers: stranger.authHeader,
      payload: { html: '<p>подмена</p>', title: 'Подмена', slug },
    });
    expect(hijack.statusCode).toBe(404);

    const page = await harness.app.inject({ method: 'GET', url: `/p/${slug}` });
    expect(page.body).toContain('текст владельца');
    expect(page.body).not.toContain('подмена');
  });

  it('удаление чужого блоба не трогает его данные', async () => {
    const owner = await createUser(harness);
    const stranger = await createUser(harness);
    const path = 'Общее/Заметка.md.enc';

    await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/vault/blob/${path}`,
      headers: { ...owner.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('байты владельца'),
    });

    const removed = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/vault/blob/${path}`,
      headers: stranger.authHeader,
    });
    expect(removed.statusCode).toBe(404);

    const still = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/vault/blob/${path}`,
      headers: owner.authHeader,
    });
    expect(still.statusCode).toBe(200);
    expect(still.rawPayload.toString('utf8')).toBe('байты владельца');
  });

  it('одинаковое содержимое двух аккаунтов не даёт общего файла в томе', async () => {
    const first = await createUser(harness);
    const second = await createUser(harness);
    const payload = Buffer.from('ровно те же байты');

    const a = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/a.md.enc',
      headers: { ...first.authHeader, 'content-type': 'application/octet-stream' },
      payload,
    });
    const b = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/b.md.enc',
      headers: { ...second.authHeader, 'content-type': 'application/octet-stream' },
      payload,
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    // Дедупликация между аккаунтами выдала бы факт «у этих двоих совпал файл».
    const { rows } = await harness.db.query<{ storage_key: string; user_id: string }>(
      `SELECT storage_key, user_id FROM blobs WHERE user_id IN ($1, $2)`,
      [first.userId, second.userId],
    );
    const keys = new Set(rows.map((row) => row.storage_key));
    expect(keys.size).toBe(2);
  });

  it('без токена и с чужой подписью не пускает никуда', async () => {
    const user = await createUser(harness);
    const forged = `${user.accessToken.split('.').slice(0, 2).join('.')}.подделка`;
    const noneAlg = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: user.userId, sid: 'x', did: 'y', typ: 'access', iat: 1, exp: 9_999_999_999 })).toString('base64url'),
      '',
    ].join('.');

    for (const header of [undefined, { authorization: 'Bearer ' + forged }, { authorization: 'Bearer ' + noneAlg }]) {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/vault/manifest',
        ...(header === undefined ? {} : { headers: header }),
      });
      expect(response.statusCode).toBe(401);
    }
  });
});

describe.skipIf(noDatabase())('периметр: magic-link', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  /**
   * Гонка: два одновременных перехода по одной ссылке. Без `FOR UPDATE`
   * обе транзакции успевают увидеть `used_at IS NULL` и выдают по сессии —
   * то есть одноразовость превращается в «сколько успеешь».
   */
  it('одноразовость держится под гонкой: две параллельные попытки — одна сессия', async () => {
    const deviceKey = 'device-race-abcdef';
    const issued = await createMagicToken(
      harness.db,
      { email: 'race@example.test', deviceKey, platform: 'web', ttlSeconds: 900 },
      harness.ctx.now(),
    );

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness.app.inject({
          method: 'GET',
          url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(issued.token)}&device_id=${deviceKey}&format=json`,
        }),
      ),
    );

    const accepted = attempts.filter((r) => r.statusCode === 200);
    expect(accepted).toHaveLength(1);
    for (const rejected of attempts.filter((r) => r.statusCode !== 200)) {
      expect(rejected.statusCode).toBe(410);
    }

    const { rows } = await harness.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE lower(u.email) = 'race@example.test'`,
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('токен привязан к устройству инициации и не работает на чужом', async () => {
    const issued = await createMagicToken(
      harness.db,
      { email: 'bound@example.test', deviceKey: 'device-owner-abcdef', platform: 'web', ttlSeconds: 900 },
      harness.ctx.now(),
    );
    const stolen = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(issued.token)}&device_id=device-thief-abcdef`,
    });
    expect(stolen.statusCode).toBe(410);
    // Отбитая попытка не должна «съедать» токен у настоящего владельца.
    const legit = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/magic-link/callback?token=${encodeURIComponent(issued.token)}&device_id=device-owner-abcdef&format=json`,
    });
    expect(legit.statusCode).toBe(200);
  });

  it('сырой токен в базе не хранится — только его хеш', async () => {
    const issued = await createMagicToken(
      harness.db,
      { email: 'hash@example.test', deviceKey: 'device-hash-abcdef', platform: 'web', ttlSeconds: 900 },
      harness.ctx.now(),
    );
    const { rows } = await harness.db.query<{ token_hash: string }>(
      `SELECT token_hash FROM magic_tokens WHERE lower(email) = 'hash@example.test'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(issued.token);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ответ на запрос ссылки одинаков для нового и существующего адреса', async () => {
    const known = await createUser(harness);
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email: known.email, deviceId: 'device-enum-abcdef', acceptedTerms: '2026-08-13' },
    });
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: {
        email: `no-such-user.${Date.now()}@example.test`,
        deviceId: 'device-enum-abcdef',
        acceptedTerms: '2026-08-13',
      },
    });
    expect(first.statusCode).toBe(second.statusCode);
    const strip = (body: string): string => body.replace(/"[^"]*@[^"]*"/g, '"[почта]"').replace(/"expiresAt":"[^"]*"/, '');
    expect(strip(first.body)).toBe(strip(second.body));
  });

  it('refresh-токен ротируется, старый больше не работает', async () => {
    const user = await createUser(harness);
    const rotated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(rotated.statusCode).toBe(200);

    const replay = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(replay.statusCode).toBe(401);
  });
});

describe.skipIf(noDatabase())('периметр: публикация по ссылке', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  /**
   * HTML присылает клиент — значит это недоверенный ввод: у кого угодно с
   * токеном есть возможность отдать сюда что угодно, а страница поедет с
   * нашего домена. Проверяем оба слоя: белый список и CSP.
   */
  const XSS_VECTORS = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<svg/onload=alert(1)>',
    '<a href="javascript:alert(1)">клик</a>',
    '<a href="jAvAsCrIpT&#58;alert(1)">клик</a>',
    '<a href="java\tscript:alert(1)">клик</a>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="evil.swf"></object>',
    '<body onload=alert(1)>',
    '<style>@import url(https://evil.example)</style>',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '<form action="https://evil.example"><input name="p"><button>ok</button></form>',
    '<p title="a>b" onmouseover="alert(1)">z</p>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<template><img src=x onerror=alert(1)></template>',
    '<base href="https://evil.example/">',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
    '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">',
  ];

  /**
   * Проверяем именно ТЕГИ, а не подстроки: одиночные `<` и `>` в тексте
   * санитайзер экранирует, поэтому `onmouseover="…"`, оставшийся текстом,
   * тегом уже не станет и опасности не несёт. Регулярка ниже смотрит только
   * внутрь настоящих тегов — так проверка не даёт ложного спокойствия и не
   * даёт ложной тревоги.
   */
  const DANGEROUS_IN_TAG = [
    /<\s*(script|iframe|svg|style|base|meta|link|form|object|embed|template|noscript|math)\b/i,
    /<[a-z][^>]*\son[a-z]+\s*=/i,
    /<[a-z][^>]*\sstyle\s*=/i,
    /<[a-z][^>]*(href|src|action|data)\s*=\s*"?\s*javascript:/i,
    /<[a-z][^>]*data:image\/svg/i,
  ];

  it('санитайзер не пропускает ни один известный вектор', () => {
    for (const vector of XSS_VECTORS) {
      const { html } = sanitizeHtml(vector);
      for (const pattern of DANGEROUS_IN_TAG) {
        expect(html, `${vector} → ${html}`).not.toMatch(pattern);
      }
    }
  });

  /**
   * ДЕФЕКТ SEC-006 (docs/dev/security/AUDIT.md). Пустые элементы `base`,
   * `meta`, `link`, `input` перечислены в `VOID_CONTENT_TAGS` и, встретившись
   * без `/>`, включают режим «пропускать до закрывающего тега». Закрывающего
   * у них не бывает, поэтому ВСЁ остальное содержимое страницы молча
   * выбрасывается. Это не XSS, а потеря данных в пользовательской функции.
   *
   * Тест помечен `it.fails`: пока дефект жив — он зелёный, после починки
   * станет красным и потребует снять пометку.
   */
  it.fails('[SEC-006] одиночный <meta> в середине не съедает остаток страницы', () => {
    const { html } = sanitizeHtml('<p>до</p><meta charset="utf-8"><p>после</p>');
    expect(html).toContain('после');
  });

  it('опубликованная страница отдаётся без скрипта и с запрещающей CSP', async () => {
    const user = await createUser(harness);
    const published = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/publish',
      headers: user.authHeader,
      payload: {
        // Полезный текст идёт первым: см. SEC-006 — одиночный `<meta>` в
        // середине обрывает разбор, и всё после него теряется.
        html: '<p>полезный текст</p>' + XSS_VECTORS.join(''),
        title: '</title><script>alert(1)</script>',
        lead: '"><img src=x onerror=alert(1)>',
      },
    });
    expect(published.statusCode).toBe(201);
    const slug = (published.json() as { slug: string }).slug;

    const page = await harness.app.inject({ method: 'GET', url: `/p/${slug}` });
    expect(page.statusCode).toBe(200);

    // Шапка страницы — наша собственная (`<style>`, `<meta>`, `<title>`),
    // поэтому смотрим ровно в тот блок, куда подставляется чужой HTML.
    const inner = /<div class="body">([\s\S]*)<\/div>/.exec(page.body)?.[1] ?? '';
    expect(inner).toContain('полезный текст');
    expect(inner).not.toMatch(
      /<\s*(script|iframe|svg|style|object|embed|form|base|meta|link|template|noscript)\b/i,
    );
    expect(inner).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(inner).not.toMatch(/javascript:/i);
    // Заголовок и лид подставляем мы сами — они обязаны быть экранированы.
    expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.body).not.toContain('<script>alert(1)</script>');

    const csp = page.headers['content-security-policy'];
    expect(typeof csp).toBe('string');
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
  });

  it('на ответах API стоит запрещающая CSP и nosniff', async () => {
    const user = await createUser(harness);
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/manifest',
      headers: user.authHeader,
    });
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('внутренняя ошибка не выносит наружу стек и текст исключения', async () => {
    const user = await createUser(harness);
    // Ломаем том: ключ есть в базе, файла нет — обработчик обязан ответить
    // ровно текстом реестра, без пути и без стека.
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/Секретная/папка.md.enc',
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('байты'),
    });
    await harness.db.query(`UPDATE blobs SET storage_key = 'blobs/нет/такого' WHERE user_id = $1`, [
      user.userId,
    ]);
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/blob/Секретная/папка.md.enc',
      headers: user.authHeader,
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('Секретная');
    expect(response.body.toLowerCase()).not.toContain('error:');
    expect(response.body).not.toContain('at ');
  });
});

/**
 * Доверие к заголовку с адресом клиента.
 *
 * Проверка сетей отправителя уехала вместе с ЮKassa: у Т-Кассы подпись лежит
 * в теле и никакого списка адресов не требует. Само правило «сколько прокси
 * впереди» осталось — от него зависит адрес в журнале и ограничитель частоты,
 * и ошибиться в нём значит либо доверять подделанному заголовку, либо считать
 * всех одним клиентом.
 */
describe('периметр: адрес клиента', () => {
  it('разбор TRUST_PROXY по умолчанию доверяет ровно одному переходу', () => {
    expect(parseTrustProxy(undefined)).toBe(1);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('false')).toBe(false);
    // `true` остаётся доступным, но это отладочный режим — в deploy его нет.
    expect(parseTrustProxy('true')).toBe(true);
  });

  /*
   * closure-pass CI: попытка обновить Fastify до 5.12.x (закрывает две
   * moderate CVE самого Fastify, GHSA-w2qp-rph6-63g4 и GHSA-3m5p-2c4r-xxw2)
   * провалила typecheck на `trustProxy: ctx.env.trustProxy` — Fastify 5.12
   * убрал `number` из типа опции. Причина не косметическая: у пакета
   * поменялась и РАБОТА с числом (`getTrustProxyFn`,
   * node_modules/fastify/lib/request.js) — hop-count теперь всегда
   * отклоняется («hop-count-only trust cannot validate the immediate
   * peer»), и `request.ip` стал бы IP самого nginx на КАЖДЫЙ запрос без
   * единой ошибки при старте. Прод держит `TRUST_PROXY=1` (SEC-002) именно
   * как hop-count, и на этом рейт-лимит по IP (`app.ts`, keyGenerator)
   * слился бы в одну корзину на всех, а `remoteAddressHash` в логе потерял
   * бы смысл. `resolveTrustProxy` переносит старую формулу
   * (`hop < hopCount`) наружу явной функцией — и она не зависит от того,
   * поддерживает ли сама библиотека числа.
   */
  describe('resolveTrustProxy переживает апгрейд Fastify — hop-count не отдан библиотеке', () => {
    it('boolean и список адресов проходят как есть — Fastify их и так понимает', () => {
      expect(resolveTrustProxy(false)).toBe(false);
      expect(resolveTrustProxy(true)).toBe(true);
      expect(resolveTrustProxy(['203.0.113.0/24'])).toEqual(['203.0.113.0/24']);
    });

    it('числовой hop-count превращается в функцию с тем же смыслом', () => {
      const fn = resolveTrustProxy(1) as (address: string, hop: number) => boolean;
      expect(typeof fn).toBe('function');
      expect(fn('1.2.3.4', 0)).toBe(true);
      expect(fn('1.2.3.4', 1)).toBe(false);
      expect(fn('1.2.3.4', 2)).toBe(false);
    });

    /*
     * Не юнит на изолированную функцию, а настоящий Fastify + `app.inject`:
     * ровно та связка, что ловит и ложное «доверяю», и ложное «не доверяю».
     */
    it('настоящий Fastify: X-Forwarded-For от одного прокси доверяется, попытка подделать второй хоп — нет', async () => {
      const app = Fastify({ trustProxy: resolveTrustProxy(1) });
      app.get('/whoami', async (request) => ({ ip: request.ip }));
      await app.ready();
      try {
        const direct = await app.inject({
          method: 'GET',
          url: '/whoami',
          remoteAddress: '10.0.0.5',
        });
        expect(direct.json().ip).toBe('10.0.0.5');

        const viaProxy = await app.inject({
          method: 'GET',
          url: '/whoami',
          remoteAddress: '10.0.0.5',
          headers: { 'x-forwarded-for': '203.0.113.9' },
        });
        expect(viaProxy.json().ip).toBe('203.0.113.9');

        // Клиент дописывает себе слева второй, никем не подтверждённый
        // адрес — при доверии ровно одному хопу это не должно протащиться.
        const spoofedSecondHop = await app.inject({
          method: 'GET',
          url: '/whoami',
          remoteAddress: '10.0.0.5',
          headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.9' },
        });
        expect(spoofedSecondHop.json().ip).toBe('203.0.113.9');
      } finally {
        await app.close();
      }
    });
  });
});
