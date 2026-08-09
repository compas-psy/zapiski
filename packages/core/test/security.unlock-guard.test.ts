/**
 * SEC-024. Счётчик неудачных попыток и задержка переживают перезапуск.
 *
 * BEHAVIOR §5.2: попытки 1–4 без задержки, после 5-й — 30 с, после 8-й —
 * 5 мин, счётчик сбрасывается при успехе, данные не удаляются никогда.
 * До правки счётчик жил только в памяти приложения, и перезапуск обнулял его:
 * вор устройства получал четыре попытки без задержки сколько угодно раз.
 *
 * Здесь проверяется сам механизм: сквозной сценарий «5 попыток → перезапуск →
 * задержка ещё действует» живёт в `packages/app/test/security.unlock-delay.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_UNLOCK_GUARD,
  parseUnlockGuard,
  UnlockGuard,
  unlockDelayMs,
  type UnlockGuardRecord,
} from '../src/index.js';

/** Управляемые часы: стенные переводятся, монотонные — только вперёд. */
function clocks(start = 1_700_000_000_000) {
  const state = { wall: start, mono: 0 };
  return {
    state,
    options: {
      now: () => state.wall,
      monotonic: () => state.mono,
    },
    /** Прошло время: идут обе стрелки. */
    pass(ms: number): void {
      state.wall += ms;
      state.mono += ms;
    },
    /** Перевод часов пользователем: монотонные не двигаются. */
    setWall(value: number): void {
      state.wall = value;
    },
  };
}

/** «Перезапуск»: запись остаётся, монотонные часы начинаются заново. */
function restart(record: UnlockGuardRecord, wall: number): { guard: UnlockGuard; clock: ReturnType<typeof clocks> } {
  const clock = clocks(wall);
  return { guard: UnlockGuard.restore(record, clock.options), clock };
}

describe('SEC-024: счётчик попыток внутри одного запуска', () => {
  it('попытки 1–4 без задержки, 5-я — 30 с, 8-я — 5 мин', () => {
    const clock = clocks();
    const guard = UnlockGuard.empty(clock.options);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      guard.registerFailure();
      expect(guard.delayLeftMs(), `попытка ${attempt}`).toBe(0);
    }
    guard.registerFailure();
    expect(guard.failedAttempts).toBe(5);
    expect(guard.delayLeftMs()).toBe(30_000);

    clock.pass(30_000);
    expect(guard.delayLeftMs()).toBe(0);

    for (let attempt = 6; attempt <= 8; attempt += 1) guard.registerFailure();
    expect(guard.delayLeftMs()).toBe(300_000);
  });

  it('успех сбрасывает счётчик (BEHAVIOR §5.2)', () => {
    const clock = clocks();
    const guard = UnlockGuard.empty(clock.options);
    for (let attempt = 0; attempt < 5; attempt += 1) guard.registerFailure();
    expect(guard.delayLeftMs()).toBe(30_000);

    const record = guard.reset();
    expect(record).toEqual(EMPTY_UNLOCK_GUARD);
    expect(guard.delayLeftMs()).toBe(0);
    expect(guard.failedAttempts).toBe(0);
  });
});

describe('SEC-024: перезапуск приложения', () => {
  it('задержка продолжает действовать, а не начинается заново', () => {
    const clock = clocks();
    const guard = UnlockGuard.empty(clock.options);
    for (let attempt = 0; attempt < 5; attempt += 1) guard.registerFailure();
    const stored = guard.record;

    /* Прошло 10 с, приложение сняли из списка задач и открыли снова. */
    clock.pass(10_000);
    const after = restart(stored, clock.state.wall);
    expect(after.guard.failedAttempts).toBe(5);
    expect(after.guard.delayLeftMs()).toBe(20_000);

    /* И задержка не удлинилась: 20 с — это остаток тех же 30 с. */
    after.clock.pass(20_000);
    expect(after.guard.delayLeftMs()).toBe(0);
  });

  it('счётчик переживает перезапуск даже когда задержка уже отстояна', () => {
    /* Иначе вор получал бы «ещё четыре бесплатные попытки» после каждого
       перезапуска — это и есть SEC-024. */
    const clock = clocks();
    const guard = UnlockGuard.empty(clock.options);
    for (let attempt = 0; attempt < 5; attempt += 1) guard.registerFailure();
    clock.pass(60_000);

    const after = restart(guard.record, clock.state.wall);
    expect(after.guard.delayLeftMs()).toBe(0);
    expect(after.guard.failedAttempts).toBe(5);

    /* Следующая неудача — уже шестая, то есть снова 30 с, а не «первая». */
    after.guard.registerFailure();
    expect(after.guard.failedAttempts).toBe(6);
    expect(after.guard.delayLeftMs()).toBe(unlockDelayMs(6));
  });

  it('мусор в настройках не роняет разблокировку и не даёт задержки', () => {
    for (const junk of [null, undefined, 42, 'нет', {}, { failedAttempts: -5 }, { failedAttempts: 'много' }]) {
      const guard = UnlockGuard.restore(junk);
      expect(guard.failedAttempts).toBe(0);
      expect(guard.delayLeftMs()).toBe(0);
    }
    expect(parseUnlockGuard({ failedAttempts: 5.7, lastFailureAt: -1, lockedUntil: 10 })).toEqual({
      failedAttempts: 5,
      lastFailureAt: 0,
      lockedUntil: 10,
    });
  });
});

describe('SEC-024: перевод часов устройства', () => {
  it('перевод назад не отменяет задержку, а взводит её заново', () => {
    const clock = clocks();
    const guard = UnlockGuard.empty(clock.options);
    for (let attempt = 0; attempt < 5; attempt += 1) guard.registerFailure();
    const stored = guard.record;

    /* Вор переводит часы на сутки назад и перезапускает приложение. */
    const after = restart(stored, clock.state.wall - 86_400_000);
    expect(after.guard.failedAttempts).toBe(5);
    expect(after.guard.delayLeftMs()).toBe(30_000);
  });

  it('перевод вперёд не сокращает задержку внутри запуска', () => {
    const clock = clocks();
    const guard = UnlockGuard.empty(clock.options);
    for (let attempt = 0; attempt < 8; attempt += 1) guard.registerFailure();
    expect(guard.delayLeftMs()).toBe(300_000);

    /* Стенные часы уехали на год вперёд, монотонные — нет. */
    clock.setWall(clock.state.wall + 365 * 86_400_000);
    expect(guard.delayLeftMs()).toBe(300_000);
  });

  it('запись из будущего не удлиняет задержку сверх обещанной', () => {
    /* Обратная сторона: подсунутый `lockedUntil` через год не должен
       превращать 30 с в год ожидания — BEHAVIOR §5.2 обещает 30 с. */
    const wall = 1_700_000_000_000;
    const after = restart(
      { failedAttempts: 5, lastFailureAt: wall - 1_000, lockedUntil: wall + 365 * 86_400_000 },
      wall,
    );
    expect(after.guard.delayLeftMs()).toBe(30_000);
  });
});
