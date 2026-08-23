/**
 * Мост в приёмник ПРАКТИКИ (C4, доведён контрактом контура v2, E-Z1/E-Z2).
 * Здесь — сам механизм пересылки в изоляции, без базы: фабрика, конверт,
 * заголовок, разбор ответа, поведение при отказе сети. Приём событий
 * сервером ЗАПИСОК и вставка в БД проверяются в `analytics.events.test.ts`;
 * гейт согласия субъекта против смоделированного приёмника — в
 * `practice-bridge.consent.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createPracticeBridge,
  MAX_INGEST_BATCH_SIZE,
  PracticeBridge,
  type PracticeEnvelope,
} from '../src/services/practiceBridge.ts';

function envelope(overrides: Partial<PracticeEnvelope> = {}): PracticeEnvelope {
  return {
    event: 'sync_completed',
    ts: '2026-08-23T10:00:00.000Z',
    product: 'zapiski',
    account_id: 'user-1',
    device_id: null,
    props: { pushed: 1, pulled: 0, conflicts: 0 },
    schema_version: 1,
    event_id: '11111111-1111-4111-8111-111111111111',
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

describe('PracticeBridge.forward — заголовок, конверт, разбор ответа (E-Z1)', () => {
  it('шлёт Authorization: Bearer <секрет> — не x-simpas-ingest-secret (приёмник фактически требует именно это)', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ results: [{ accepted: true }] }), { status: 200 }),
    );
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'top-secret', fetchSpy);

    await bridge.forward(envelope());

    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer top-secret');
    expect(headers['x-simpas-ingest-secret']).toBeUndefined();
  });

  it('тело — массив из одного конверта (не голый объект): единая точка разбора results и для одного события, и для пачки', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ results: [{ accepted: true }] }), { status: 200 }),
    );
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', fetchSpy);

    const result = await bridge.forward(envelope({ event: 'note_saved', schema_version: 1 }));

    expect(result).toEqual({ outcome: 'accepted' });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://cmpas.ru/api/ingest');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    const sent = JSON.parse(String(init?.body)) as PracticeEnvelope[];
    expect(Array.isArray(sent)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.product).toBe('zapiski');
    expect(sent[0]?.event).toBe('note_saved');
    expect(sent[0]?.event_id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('401 (нет заголовка / неверный секрет) — не считается успехом', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ accepted: false, reason: 'unauthorized' }), { status: 401 }));
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'wrong', fetchSpy);
    const result = await bridge.forward(envelope());
    expect(result.outcome).not.toBe('accepted');
  });

  it('{accepted:false} при HTTP 200 (в results) — не считается успехом, а не голый response.ok', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ accepted: false, reason: 'unknown account_id' }] }), { status: 200 }),
    );
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', fetchSpy);
    const result = await bridge.forward(envelope());
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('unknown account_id');
  });

  it('{accepted:true} — считается успехом', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ results: [{ accepted: true }] }), { status: 200 }));
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', fetchSpy);
    const result = await bridge.forward(envelope());
    expect(result).toEqual({ outcome: 'accepted' });
  });

  it('отказ по отсутствию согласия — "rejected", не "error": не спутать с сетевым сбоем, повторять бессмысленно, пока согласия нет', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ accepted: false, reason: 'consent required for subject' }] }), { status: 200 }),
    );
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', fetchSpy);
    const result = await bridge.forward(envelope());
    expect(result.outcome).toBe('rejected');
    expect(result.outcome).not.toBe('error');
  });

  it('не-2xx — "error", не исключение', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }));
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', fetchSpy);
    expect(await bridge.forward(envelope())).toEqual({ outcome: 'error' });
  });

  it('2xx, но тело не тем контрактом (нет results нужной длины) — "error": принятым нельзя считать то, что не подтверждено явно', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', fetchSpy);
    expect(await bridge.forward(envelope())).toEqual({ outcome: 'error' });
  });

  it('сеть недоступна (fetch бросает) — "error", не исключение наружу', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', fetchSpy);
    await expect(bridge.forward(envelope())).resolves.toEqual({ outcome: 'error' });
  });

  it('зависший ответ обрывается таймаутом — "error", не бесконечное ожидание', async () => {
    const hangingFetch = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', hangingFetch, 20);
    await expect(bridge.forward(envelope())).resolves.toEqual({ outcome: 'error' });
  });
});

describe('PracticeBridge.forwardBatch — пересылка пачками (E-Z2)', () => {
  it('до MAX_INGEST_BATCH_SIZE — один HTTP-запрос, поэлементный разбор results', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as PracticeEnvelope[];
      return new Response(
        JSON.stringify({ results: sent.map((_, i) => ({ accepted: i % 2 === 0 })) }),
        { status: 200 },
      );
    });
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', fetchSpy);
    const envelopes = Array.from({ length: 5 }, (_, i) =>
      envelope({ event_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }),
    );

    const results = await bridge.forwardBatch(envelopes);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.outcome)).toEqual(['accepted', 'rejected', 'accepted', 'rejected', 'accepted']);
  });

  it('MAX_INGEST_BATCH_SIZE — предел из одного места, совпадает с пределом приёмника (200)', () => {
    expect(MAX_INGEST_BATCH_SIZE).toBe(200);
  });

  it('450 конвертов — три запроса [200, 200, 50], результаты в исходном порядке', async () => {
    const requestSizes: number[] = [];
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as PracticeEnvelope[];
      requestSizes.push(sent.length);
      return new Response(JSON.stringify({ results: sent.map(() => ({ accepted: true })) }), { status: 200 });
    });
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', fetchSpy);
    const envelopes = Array.from({ length: 450 }, (_, i) =>
      envelope({ event_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }),
    );

    const results = await bridge.forwardBatch(envelopes);

    expect(requestSizes).toEqual([200, 200, 50]);
    expect(results).toHaveLength(450);
    expect(results.every((r) => r.outcome === 'accepted')).toBe(true);
  });

  it('один из трёх запросов сети недоступен — только его элементы "error", остальные не теряются', async () => {
    let call = 0;
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      call += 1;
      if (call === 2) throw new Error('ECONNREFUSED');
      const sent = JSON.parse(String(init?.body)) as PracticeEnvelope[];
      return new Response(JSON.stringify({ results: sent.map(() => ({ accepted: true })) }), { status: 200 });
    });
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', fetchSpy);
    const envelopes = Array.from({ length: 450 }, (_, i) =>
      envelope({ event_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }),
    );

    const results = await bridge.forwardBatch(envelopes);

    expect(results.slice(0, 200).every((r) => r.outcome === 'accepted')).toBe(true);
    expect(results.slice(200, 400).every((r) => r.outcome === 'error')).toBe(true);
    expect(results.slice(400, 450).every((r) => r.outcome === 'accepted')).toBe(true);
  });

  it('пустой массив — не бьёт по сети вовсе', async () => {
    const fetchSpy = vi.fn();
    const bridge = new PracticeBridge('https://cmpas.ru/api/ingest', 'shh', fetchSpy);
    expect(await bridge.forwardBatch([])).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
