/**
 * Значки системных панелей видны при любой теме.
 *
 * Заказчик: «на системной панели в Андроид, которая сверху, из-за белого фона
 * приложения сливаются системные иконки… этот эффект должен сохраняться на
 * всех экранах приложения».
 *
 * «На всех экранах» здесь не список экранов, а способ: признак ставится ОКНУ и
 * следует за темой. Поэтому проверяется выбор по теме и то, что смена темы
 * доходит до моста ровно один раз.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ command: string; args: unknown }> = [];

vi.mock('../src/platform/ipc', () => ({
  COMMANDS: { systemBarIcons: 'system_bar_icons' },
  call: async (command: string, args: unknown) => {
    calls.push({ command, args });
    return undefined;
  },
}));

const { applyBarIcons, needsDarkIcons } = await import('../src/platform/system-bars');

beforeEach(() => {
  calls.length = 0;
});

describe('цвет значков по теме', () => {
  it('светлая тема — значки тёмные, иначе их не видно', () => {
    expect(needsDarkIcons('paper')).toBe(true);
  });

  it('тёмные темы оставляют светлые значки системы', () => {
    expect(needsDarkIcons('graphite')).toBe(false);
    expect(needsDarkIcons('ink')).toBe(false);
  });

  it('темы ещё нет — не выдумываем: остаётся системное умолчание', () => {
    expect(needsDarkIcons(null)).toBe(false);
    expect(needsDarkIcons(undefined)).toBe(false);
  });
});

describe('признак доходит до окна', () => {
  it('на старте ставится сразу, а не после первой смены темы', () => {
    expect(applyBarIcons('paper', null)).toBe(true);
    expect(calls).toEqual([{ command: 'system_bar_icons', args: { dark: true } }]);
  });

  it('переключение на тёмную возвращает светлые значки', () => {
    const applied = applyBarIcons('paper', null);
    applyBarIcons('graphite', applied);
    expect(calls.at(-1)).toEqual({ command: 'system_bar_icons', args: { dark: false } });
    expect(calls).toHaveLength(2);
  });

  it('перерисовка с той же темой моста не тревожит', () => {
    const applied = applyBarIcons('paper', null);
    applyBarIcons('paper', applied);
    expect(calls, 'тема не менялась, а мост дёрнули').toHaveLength(1);
  });

  it('«Чернила» и «Графит» между собой окно не тревожат', () => {
    let applied = applyBarIcons('graphite', null);
    applied = applyBarIcons('ink', applied);
    expect(calls).toHaveLength(1);
  });
});
