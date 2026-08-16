import type { ApiErrorBody } from '../protocol.ts';
import { PENDING_REGISTRY, REGISTRY } from './messages.ts';

/**
 * Ошибка API: HTTP-статус + машиночитаемый код + текст для пользователя.
 *
 * Текст всегда берётся из `messages.ts`; собирать строки на месте запрещено —
 * иначе реестр BEHAVIOR §11 перестаёт быть источником правды.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** Заголовки, которые обязан нести ответ (например, Retry-After). */
  readonly headers: Record<string, string>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message } };
  }
}

export const errors = {
  badRequest: (detailCode = 'bad_request'): ApiError =>
    new ApiError(400, detailCode, PENDING_REGISTRY.badRequest),

  authRequired: (): ApiError => new ApiError(401, 'auth_required', PENDING_REGISTRY.authRequired),

  sessionExpired: (): ApiError =>
    new ApiError(401, 'session_expired', PENDING_REGISTRY.sessionExpired),

  notFound: (code = 'not_found'): ApiError => new ApiError(404, code, PENDING_REGISTRY.notFound),

  /** BEHAVIOR §11: «Ссылка больше не действует. Прислать новую?» */
  magicLinkDead: (code: 'magic_link_expired' | 'magic_link_used' | 'magic_link_device_mismatch') =>
    new ApiError(410, code, REGISTRY.magicLinkExpired),

  /** BEHAVIOR §11: «Попробуйте через 30 секунд» */
  tooManyAttempts: (retryAfterSeconds: number): ApiError =>
    new ApiError(429, 'too_many_attempts', REGISTRY.tooManyAttempts, {
      'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))),
    }),

  /**
   * ТЗ §5.5: истёкшая подписка не блокирует данные — запрещается только запись.
   * BEHAVIOR §11: «Подписка закончилась. Заметки на месте, синхронизация
   * через облако КОМПАС приостановлена».
   */
  subscriptionExpired: (): ApiError =>
    new ApiError(402, 'subscription_expired', REGISTRY.subscriptionExpired),

  /**
   * Подписки не было ни разу. Тот же код 402 — платить действительно надо, —
   * но другой `code` и другой текст: «закончилась» про то, чего не начинали,
   * это сообщение о несуществующем событии. Клиент выбирает текст по `code`,
   * а не по номеру ответа.
   */
  subscriptionRequired: (): ApiError =>
    new ApiError(402, 'subscription_required', PENDING_REGISTRY.subscriptionRequired),

  /**
   * Письмо не удалось отправить.
   *
   * Отдельный код, а не общий отказ, и вот почему. Ручка `/auth/magic-link`
   * делает две разные вещи: заводит токен в базе и отдаёт письмо релею. Когда
   * падало второе, наружу уходил безымянный отказ, клиент показывал текст про
   * СИНХРОНИЗАЦИЮ, и человек искал проблему где угодно, кроме почты. Заодно
   * этого не видел и владелец продукта: «вход по почте не работает» — всё, что
   * можно было сказать.
   *
   * Код 502: наша часть отработала, не ответил чужой релей. Вход при этом не
   * сломан — Яндекс ID рядом и работает.
   */
  mailFailed: (): ApiError =>
    new ApiError(502, 'mail_failed', PENDING_REGISTRY.mailFailed),

  /** Оплата в этой сборке не подключена: платить не за что, всё открыто. */
  billingDisabled: (): ApiError =>
    new ApiError(404, 'billing_disabled', PENDING_REGISTRY.billingDisabled),

  etagMismatch: (): ApiError => new ApiError(412, 'etag_mismatch', PENDING_REGISTRY.etagMismatch),

  blobTooLarge: (): ApiError => new ApiError(413, 'blob_too_large', PENDING_REGISTRY.blobTooLarge),

  quotaExceeded: (): ApiError => new ApiError(507, 'quota_exceeded', PENDING_REGISTRY.quotaExceeded),

  billingUnavailable: (): ApiError =>
    new ApiError(503, 'billing_unavailable', PENDING_REGISTRY.billingUnavailable),

  publishDisabled: (): ApiError =>
    new ApiError(503, 'publish_disabled', PENDING_REGISTRY.publishDisabled),

  internal: (): ApiError => new ApiError(500, 'internal', PENDING_REGISTRY.internal),
};
