/**
 * `AnalyticsQueue` (O-260817-05): очередь на диске, переживает перезапуск,
 * события не схлопываются, как в `ChangeQueue`, а идут по одному.
 */
import { describe, expect, it } from 'vitest';
import { MemoryVaultStorage } from '../src/memory-storage.js';
import { AnalyticsQueue } from '../src/analytics/queue.js';
import { buildAnalyticsEvent } from '../src/analytics/schema.js';

function event(n: number) {
  return buildAnalyticsEvent('sync_completed', { pushed: n, pulled: 0, conflicts: 0 }, () => n)!;
}

describe('AnalyticsQueue', () => {
  it('копится, переживает перезапуск и не схлопывает повторы', async () => {
    const storage = new MemoryVaultStorage();
    const queue = new AnalyticsQueue(storage, () => 1);
    await queue.enqueue(event(1));
    await queue.enqueue(event(1));
    expect(queue.size).toBe(2);

    const restored = new AnalyticsQueue(storage, () => 2);
    await restored.load();
    expect(restored.size).toBe(2);
    expect(restored.list().map((q) => q.event.props.pushed)).toEqual([1, 1]);
  });

  it('ack убирает только подтверждённые id, остальное остаётся', async () => {
    const storage = new MemoryVaultStorage();
    const queue = new AnalyticsQueue(storage, () => 1);
    await queue.enqueue(event(1));
    await queue.enqueue(event(2));
    const [first, second] = queue.list();
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    await queue.ack([first!.id]);
    expect(queue.size).toBe(1);
    expect(queue.list()[0]?.id).toBe(second!.id);
  });

  it('пришедшее между ack-вызовом и его завершением не теряется', async () => {
    const storage = new MemoryVaultStorage();
    const queue = new AnalyticsQueue(storage, () => 1);
    await queue.enqueue(event(1));
    const sentId = queue.list()[0]?.id;
    expect(sentId).toBeDefined();

    await queue.enqueue(event(2));
    await queue.ack([sentId!]);
    expect(queue.size).toBe(1);
    expect(queue.list()[0]?.event.props.pushed).toBe(2);
  });

  it('битый файл очереди не роняет запуск — просто пустая очередь', async () => {
    const storage = new MemoryVaultStorage({ files: { '.zapiski/analytics-queue.json': 'не json' } });
    const queue = new AnalyticsQueue(storage);
    await queue.load();
    expect(queue.size).toBe(0);
  });

  it('очередь не растёт бесконечно офлайн — старые события уходят первыми', async () => {
    const storage = new MemoryVaultStorage();
    const queue = new AnalyticsQueue(storage, () => 1);
    for (let i = 0; i < 510; i += 1) await queue.enqueue(event(i));
    expect(queue.size).toBe(500);
    expect(queue.list()[0]?.event.props.pushed).toBe(10); // первые 10 (0..9) вытеснены
  });
});
