import type { LiveEvent } from '../protocol.ts';

/**
 * Шина уведомлений для websocket `/api/v1/vault/live`.
 *
 * ТЗ §6: наружу уходят только имена путей и etag — никакого содержимого.
 * События не персистятся: websocket отвечает за «мгновенно», а за «не
 * потерять» отвечает манифест, который клиент запрашивает при подключении.
 *
 * Шина внутрипроцессная. Развёртывание по ADR-0003 — один контейнер
 * `zapiski-api`, поэтому этого достаточно. Если контейнеров станет больше,
 * сюда добавляется мост на LISTEN/NOTIFY Postgres; интерфейс не меняется.
 */

export type LiveListener = (event: LiveEvent) => void;

export class LiveBus {
  readonly #listeners = new Map<string, Set<LiveListener>>();

  subscribe(userId: string, listener: LiveListener): () => void {
    let set = this.#listeners.get(userId);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(userId, set);
    }
    set.add(listener);

    return () => {
      const current = this.#listeners.get(userId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.#listeners.delete(userId);
    };
  }

  publish(userId: string, event: LiveEvent): void {
    const set = this.#listeners.get(userId);
    if (set === undefined) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // Упавший подписчик не должен ронять запись, которая его породила.
      }
    }
  }

  subscriberCount(userId: string): number {
    return this.#listeners.get(userId)?.size ?? 0;
  }
}
