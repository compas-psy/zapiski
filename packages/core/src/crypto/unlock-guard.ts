/**
 * Счётчик неудачных попыток пароля и задержка между ними (BEHAVIOR §5.2,
 * SEC-024).
 *
 * BEHAVIOR §5.2 обещает: попытки 1–4 без задержки, после 5-й — 30 с, после
 * 8-й — 5 мин, счётчик сбрасывается при успехе, **данные не удаляются
 * никогда**. Функция задержки (`unlockDelayMs`) это обещание держала, а вот
 * счётчик жил только в памяти: перезапуск приложения обнулял его, и вор
 * устройства (THREAT-MODEL §2.3) получал четыре попытки без задержки
 * бесконечно — достаточно было снять приложение из списка задач.
 *
 * Поэтому счётчик здесь отделён от состояния приложения: это отдельная
 * запись, которую вызывающий сохраняет **вне vault'а** (в настройках
 * приложения). Вне — потому что vault может лежать на съёмном носителе или
 * в чужой синкаемой папке: задержка обязана действовать и тогда, когда
 * носителя нет.
 *
 * ── Часы ────────────────────────────────────────────────────────────────────
 *
 * Абсолютное время («до какого момента ждать») пережить перезапуск может, но
 * им управляет пользователь: перевод часов назад отменил бы задержку. Поэтому
 * используются двое часов сразу:
 *
 *   • монотонные (`performance.now()`) — внутри одного запуска приложения их
 *     нельзя перевести, и они задают нижнюю границу оставшегося времени;
 *   • стенные (`Date.now()`) — единственные, что переживают перезапуск;
 *     хранится и момент последней неудачи, и конец задержки, а при
 *     подозрительном сдвиге назад задержка взводится заново от текущего
 *     момента.
 *
 * Сдвиг вперёд задержку не сокращает (мешают монотонные часы), сдвиг назад —
 * не удлиняет её сверх обещанных 30 с / 5 мин (оставшееся время ограничено
 * номиналом). Продлить задержку сверх обещанного значило бы наказать
 * пользователя, у которого часы просто синхронизировались с сетью.
 */
import { unlockDelayMs } from './provider.js';

/** То, что переживает перезапуск. Секретов здесь нет — только числа. */
export interface UnlockGuardRecord {
  /** Сколько раз подряд пароль не подошёл. Сбрасывается только успехом. */
  failedAttempts: number;
  /** Стенные часы: когда была последняя неудачная попытка. */
  lastFailureAt: number;
  /** Стенные часы: до какого момента ввод не принимается. `0` — принимается. */
  lockedUntil: number;
}

export const EMPTY_UNLOCK_GUARD: UnlockGuardRecord = Object.freeze({
  failedAttempts: 0,
  lastFailureAt: 0,
  lockedUntil: 0,
});

export interface UnlockGuardOptions {
  /** Стенные часы. Их переводят — на них одних полагаться нельзя. */
  now?: () => number;
  /** Монотонные часы: растут всегда, но обнуляются с процессом. */
  monotonic?: () => number;
}

function defaultMonotonic(): number {
  const clock = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof clock?.now === 'function' ? clock.now() : Date.now();
}

/** Разумный потолок счётчика: дальше 8-й попытки задержка всё равно не растёт. */
const MAX_ATTEMPTS = 1_000_000;

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Разбор того, что прочитано из настроек.
 *
 * Настройки — обычный JSON вне vault'а, то есть их можно поправить руками.
 * Поэтому запись не «доверяется», а приводится к смыслу: отрицательные и
 * дробные значения выправляются, мусор превращается в пустую запись. Тихо
 * потерять счётчик здесь нельзя — потеря счётчика и есть SEC-024, — но и
 * падать из-за испорченного файла настроек тоже нельзя.
 */
export function parseUnlockGuard(value: unknown): UnlockGuardRecord {
  if (typeof value !== 'object' || value === null) return { ...EMPTY_UNLOCK_GUARD };
  const source = value as Partial<Record<keyof UnlockGuardRecord, unknown>>;
  const attempts = Math.min(MAX_ATTEMPTS, Math.max(0, Math.floor(finite(source.failedAttempts))));
  return {
    failedAttempts: attempts,
    lastFailureAt: Math.max(0, finite(source.lastFailureAt)),
    lockedUntil: Math.max(0, finite(source.lockedUntil)),
  };
}

/**
 * Живой счётчик поверх сохранённой записи.
 *
 * Владелец экземпляра обязан после каждого изменения записать `record` в
 * настройки: именно эта запись и переживает перезапуск.
 */
export class UnlockGuard {
  private attempts: number;
  private lastFailureAt: number;
  private lockedUntil: number;
  /** Конец задержки по монотонным часам. Живёт только внутри запуска. */
  private monotonicDeadline: number;
  private readonly now: () => number;
  private readonly monotonic: () => number;

  private constructor(record: UnlockGuardRecord, options: UnlockGuardOptions) {
    this.now = options.now ?? (() => Date.now());
    this.monotonic = options.monotonic ?? defaultMonotonic;
    this.attempts = record.failedAttempts;
    this.lastFailureAt = record.lastFailureAt;
    this.lockedUntil = record.lockedUntil;
    this.monotonicDeadline = this.monotonic() + Math.max(0, record.lockedUntil - this.now());
  }

  /** Пустой счётчик — попыток не было. */
  static empty(options: UnlockGuardOptions = {}): UnlockGuard {
    return new UnlockGuard({ ...EMPTY_UNLOCK_GUARD }, options);
  }

  /**
   * Восстановление при старте приложения.
   *
   * Здесь же обрабатывается перевод часов назад: если «последняя неудача» по
   * записи ещё не наступила, значит часы сдвинули (или файл настроек
   * подправили). Верить такой записи нельзя, а обнулять счётчик — ровно то,
   * чего добивается противник. Поэтому счётчик сохраняется, а задержка
   * взводится заново от текущего момента: обход стоит столько же, сколько
   * честное ожидание.
   */
  static restore(stored: unknown, options: UnlockGuardOptions = {}): UnlockGuard {
    const guard = new UnlockGuard(parseUnlockGuard(stored), options);
    const now = guard.now();
    const full = unlockDelayMs(guard.attempts);

    if (full === 0) {
      /* Задержки на этом счётчике нет — но сам счётчик остаётся: иначе
         перезапуск снова дарил бы четыре попытки без ожидания. */
      guard.lockedUntil = 0;
      guard.lastFailureAt = Math.min(guard.lastFailureAt, now);
    } else if (guard.lastFailureAt > now || guard.lockedUntil - now > full) {
      /* Часы ушли назад: ждём полную задержку от текущего момента. */
      guard.lastFailureAt = now;
      guard.lockedUntil = now + full;
    } else if (guard.lockedUntil <= now) {
      /* Задержка отстояна честно — счётчик при этом никуда не девается. */
      guard.lockedUntil = 0;
    }

    guard.monotonicDeadline = guard.monotonic() + Math.max(0, guard.lockedUntil - now);
    return guard;
  }

  /** Запись для настроек. Копия: наружу отдаётся значение, а не ссылка. */
  get record(): UnlockGuardRecord {
    return {
      failedAttempts: this.attempts,
      lastFailureAt: this.lastFailureAt,
      lockedUntil: this.lockedUntil,
    };
  }

  get failedAttempts(): number {
    return this.attempts;
  }

  /**
   * Сколько осталось ждать. `0` — ввод принимается.
   *
   * Берётся большее из двух остатков: по монотонным часам (их не перевести
   * внутри запуска) и по стенным, ограниченным номиналом задержки.
   */
  delayLeftMs(): number {
    const full = unlockDelayMs(this.attempts);
    if (full === 0) return 0;
    const byWallClock = Math.min(full, Math.max(0, this.lockedUntil - this.now()));
    const byMonotonic = Math.max(0, this.monotonicDeadline - this.monotonic());
    return Math.max(byWallClock, byMonotonic);
  }

  /** Пароль не подошёл. Возвращает запись, которую нужно сохранить. */
  registerFailure(): UnlockGuardRecord {
    const now = this.now();
    this.attempts = Math.min(MAX_ATTEMPTS, this.attempts + 1);
    const delay = unlockDelayMs(this.attempts);
    this.lastFailureAt = now;
    this.lockedUntil = delay > 0 ? now + delay : 0;
    this.monotonicDeadline = this.monotonic() + delay;
    return this.record;
  }

  /** Успешная разблокировка: счётчик сбрасывается (BEHAVIOR §5.2). */
  reset(): UnlockGuardRecord {
    this.attempts = 0;
    this.lastFailureAt = 0;
    this.lockedUntil = 0;
    this.monotonicDeadline = this.monotonic();
    return this.record;
  }
}
