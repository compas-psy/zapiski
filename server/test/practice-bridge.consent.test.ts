/**
 * Гейт согласия субъекта на стороне ПРАКТИКИ — против СМОДЕЛИРОВАННОГО
 * приёмника (E-Z3, контракт контура v2 §5).
 *
 * Настоящий код `/ingest` ПРАКТИКИ на день чтения (23.08.2026, см. шапку
 * `practiceBridge.ts`) ещё не реализует схему субъекта `product:account_id`
 * из контракта — совпадает со старым поведением (ищет `User.id` буквально).
 * Проверить мост против него значило бы проверить против кода, который сам
 * контракт называет временно расходящимся. Поэтому здесь — простейшая
 * модель приёмника, реализующая РОВНО то, что контракт обещает: субъект без
 * согласия отвергает всё, кроме `consent_updated`; `consent_updated`
 * поднимает/снимает согласие немедленно и при этом сам всегда принят;
 * порядок внутри одного массива соблюдается (запись согласия применяется до
 * оценки следующих элементов ТОГО ЖЕ запроса).
 *
 * Это не замена интеграционного теста против настоящей ПРАКТИКИ — это
 * доказательство того, что МОСТ корректно реализует контракт своей стороны:
 * шлёт то, что нужно, в том порядке, в каком нужно, и правильно читает
 * ответ. Именованные факты — так и попадают в отчёт задачи E.
 */
import { describe, expect, it } from 'vitest';
import { PracticeBridge, type FetchLike, type PracticeEnvelope } from '../src/services/practiceBridge.ts';

/**
 * Простейшая модель `/ingest`: субъект — `product:account_id`, согласие —
 * `Set` в памяти, `consent_updated` всегда принят и меняет состояние ДО
 * оценки последующих элементов того же массива (как `Array.prototype.map`
 * естественно и делает — синхронно, по возрастанию индекса).
 */
function fakeIngest(): { fetch: FetchLike; grantedSubjects: () => string[] } {
  const granted = new Set<string>();
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as PracticeEnvelope[];
    const results = body.map((envelope) => {
      const subject = `${envelope.product}:${envelope.account_id}`;
      if (envelope.event === 'consent_updated') {
        if (envelope.props['granted'] === true) granted.add(subject);
        else granted.delete(subject);
        return { accepted: true };
      }
      if (!granted.has(subject)) return { accepted: false, reason: 'consent required for subject' };
      return { accepted: true };
    });
    return new Response(JSON.stringify({ results }), { status: 200 });
  };
  return { fetch, grantedSubjects: () => [...granted] };
}

function envelope(overrides: Partial<PracticeEnvelope> = {}): PracticeEnvelope {
  return {
    event: 'note_saved',
    ts: '2026-08-23T10:00:00.000Z',
    product: 'zapiski',
    account_id: 'user-1',
    device_id: null,
    props: { length_bucket: 's', encrypted: false },
    schema_version: 1,
    event_id: crypto.randomUUID(),
    ...overrides,
  };
}

describe('гейт согласия субъекта (смоделированный приёмник, E-Z3)', () => {
  it('без согласия — событие отвергнуто; после consent_updated{granted:true} — принято; отзыв работает и не теряется', async () => {
    const { fetch } = fakeIngest();
    const bridge = new PracticeBridge('https://practice.test/ingest', 'shh', fetch);

    const before = await bridge.forward(envelope());
    expect(before.outcome).toBe('rejected');
    expect(before.reason).toBe('consent required for subject');

    const grant = await bridge.forward(
      envelope({ event: 'consent_updated', props: { granted: true }, event_id: crypto.randomUUID() }),
    );
    expect(grant.outcome).toBe('accepted');

    const after = await bridge.forward(envelope({ event_id: crypto.randomUUID() }));
    expect(after.outcome).toBe('accepted');

    const revoke = await bridge.forward(
      envelope({ event: 'consent_updated', props: { granted: false }, event_id: crypto.randomUUID() }),
    );
    expect(revoke.outcome).toBe('accepted'); // отзыв доезжает так же надёжно, как выдача — не теряется

    const afterRevoke = await bridge.forward(envelope({ event_id: crypto.randomUUID() }));
    expect(afterRevoke.outcome).toBe('rejected');
  });

  it('согласие первым элементом ОДНОГО батча открывает остальные элементы ТОГО ЖЕ батча (контракт §5)', async () => {
    const { fetch } = fakeIngest();
    const bridge = new PracticeBridge('https://practice.test/ingest', 'shh', fetch);

    const results = await bridge.forwardBatch([
      envelope({ event: 'consent_updated', props: { granted: true }, event_id: crypto.randomUUID() }),
      envelope({ event: 'note_saved', event_id: crypto.randomUUID() }),
      envelope({ event: 'sync_completed', props: { pushed: 1, pulled: 0, conflicts: 0 }, event_id: crypto.randomUUID() }),
    ]);

    expect(results.map((r) => r.outcome)).toEqual(['accepted', 'accepted', 'accepted']);
  });

  it('согласие одного субъекта не открывает события другого субъекта того же продукта', async () => {
    const { fetch } = fakeIngest();
    const bridge = new PracticeBridge('https://practice.test/ingest', 'shh', fetch);

    await bridge.forward(envelope({ event: 'consent_updated', props: { granted: true }, account_id: 'user-1' }));

    const otherUser = await bridge.forward(envelope({ account_id: 'user-2' }));
    expect(otherUser.outcome).toBe('rejected');
  });
});
