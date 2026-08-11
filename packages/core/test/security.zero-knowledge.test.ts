/**
 * Проверки безопасности ядра — обещания, данные пользователю в ТЗ и в тексте
 * письма («Заметки мы не читаем — технически не можем»).
 *
 * Файл написан аудитом. Часть проверок помечена `it.fails`: они формулируют
 * ЖЕЛАЕМОЕ свойство, которого сегодня нет. Пока дефект жив, такой тест
 * зелёный; как только дефект закроют — он станет красным и заставит снять
 * пометку. Так известная дыра не превращается в тихо забытую.
 *
 * Разбор каждой — docs/dev/security/AUDIT.md по номеру SEC-NNN.
 */
import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';

import { decodeContainer, encodeContainer, NONCE_LENGTH, SALT_LENGTH } from '../src/crypto/container.js';
import { encryptNoteFile } from '../src/crypto/notes.js';
import { ARGON2_PARAMS, WebCryptoProvider } from '../src/crypto/provider.js';
import { markdownToHtml, safeImageUrl, safeLinkUrl } from '../src/export/html.js';
import { unzip } from '../src/import/types.js';
import { MemoryVaultStorage } from '../src/memory-storage.js';
import { CrdtStore } from '../src/crdt/store.js';
import { NoteDoc } from '../src/crdt/doc.js';
import { VersionHistory } from '../src/sync/versions.js';
import { ZapiskiCloudBackend } from '../src/sync/zapiski-cloud.js';
import { utf8, fromUtf8 } from '../src/util/bytes.js';

/** Облегчённый KDF: проверяется контракт формата, а не стойкость Argon2id. */
const provider = new WebCryptoProvider({
  argon2: { memorySize: 1024, iterations: 1, parallelism: 1 },
});

const SECRET = '# Дневник\n\nСеанс с клиентом К., диагноз и телефон 79990000000.\n';

// ─────────────────────────────────────────────────────────────────────────────
// Контейнер и KDF: то, что уже сделано правильно, — закрепляем
// ─────────────────────────────────────────────────────────────────────────────

describe('крипто: инварианты, которые обязаны держаться', () => {
  it('параметры Argon2id — второй набор RFC 9106 §4, соль ≥16 байт', () => {
    expect(ARGON2_PARAMS).toEqual({
      iterations: 3,
      memorySize: 65_536,
      parallelism: 4,
      hashLength: 32,
    });
    expect(SALT_LENGTH).toBeGreaterThanOrEqual(16);
    expect(NONCE_LENGTH).toBe(12);
  });

  it('соль не переиспользуется между вызовами randomSalt', () => {
    const salts = new Set<string>();
    for (let i = 0; i < 500; i += 1) salts.add(Buffer.from(provider.randomSalt()).toString('hex'));
    expect(salts.size).toBe(500);
  });

  /**
   * Переиспользование nonce с одним ключом в GCM — катастрофа: оно вскрывает
   * XOR открытых текстов и позволяет подделывать теги. Проверяем прямо.
   */
  it('nonce уникален на каждое шифрование одним и тем же ключом', async () => {
    const salt = provider.randomSalt();
    const key = await provider.deriveMasterKey('пароль', salt);
    const nonces = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const container = decodeContainer(await provider.encrypt(SECRET, key));
      expect(container).not.toBeNull();
      nonces.add(Buffer.from(container!.nonce).toString('hex'));
    }
    expect(nonces.size).toBe(300);
  });

  it('неверный пароль возвращает null, а не бросает (BEHAVIOR §5.2)', async () => {
    const salt = provider.randomSalt();
    const key = await provider.deriveMasterKey('верный', salt);
    const wrong = await provider.deriveMasterKey('неверный', salt);
    const blob = await provider.encrypt(SECRET, key);
    await expect(provider.decrypt(blob, wrong)).resolves.toBeNull();
  });

  it('усечённый, пустой и побитый контейнер не роняют приложение', async () => {
    const salt = provider.randomSalt();
    const key = await provider.deriveMasterKey('пароль', salt);
    const blob = await provider.encrypt(SECRET, key);

    for (let cut = 0; cut <= blob.length; cut += Math.max(1, Math.floor(blob.length / 17))) {
      await expect(provider.decrypt(blob.slice(0, cut), key), `обрезка ${cut}`).resolves.toBeNull();
    }
    // Magic, версия, nonce и шифротекст: любая порча обязана давать null.
    const header = 10;
    const nonceAt = header + SALT_LENGTH;
    for (const index of [0, 3, 4, nonceAt, nonceAt + NONCE_LENGTH, blob.length - 1]) {
      const damaged = Uint8Array.from(blob);
      damaged[index] = (damaged[index]! ^ 0xff) & 0xff;
      await expect(provider.decrypt(damaged, key), `байт ${index}`).resolves.toBeNull();
    }
    await expect(provider.decrypt(new Uint8Array(0), key)).resolves.toBeNull();
    expect(decodeContainer(new Uint8Array(9))).toBeNull();
  });

  it('ключ неэкспортируем и не сериализуется', async () => {
    const key = await provider.deriveMasterKey('пароль', provider.randomSalt());
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    // Ключ не должен утекать через JSON: в нём нет байтов и нечего печатать.
    expect(JSON.stringify(key)).not.toContain('пароль');
  });

  it('ни пароль, ни открытый текст не попадают в шифротекст как есть', async () => {
    const password = 'очень-личный-пароль';
    const key = await provider.deriveMasterKey(password, provider.randomSalt());
    const blob = await provider.encrypt(SECRET, key, 'подсказка');
    const asText = Buffer.from(blob).toString('utf8');
    expect(asText).not.toContain(password);
    expect(asText).not.toContain('Дневник');
    expect(asText).not.toContain('79990000000');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-004: заголовок контейнера не аутентифицирован (нет AAD)
// ─────────────────────────────────────────────────────────────────────────────

describe('SEC-004: заголовок контейнера .md.enc', () => {
  /**
   * Заголовок (magic, версия, соль, nonce, подсказка) в AAD не попадает,
   * поэтому подмена подсказки не ломает расшифровку. Тот, кто держит файл
   * (облако синка, WebDAV-провайдер, вор устройства), переписывает подсказку
   * на «введите пароль от почты» — и приложение честно показывает её под
   * полем ввода (BEHAVIOR §5.2). Это фишинг против единственного секрета,
   * на котором держится весь zero-knowledge.
   */
  it('[ДЕФЕКТ] подмена подсказки видна пользователю и не ломает расшифровку', async () => {
    const salt = provider.randomSalt();
    const key = await provider.deriveMasterKey('пароль', salt);
    const original = await provider.encrypt(SECRET, key, 'как в прошлый раз');
    const parsed = decodeContainer(original)!;

    const tampered = encodeContainer({ ...parsed, hint: 'введите пароль от вашей почты' });

    // Вот это и есть дефект: шифротекст не тронут, подсказка чужая,
    // расшифровка проходит.
    expect(await provider.decrypt(tampered, key)).toBe(SECRET);
    expect(provider.parseHeader(tampered)?.hint).toBe('введите пароль от вашей почты');
  });

  /**
   * Тот же корень: соль лежит в заголовке и в AAD не входит. При уже
   * выведенном ключе её порча вообще не замечается, а при следующей
   * разблокировке из пароля выведется другой ключ — пользователь увидит
   * «Пароль не подошёл» на верном пароле и решит, что потерял заметку.
   */
  it('[ДЕФЕКТ] порча соли в заголовке не обнаруживается', async () => {
    const salt = provider.randomSalt();
    const key = await provider.deriveMasterKey('пароль', salt);
    const blob = await provider.encrypt(SECRET, key);
    const damaged = Uint8Array.from(blob);
    damaged[10] = (damaged[10]! ^ 0xff) & 0xff; // первый байт соли

    expect(await provider.decrypt(damaged, key)).toBe(SECRET);
    expect(Buffer.from(provider.parseHeader(damaged)!.salt).equals(Buffer.from(salt))).toBe(false);
  });

  it.fails('[SEC-004] подмена заголовка обязана ломать расшифровку (AAD)', async () => {
    const salt = provider.randomSalt();
    const key = await provider.deriveMasterKey('пароль', salt);
    const original = await provider.encrypt(SECRET, key, 'как в прошлый раз');
    const parsed = decodeContainer(original)!;
    const tampered = encodeContainer({ ...parsed, hint: 'введите пароль от вашей почты' });

    expect(await provider.decrypt(tampered, key)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-003: открытый текст переживает шифрование заметки
// ─────────────────────────────────────────────────────────────────────────────

describe('SEC-003: следы открытого текста после шифрования', () => {
  const buildVaultWithHistory = async (): Promise<MemoryVaultStorage> => {
    const storage = new MemoryVaultStorage();
    await storage.write('Дневник.md', utf8(SECRET));

    // Ровно то, что делает редактор при автосохранении: CRDT-лог + снапшот.
    const crdt = new CrdtStore(storage, 'test-device');
    const doc = NoteDoc.fromMarkdown(SECRET, 'test-device');
    await crdt.save('note-1', doc);
    doc.destroy();
    await new VersionHistory(storage, () => 1).push('note-1', SECRET, 'test-device');

    return storage;
  };

  const plaintextTraces = async (storage: MemoryVaultStorage): Promise<string[]> => {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await storage.list(dir)) {
        if (entry.isDirectory) {
          await walk(entry.path);
          continue;
        }
        const data = await storage.read(entry.path);
        if (data === null) continue;
        if (fromUtf8(data).includes('Сеанс с клиентом')) found.push(entry.path);
      }
    };
    await walk('');
    return found;
  };

  it('[ДЕФЕКТ] CRDT-лог и локальная история переживают шифрование', async () => {
    const storage = await buildVaultWithHistory();
    const key = await provider.deriveMasterKey('пароль', provider.randomSalt());

    await encryptNoteFile(storage, provider, 'Дневник.md', key);

    // Сам `.md` затёрт и удалён — это сделано верно.
    expect(await storage.read('Дневник.md')).toBeNull();

    // А вот служебные файлы остались, и в них — тот же текст.
    const traces = await plaintextTraces(storage);
    expect(traces).toContain('.zapiski/versions/note-1.json');
    expect(traces).toContain('.zapiski/crdt/note-1.bin');
  });

  it.fails('[SEC-003] после шифрования открытого текста на диске не остаётся', async () => {
    const storage = await buildVaultWithHistory();
    const key = await provider.deriveMasterKey('пароль', provider.randomSalt());
    await encryptNoteFile(storage, provider, 'Дневник.md', key);
    expect(await plaintextTraces(storage)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-001: zero-knowledge облака КОМПАС
// ─────────────────────────────────────────────────────────────────────────────

describe('SEC-001: что уходит в облако КОМПАС', () => {
  const capture = (): { sent: Array<{ url: string; body: string }>; fetch: typeof fetch } => {
    const sent: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const raw = init?.body;
      const body =
        raw === undefined || raw === null
          ? ''
          : typeof raw === 'string'
            ? raw
            : Buffer.from(raw as Uint8Array).toString('utf8');
      sent.push({ url, body });
      return new Response(null, { status: 200, headers: { etag: '"1"' } });
    }) as unknown as typeof fetch;
    return { sent, fetch: fetchImpl };
  };

  /**
   * ARCHITECTURE §3.3: «На сервер уходят только зашифрованные байты. Открытый
   * текст заметки не покидает устройство никогда». ТЗ §2.1.5: «Сервер
   * технически не может расшифровать пользовательские данные». Письмо входа
   * говорит пользователю то же самое.
   *
   * Между `Vault`/`SyncEngine` и `ZapiskiCloudBackend` нет ни одного вызова
   * `CryptoProvider`: бэкенд отправляет байты файла как есть. Заметка,
   * которую пользователь не зашифровал сам паролем (а это поведение по
   * умолчанию), уезжает в облако открытым текстом — вместе с путём, в котором
   * лежит её заголовок.
   */
  it('[ДЕФЕКТ] незашифрованная заметка уходит в облако как есть', async () => {
    const { sent, fetch: fetchImpl } = capture();
    const backend = new ZapiskiCloudBackend({
      baseUrl: 'https://zapiski.test',
      token: 'токен',
      deviceId: 'device-1',
      fetch: fetchImpl as never,
    });

    await backend.put('Практика/Клиент К.md', utf8(SECRET));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('Сеанс с клиентом');
    // И путь, в котором лежат имя клиента и название папки, — в URL запроса.
    expect(decodeURIComponent(sent[0]!.url)).toContain('Клиент К.md');
  });

  it.fails('[SEC-001] в облако не уходит ни байта открытого текста', async () => {
    const { sent, fetch: fetchImpl } = capture();
    const backend = new ZapiskiCloudBackend({
      baseUrl: 'https://zapiski.test',
      token: 'токен',
      deviceId: 'device-1',
      fetch: fetchImpl as never,
    });

    await backend.put('Практика/Клиент К.md', utf8(SECRET));
    expect(sent[0]!.body).not.toContain('Сеанс с клиентом');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-005: экспорт в HTML/PDF — исправлено
// ─────────────────────────────────────────────────────────────────────────────

describe('SEC-005: адреса в экспортном документе', () => {
  const HOSTILE = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    ' javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'file:///etc/passwd',
  ];

  it('опасные схемы не доживают до атрибута href', () => {
    for (const url of HOSTILE) expect(safeLinkUrl(url), url).toBe('');
  });

  it('обычные адреса не ломаются', () => {
    for (const url of [
      'https://cmpas.ru',
      'http://example.test/a?b=1',
      'mailto:zapiski@cmpas.ru',
      'attachments/2026-08-08_1a2b3c.png',
      '#сноска-1',
      'Проекты/Идея.html',
    ]) {
      expect(safeLinkUrl(url), url).toBe(url);
    }
  });

  it('картинка допускает только относительный путь, http(s) и растровый data:', () => {
    expect(safeImageUrl('attachments/a.png')).toBe('attachments/a.png');
    expect(safeImageUrl('https://example.test/a.png')).toBe('https://example.test/a.png');
    expect(safeImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    // SVG умеет носить в себе скрипт — не пускаем даже как data:.
    expect(safeImageUrl('data:image/svg+xml;base64,PHN2Zy8+')).toBe('');
    expect(safeImageUrl('javascript:alert(1)')).toBe('');
  });

  /**
   * Заметка может приехать синком от скомпрометированной стороны, а экспортный
   * HTML открывается в браузере (file://) и, при печати в PDF, внутри WebView
   * приложения. Ссылки с исполняемой схемой там быть не должно.
   */
  it('вредоносная заметка не даёт исполняемой ссылки в экспорте', () => {
    const html = markdownToHtml(
      [
        '[клик](javascript:alert(document.domain))',
        '![](javascript:alert(1))',
        '[[javascript:alert(2)]]',
        '[файл](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
        '<script>alert(3)</script>',
        '[нормальная](https://cmpas.ru)',
      ].join('\n\n'),
    );

    // Опасная схема допустима как ТЕКСТ (заголовок висячей wiki-ссылки),
    // но не как значение атрибута — именно атрибут исполняется по клику.
    expect(html).not.toMatch(/<[a-z][^>]*=\s*"[^"]*javascript:/i);
    expect(html).not.toMatch(/<[a-z][^>]*=\s*"[^"]*data:text\/html/i);
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<a[^>]*href="(?!https?:|mailto:|[^":]*")/i);
    expect(html).toContain('&lt;script&gt;');
    // Текст не теряется: пропала только ссылка, не содержимое заметки.
    expect(html).toContain('клик');
    expect(html).toContain('<a href="https://cmpas.ru">нормальная</a>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-007: импорт архива без ограничения на распаковку
// ─────────────────────────────────────────────────────────────────────────────

describe('SEC-007: импорт zip', () => {
  /** ~16 МиБ нулей сжимаются в единицы килобайт — коэффициент под тысячу. */
  const bomb = (): Uint8Array =>
    zipSync({ 'note.md': new Uint8Array(16 * 1024 * 1024) }, { level: 9 });

  it('[ДЕФЕКТ] архив разворачивается целиком, без предела на размер', () => {
    const archive = bomb();
    expect(archive.byteLength).toBeLessThan(200 * 1024);
    const files = unzip(archive);
    expect(files.get('note.md')!.byteLength).toBe(16 * 1024 * 1024);
  });

  it.fails('[SEC-007] распаковка ограничена разумным пределом', () => {
    expect(() => unzip(bomb())).toThrow();
  });
});
