/**
 * Когда приложению позволено предложить рассказать о проблеме.
 *
 * Правило целиком: показали — сутки тишины; отказались — неделя. Отказ сильнее
 * показа, потому что это ответ, а не пауза.
 *
 * Почему это отдельная чистая функция, а не три условия внутри экрана: «не
 * чаще раза в сутки» — обещание, которое иначе проверяется только наблюдением
 * за живым устройством в течение недели. Здесь оно проверяется за миллисекунду
 * (`packages/core/test/feedback.prompt.test.ts`).
 */

/** Сутки тишины после показа. */
export const PROMPT_QUIET_MS = 24 * 60 * 60 * 1000;

/** Неделя тишины после отказа. */
export const DISMISS_QUIET_MS = 7 * PROMPT_QUIET_MS;

export interface FeedbackPromptTimes {
  now: number;
  /** Когда полосу показывали в последний раз. */
  promptedAt?: number | null;
  /** Когда её закрыли крестиком. */
  dismissedAt?: number | null;
}

/**
 * Годная ли это метка времени.
 *
 * Метка из будущего — не выдумка: часы переводят руками, часовой пояс меняется
 * в перелёте, устройство подтягивает время после загрузки. Наивное сравнение
 * при такой метке молчит до тех пор, пока настоящее время её не догонит, —
 * то есть выключает приглашение на недели. Негодная метка не должна ни молчать,
 * ни ронять экран, поэтому она просто не учитывается.
 */
function usable(at: number | null | undefined, now: number): at is number {
  return typeof at === 'number' && Number.isFinite(at) && at > 0 && at <= now;
}

/** Можно ли сейчас предложить рассказать о проблеме. */
export function shouldOfferFeedback({ now, promptedAt, dismissedAt }: FeedbackPromptTimes): boolean {
  /* Отказ проверяется первым и живёт дольше: «нет» действует неделю независимо
     от того, показывали ли что-то после него. */
  if (usable(dismissedAt, now) && now - dismissedAt < DISMISS_QUIET_MS) return false;
  if (usable(promptedAt, now) && now - promptedAt < PROMPT_QUIET_MS) return false;
  return true;
}
