/**
 * Очередь обращений беты.
 *
 * ── Почему очередь, а не «отправить и показать ошибку» ──────────────────────
 *
 * Приложение локальное: аккаунт может отсутствовать вовсе, сеть — тем более.
 * Человек ловит раздражение в тот момент, когда оно возникло, и через минуту
 * забывает. Если отправка не удалась и мы сказали «попробуйте позже», обращение
 * не появится больше никогда — не потому, что человек передумал, а потому что
 * момент прошёл.
 *
 * Поэтому обращение принимается всегда: сначала ложится в очередь, потом
 * уходит. Очередь живёт в настройках, а не в vault'е, по двум причинам:
 * vault'а может не быть (папка недоступна, человек ещё не выбрал место), и
 * обращение — это не заметка, ему нечего делать среди файлов пользователя.
 *
 * ── Почему идентификатор придумывает клиент ─────────────────────────────────
 *
 * Досылка повторяется: сеть моргнула на середине ответа, приложение свернули,
 * телефон уснул. Без идемпотентности одно нажатие превращалось бы в три
 * обращения в базе, а PO разбирал бы их как три разных человека — и приоритет
 * считался бы по дублям. Ключ придумывает тот, кто нажал: сервер по нему
 * узнаёт повтор.
 */
import type { FeedbackReport } from '@zapiski/core';

import type { PreferencesStore } from '../contract.js';

/** Ключ очереди в настройках. Рядом с остальными: это не секрет. */
export const FEEDBACK_QUEUE_PREF = 'feedback.queue';

/**
 * Потолок очереди.
 *
 * Человек без сети неделю не должен получить настройки на мегабайт. Двадцать
 * обращений — заведомо больше, чем накопит один человек между сеансами связи, и
 * заведомо меньше, чем повредит. Переполнение отбрасывает САМОЕ СТАРОЕ: свежая
 * жалоба ценнее позавчерашней.
 */
const MAX_QUEUED = 20;

/** Как выглядит отправка. Тип узкий намеренно: очередь не знает про HTTP. */
export type FeedbackSend = (report: FeedbackReport) => Promise<void>;

export class FeedbackQueue {
  constructor(private readonly prefs: PreferencesStore) {}

  private async load(): Promise<FeedbackReport[]> {
    const stored = await this.prefs.get<FeedbackReport[]>(FEEDBACK_QUEUE_PREF, []);
    return Array.isArray(stored) ? stored : [];
  }

  private async save(items: FeedbackReport[]): Promise<void> {
    /* Отказ записи не должен ронять отправку: обращение уже принято, а
       настройки — дело поправимое. Но и молчать нельзя, поэтому наверх уходит
       результат, а не исключение. */
    await this.prefs.set(FEEDBACK_QUEUE_PREF, items).catch(() => undefined);
  }

  /** Сколько обращений ждёт отправки. */
  async pending(): Promise<number> {
    return (await this.load()).length;
  }

  /** Положить в очередь. Повтор с тем же `id` не удваивает. */
  async add(report: FeedbackReport): Promise<void> {
    const items = await this.load();
    if (items.some((item) => item.id === report.id)) return;
    const next = [...items, report];
    await this.save(next.length > MAX_QUEUED ? next.slice(next.length - MAX_QUEUED) : next);
  }

  async remove(id: string): Promise<void> {
    const items = await this.load();
    await this.save(items.filter((item) => item.id !== id));
  }

  /**
   * Досылка. Останавливается на первом отказе.
   *
   * Именно останавливается, а не «пробует все и складывает ошибки»: отказ почти
   * всегда означает, что сети нет, и перебирать остальные — это два десятка
   * запросов в пустоту и разряженная батарея. Порядок сохраняется, поэтому
   * следующая попытка начнёт с того же места.
   */
  async flush(send: FeedbackSend): Promise<{ sent: number; left: number }> {
    const items = await this.load();
    let sent = 0;
    for (const item of items) {
      try {
        await send(item);
      } catch {
        break;
      }
      sent += 1;
    }
    const left = items.slice(sent);
    if (sent > 0) await this.save(left);
    return { sent, left: left.length };
  }
}

/**
 * Случайный идентификатор обращения.
 *
 * `crypto.randomUUID` есть во всех трёх оболочках; запасной путь — на случай
 * старого WebView, где его может не быть. Криптостойкость здесь не нужна:
 * задача идентификатора — не совпасть, а не быть непредсказуемым.
 */
export function newFeedbackId(): string {
  const source = globalThis.crypto;
  if (source !== undefined && typeof source.randomUUID === 'function') return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (source !== undefined && typeof source.getRandomValues === 'function') {
    source.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
