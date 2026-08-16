/**
 * События формы обратной связи — и запрет, встроенный в код.
 *
 * ── Что здесь запрещено ─────────────────────────────────────────────────────
 *
 * Спецификация §5: «ни `text`, ни его хеш, ни длина в символах — только
 * корзина (`s`/`m`/`l`)». Хеш стоит рядом с текстом не для симметрии: по хешу
 * короткой фразы она восстанавливается перебором, а точная длина вместе с
 * типом обращения и минутой отправки опознаёт человека в бете на полсотни
 * участников.
 *
 * Запрет держится двумя способами сразу. Фабрика события физически не
 * принимает текст наружу — она берёт его, чтобы посчитать корзину, и не
 * кладёт никуда. А `assertNoFreeText` стоит на выходе в порт аналитики и
 * проверяет ГОТОВОЕ событие: событие можно собрать и литералом, минуя
 * фабрику, и запрет обязан пережить такой обход.
 *
 * ── Где эти события регистрируются ──────────────────────────────────────────
 *
 * Общий реестр разметки (`analytics/schema/events.yaml`) живёт в другом
 * репозитории. Здесь — форма событий и запрет; регистрация в реестре и приём
 * на стороне аналитики делаются там.
 */
import type { FeedbackEntry, FeedbackKind, FeedbackPlatform } from './report.js';

/** Корзина длины обращения. Точная длина наружу не уходит никогда. */
export type CharsBucket = 's' | 'm' | 'l';

/**
 * Границы корзин.
 *
 * До 120 символов — короткая реплика («не работает поиск»); до 500 — обычное
 * обращение; дальше — подробный разбор. Границы round-числами намеренно: они
 * должны быть понятны без документации и не должны выглядеть подогнанными под
 * конкретного человека.
 */
export function charsBucket(length: number): CharsBucket {
  if (length < 120) return 's';
  if (length < 500) return 'm';
  return 'l';
}

export interface FeedbackPromptedEvent {
  name: 'feedback_prompted';
  props: { trigger: FeedbackEntry };
}

export interface FeedbackOpenedEvent {
  name: 'feedback_opened';
  props: { entry: FeedbackEntry };
}

export interface FeedbackSubmittedEvent {
  name: 'feedback_submitted';
  props: {
    type: FeedbackKind;
    has_contact: boolean;
    /** Сколько пунктов диагностики человек оставил включёнными. */
    diagnostics_kept: number;
    has_screenshot: boolean;
    chars_bucket: CharsBucket;
    version: string;
    platform: FeedbackPlatform;
  };
}

export interface FeedbackCancelledEvent {
  name: 'feedback_cancelled';
  props: { step: 'type' | 'text' | 'contact' | 'diagnostics' | 'send' };
}

export type FeedbackEvent =
  | FeedbackPromptedEvent
  | FeedbackOpenedEvent
  | FeedbackSubmittedEvent
  | FeedbackCancelledEvent;

export interface FeedbackSubmittedInput {
  type: FeedbackKind;
  /** Берётся ТОЛЬКО ради корзины и никуда не кладётся. */
  text: string;
  hasContact: boolean;
  diagnosticsKept: number;
  hasScreenshot: boolean;
  version: string;
  platform: FeedbackPlatform;
}

export function feedbackSubmitted(input: FeedbackSubmittedInput): FeedbackSubmittedEvent {
  return {
    name: 'feedback_submitted',
    props: {
      type: input.type,
      has_contact: input.hasContact,
      diagnostics_kept: input.diagnosticsKept,
      has_screenshot: input.hasScreenshot,
      chars_bucket: charsBucket([...input.text].length),
      version: input.version,
      platform: input.platform,
    },
  };
}

export function feedbackPrompted(trigger: FeedbackEntry): FeedbackPromptedEvent {
  return { name: 'feedback_prompted', props: { trigger } };
}

export function feedbackOpened(entry: FeedbackEntry): FeedbackOpenedEvent {
  return { name: 'feedback_opened', props: { entry } };
}

export function feedbackCancelled(step: FeedbackCancelledEvent['props']['step']): FeedbackCancelledEvent {
  return { name: 'feedback_cancelled', props: { step } };
}

/**
 * Разрешённые ключи по каждому событию.
 *
 * Белый список, а не чёрный. Чёрный пришлось бы дополнять на каждое новое имя
 * («comment», «note», «details»), и однажды кто-то придумал бы имя, которого в
 * списке нет. Белый список ошибается в безопасную сторону: незнакомый ключ —
 * отказ, а не пропуск.
 */
const ALLOWED: Record<FeedbackEvent['name'], readonly string[]> = {
  feedback_prompted: ['trigger'],
  feedback_opened: ['entry'],
  feedback_submitted: [
    'type',
    'has_contact',
    'diagnostics_kept',
    'has_screenshot',
    'chars_bucket',
    'version',
    'platform',
  ],
  feedback_cancelled: ['step'],
};

/**
 * Сторож на выходе в аналитику: свободного текста здесь нет и не будет.
 *
 * Бросает, а не чистит. Молчаливая очистка означала бы, что событие с текстом
 * когда-то собрали и никто об этом не узнал; отказ виден сразу — в тесте, а не
 * в базе аналитики через месяц.
 */
export function assertNoFreeText(event: FeedbackEvent): void {
  const allowed = ALLOWED[event.name];
  if (allowed === undefined) {
    throw new Error(`неизвестное событие обратной связи: ${String(event.name)}`);
  }
  for (const key of Object.keys(event.props as Record<string, unknown>)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `в событии ${event.name} посторонний ключ «${key}»: свободный текст в аналитику не попадает`,
      );
    }
  }
}
