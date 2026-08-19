import type { Env } from './config/env.ts';
import type { Db } from './db/pool.ts';
import type { BlobStore } from './services/blobStore.ts';
import type { LiveBus } from './services/liveBus.ts';
import type { Mailer } from './services/mailer.ts';
import type { YandexOAuth } from './services/yandex.ts';
import type { RetentionPolicy } from './services/subscription.ts';

/**
 * Всё, что нужно хендлерам. Собирается один раз в `buildApp` и передаётся
 * явно — тесты подменяют мейлер, часы и проверяльщик Google Play, не трогая
 * ни глобальных переменных, ни сети.
 */
export interface AppContext {
  env: Env;
  db: Db;
  blobs: BlobStore;
  mailer: Mailer;
  live: LiveBus;
  /** null, если YANDEX_CLIENT_ID/SECRET не заданы — вход по почте работает. */
  yandex: YandexOAuth | null;
  /** null, если сервисный аккаунт Google Play не настроен. */
  retention: RetentionPolicy;
  /** Источник времени. Подменяется в тестах TTL и сроков подписки. */
  now: () => Date;
}

/** Кто пришёл. Заполняется прехендлером `requireAuth`. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  deviceId: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
    requireAuth: import('fastify').preHandlerHookHandler;
  }
  interface FastifyRequest {
    auth?: AuthContext;
    /**
     * Сырые байты JSON-тела. Нужны только вебхуку ЮKassa: подпись считается по
     * тому, что пришло, а не по повторной сериализации разобранного объекта.
     */
    rawBody?: Buffer;
  }
}
