/**
 * Мост в приёмник ПРАКТИКИ (C4, `charter/12_ANALYTICS.md §3`). Здесь — сам
 * механизм пересылки в изоляции, без базы: фабрика, конверт, поведение при
 * отказе сети. Приём событий сервером ЗАПИСОК и вставка в БД проверяются в
 * `analytics.events.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createPracticeBridge, PracticeBridge, type PracticeEnvelope } from '../src/services/practiceBridge.ts';

function envelope(overrides: Partial<PracticeEnvelope> = {}): PracticeEnvelope {
  return {
    event: 'sync_completed',
    ts: '2026-08-23T10:00:00.000Z',
    product: 'zapiski',
    account_id: 'user-1',
    device_id: null,
    props: { pushed: 1, pulled: 0, conflicts: 0 },
    schema_version: 1,
    ...overrides,
  };
}

describe('createPracticeBridge — честное поведение при отсутствии настройки', () => {
  it('нет ни адреса, ни секрета — null, мост выключен', () => {
    expect(createPracticeBridge({})).toBeNull();
  });

  it('есть адрес, нет секрета — null (слепая отправка без аутентификации недопустима)', () => {
    expect(createPracticeBridge({ PRACTICE_INGEST_URL: 'https://cmpas.ru/api/ingest' })).toBeNull();
  });

  it('есть секрет, нет адреса — null (послать некуда)', () => {
    expect(createPracticeBridge({ PRACTICE_INGEST_SECRET: 'shh' })).toBeNull();
  });

  it('заданы оба — мост создан', () => {
    const bridge = createPracticeBridge({
      PRACTICE_INGEST_URL: 'https://cmpas.ru/api/ingest',
      PRACTICE_INGEST_SECRET: 'shh',
    });
    expect(bridge).toBeInstanceOf(PracticeBridge);
  });
});

describe('PracticeBridge.forward — конверт и заголовки', () => {
  it('шлёт ровно одно событие (не батч) с правильным адресом, секретом в заголовке и телом-конвертом', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'top-secret', fetchSpy);

    const ok = await bridge.forward(envelope({ event: 'note_saved', schema_version: 1 }));

    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://cmpas.ru/api/ingest');
    expect((init?.headers as Record<string, string>)['x-simpas-ingest-secret']).toBe('top-secret');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    const sent = JSON.parse(String(init?.body)) as PracticeEnvelope;
    // Ключевая проверка C4: правильные product и schema_version в конверте.
    expect(sent.product).toBe('zapiski');
    expect(sent.event).toBe('note_saved');
    expect(sent.schema_version).toBe(1);
    // Не батч: тело — это сам конверт, а не { events: [...] }.
    expect(sent).not.toHaveProperty('events');
  });

  it('не-2xx от ПРАКТИКИ — false, не исключение', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }));
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', fetchSpy);
    expect(await bridge.forward(envelope())).toBe(false);
  });

  it('сеть недоступна (fetch бросает) — false, не исключение наружу', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', fetchSpy);
    await expect(bridge.forward(envelope())).resolves.toBe(false);
  });

  it('зависший ответ обрывается таймаутом — false, не бесконечное ожидание', async () => {
    // Настоящий fetch реагирует на AbortSignal отказом промиса — подделка
    // повторяет это поведение, иначе тест проверял бы не таймаут моста, а
    // собственное бессмертие фальшивки.
    const hangingFetch: (url: string, init?: RequestInit) => Promise<Response> = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', hangingFetch, 20);
    await expect(bridge.forward(envelope())).resolves.toBe(false);
  });
});
