/**
 * Очередь аналитических событий, переживающая перезапуск — тот же приём, что
 * и у `ChangeQueue` (`sync/queue.ts`): ЗАПИСКИ локальное приложение, сеть не
 * гарантирована, событие копится на диске и уходит, когда получится.
 *
 * В отличие от `ChangeQueue` (множество по пути, последняя правка выигрывает)
 * это упорядоченный журнал: каждое событие уходит ровно один раз, дубли не
 * схлопываются.
 */
import type { VaultPath, VaultStorage } from '../contract.js';
import { ANALYTICS_QUEUE_FILE } from '../util/path.js';
import { readJson, writeJsonAtomic } from '../vault/atomic.js';
import type { AnalyticsEvent } from './schema.js';

interface QueuedEvent {
  id: string;
  event: AnalyticsEvent;
}

interface QueueFile {
  version: number;
  events: QueuedEvent[];
}

const QUEUE_VERSION = 1;
/** Не даём офлайн-очереди расти бесконечно — старые события теряются первыми. */
const MAX_QUEUE_SIZE = 500;

let counter = 0;
function nextId(now: () => number): string {
  counter += 1;
  return `${now().toString(36)}-${counter.toString(36)}`;
}

export class AnalyticsQueue {
  private events: QueuedEvent[] = [];

  constructor(
    private readonly storage: VaultStorage,
    private readonly now: () => number = () => Date.now(),
    private readonly file: VaultPath = ANALYTICS_QUEUE_FILE,
  ) {}

  async load(): Promise<void> {
    const parsed = await readJson<QueueFile>(this.storage, this.file);
    this.events =
      parsed && parsed.version === QUEUE_VERSION && Array.isArray(parsed.events) ? parsed.events : [];
  }

  private async flush(): Promise<void> {
    const file: QueueFile = { version: QUEUE_VERSION, events: this.events };
    await writeJsonAtomic(this.storage, this.file, file);
  }

  async enqueue(event: AnalyticsEvent): Promise<void> {
    this.events.push({ id: nextId(this.now), event });
    if (this.events.length > MAX_QUEUE_SIZE) this.events = this.events.slice(-MAX_QUEUE_SIZE);
    await this.flush();
  }

  list(): QueuedEvent[] {
    return [...this.events];
  }

  /** Убрать успешно отправленные — по id, а не по количеству: пришедшее за это время не теряем. */
  async ack(ids: readonly string[]): Promise<void> {
    const sent = new Set(ids);
    const before = this.events.length;
    this.events = this.events.filter((queued) => !sent.has(queued.id));
    if (this.events.length !== before) await this.flush();
  }

  get size(): number {
    return this.events.length;
  }

  /** Отзыв согласия (BEHAVIOR): ничего накопленного не досылается задним числом. */
  async clear(): Promise<void> {
    this.events = [];
    await this.flush();
  }
}
