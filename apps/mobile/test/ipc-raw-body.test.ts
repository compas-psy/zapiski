/**
 * Байты доезжают до Rust. На Android это не само собой.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * `callRaw` слал `Uint8Array`, а команды принимали `InvokeBody::Raw` — ровно
 * как написано в документации Tauri («Accessing Raw Request»). На Android так
 * не работает НИКОГДА: в транспорте Tauri (`scripts/ipc-protocol.js`) стоит
 *
 *     const canUseCustomProtocol = osName !== 'android'
 *
 * — то есть запрос уходит не POST-ом со своим телом, а через
 * `window.ipc.postMessage`, где сообщение целиком проходит `JSON.stringify`.
 * Сырого тела там нет и быть не может.
 *
 * Цена: `vault_write_atomic`, `saf_write` и `save_file` — сохранение заметки в
 * каталог приложения, сохранение в выбранную папку и экспорт файла — не могли
 * отработать ни разу. Приложение отвечало «тело запроса должно быть бинарным»
 * на свои собственные данные.
 *
 * ── Что сторожится здесь ────────────────────────────────────────────────────
 *
 *  1. Форма полезной нагрузки — та самая, которую читает `src-tauri/src/body.rs`:
 *     объект с полем `data` и строкой base64. Разъедутся стороны — тест скажет.
 *  2. Байты переживают дорогу без искажений, включая нулевые и старшие.
 *  3. Кодирование не падает на большом вложении. `String.fromCharCode(...bytes)`
 *     разворачивает массив в аргументы вызова, и на мегабайте это не
 *     «медленно», а `RangeError: Maximum call stack size exceeded`. Проверка
 *     falsifiable: увеличьте `BASE64_CHUNK` до длины массива — тест упадёт.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async () => undefined);

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...(args as [])) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));

const { callRaw } = await import('../src/platform/ipc');

/** Разбор base64 обратно в байты — то же, что делает Rust. */
function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/** Полезная нагрузка последнего вызова `invoke`. */
function lastPayload(): { data: string } {
  const call = invoke.mock.calls.at(-1);
  expect(call, 'invoke не вызывался').toBeDefined();
  return (call as unknown as [string, { data: string }])[1];
}

beforeEach(() => {
  invoke.mockClear();
});

describe('тело запроса с байтами', () => {
  it('едет объектом с полем data и строкой base64', async () => {
    await callRaw('vault_write_atomic', new TextEncoder().encode('# Идея\n'), {
      'x-vault-path': '%D0%98%D0%B4%D0%B5%D1%8F.md',
    });

    const [command, payload, options] = invoke.mock.calls.at(-1) as unknown as [
      string,
      { data: string },
      { headers: Record<string, string> },
    ];

    expect(command).toBe('vault_write_atomic');
    expect(Object.keys(payload), 'форма разошлась с src-tauri/src/body.rs').toEqual(['data']);
    expect(typeof payload.data).toBe('string');
    /* Заголовок с путём обязан ехать рядом: без него Rust не знает, куда писать. */
    expect(options.headers['x-vault-path']).toBe('%D0%98%D0%B4%D0%B5%D1%8F.md');
  });

  it('байты возвращаются теми же, включая нулевые и старшие', async () => {
    /* Не текст: заметка может быть и вложением. Нулевой байт и 0xFF —
       классические места, где ломается наивное кодирование. */
    const source = new Uint8Array([0, 1, 127, 128, 255, 0, 254]);

    await callRaw('vault_write_atomic', source);

    expect([...fromBase64(lastPayload().data)]).toEqual([...source]);
  });

  it('вложение в мегабайт кодируется, а не роняет стек', async () => {
    const big = new Uint8Array(1_000_000);
    for (let at = 0; at < big.length; at += 1) big[at] = at % 256;

    await callRaw('save_file', big);

    const decoded = fromBase64(lastPayload().data);
    expect(decoded.length).toBe(big.length);
    /* Сверяем края и середину: побайтовое сравнение миллиона значений в
       отчёте vitest нечитаемо, а склейка кусков ломается именно на стыках. */
    expect(decoded[0]).toBe(big[0]);
    expect(decoded[8191]).toBe(big[8191]);
    expect(decoded[8192]).toBe(big[8192]);
    expect(decoded[499_999]).toBe(big[499_999]);
    expect(decoded.at(-1)).toBe(big.at(-1));
  });

  it('пустое тело — это пустая строка, а не отказ', async () => {
    await callRaw('vault_write_atomic', new Uint8Array(0));

    expect(lastPayload().data).toBe('');
  });
});
