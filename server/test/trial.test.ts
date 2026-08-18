/**
 * Пробный период: одно правило, два рантайма.
 *
 * Клиент обещает срок словами при подключении облака, сервер ставит дату
 * окончания в подписке. Правило живёт в `packages/core/src/trial.ts`, а на
 * сервере — копия (он не зависит от `@zapiski/core`). Этот тест читает ОБА
 * файла и не даёт им разъехаться: разъедутся — человек увидит «30 дней», а
 * доступ кончится раньше, и объяснить это будет нечем.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TRIAL_DAYS_EARLY, TRIAL_DAYS_REGULAR, TRIAL_EARLY_UNTIL, trialDaysFor } from '../src/lib/trial.ts';

const CORE = readFileSync(
  fileURLToPath(new URL('../../packages/core/src/trial.ts', import.meta.url)),
  'utf8',
);

describe('правило пробного периода', () => {
  it('30 дней подключившим до 1 сентября 2026-го', () => {
    expect(trialDaysFor(Date.UTC(2026, 7, 31, 23, 59))).toBe(30);
  });

  it('14 дней начиная с самой границы', () => {
    /* «До 01.09.2026» читается как «включительно по 31 августа»: спорить с
       человеком о сутках — плохой способ сэкономить. */
    expect(trialDaysFor(TRIAL_EARLY_UNTIL)).toBe(14);
    expect(trialDaysFor(Date.UTC(2026, 8, 2))).toBe(14);
  });

  it('числа и граница совпадают с ядром', () => {
    expect(CORE).toContain(`TRIAL_DAYS_EARLY = ${TRIAL_DAYS_EARLY}`);
    expect(CORE).toContain(`TRIAL_DAYS_REGULAR = ${TRIAL_DAYS_REGULAR}`);
    expect(CORE, 'граница даты разъехалась с сервером').toContain('Date.UTC(2026, 8, 1)');
  });
});
