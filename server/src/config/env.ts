import { z } from 'zod';

/**
 * Конфигурация только из окружения. Секретов в коде нет (требование задачи и
 * ТЗ §6 «Безопасность»). Описание каждой переменной — в `server/.env.example`.
 */

const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : v === '1' || v.toLowerCase() === 'true'));

const int = (dflt: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : Number(v)))
    .pipe(z.number().int().finite());

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** ADR-0003 §2: порт 3100, порты 3000 (Дневник) и 25 (почта) не трогаются. */
  PORT: int(3100),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: int(10),

  /** Том с зашифрованными блобами. */
  BLOB_ROOT: z.string().default('/data/blobs'),

  /** HS256-секрет для access-JWT. Минимум 32 символа. */
  AUTH_SECRET: z.string().min(32),
  AUTH_ACCESS_TTL_SECONDS: int(15 * 60),
  AUTH_REFRESH_TTL_SECONDS: int(60 * 24 * 3600),
  /** TTL magic-токена. ТЗ §5.5 — 15 минут. */
  MAGIC_LINK_TTL_SECONDS: int(15 * 60),
  /** SCREENS §2: «Отправить снова» неактивна 60 с. */
  MAGIC_LINK_COOLDOWN_SECONDS: int(60),

  /** Публичная база API — из неё собирается ссылка в письме и адрес /p/:slug. */
  PUBLIC_BASE_URL: z.string().url().default('https://zapiski.cmpas.ru'),
  /** Куда перенаправить браузер после успешного входа. Пусто — отдать JSON. */
  AUTH_SUCCESS_REDIRECT: z.string().optional(),

  /** ADR-0003 §7: существующий postfix на хосте, новых почтовых сервисов нет. */
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: int(25),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** ALLOWED_SENDER_DOMAINS: cmpas.ru. */
  MAIL_FROM: z.string().default('ЗАПИСКИ <zapiski@cmpas.ru>'),

  YANDEX_CLIENT_ID: z.string().optional(),
  YANDEX_CLIENT_SECRET: z.string().optional(),
  YANDEX_REDIRECT_URI: z.string().optional(),

  /** Проверка подписи вебхука ЮKassa (HMAC-SHA256 по сырому телу). */
  YOOKASSA_WEBHOOK_SECRET: z.string().optional(),
  YOOKASSA_SHOP_ID: z.string().optional(),
  YOOKASSA_SECRET_KEY: z.string().optional(),
  /** Доп. слой: список сетей уведомлений ЮKassa, CIDR через запятую. */
  YOOKASSA_ALLOWED_CIDRS: z.string().optional(),

  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional(),
  GOOGLE_PLAY_SA_EMAIL: z.string().optional(),
  GOOGLE_PLAY_SA_PRIVATE_KEY: z.string().optional(),

  /** ТЗ §7: 10 ГБ на аккаунт. */
  QUOTA_BYTES: int(10 * GIB),
  /** Предел размера одного блоба. */
  MAX_BLOB_BYTES: int(64 * MIB),
  /** Предел размера одного CRDT-апдейта. */
  MAX_CRDT_BYTES: int(4 * MIB),
  /** Предел размера опубликованной страницы. */
  MAX_PUBLISHED_BYTES: int(2 * MIB),

  /** ТЗ §4.2: 30 дней истории для пробного периода. */
  VERSION_RETENTION_TRIAL_DAYS: int(30),
  /** ТЗ §4.2: 365 дней для подписки. */
  VERSION_RETENTION_PAID_DAYS: int(365),
  /** SCREENS §9: «Попробовать 14 дней». */
  TRIAL_DAYS: int(14),
  /** Льготный период после неудачного продления. */
  GRACE_DAYS: int(7),
  PRICE_MONTHLY_RUB: int(199),
  PRICE_YEARLY_MONTHLY_RUB: int(149),

  /** Фид автообновлений: JSON на диске. Формат — см. README. */
  UPDATES_MANIFEST_PATH: z.string().optional(),

  PUBLISH_ENABLED: bool(true),
  /** ТЗ §6: аналитика opt-in. Выключена, пока пользователь не согласился. */
  ANALYTICS_ENABLED: bool(false),

  /** Origin'ы веб-клиента через запятую. Пусто — CORS выключен. */
  CORS_ORIGINS: z.string().optional(),
  /** Доверять X-Forwarded-* (сервер за nginx). */
  TRUST_PROXY: bool(true),
});

export type Env = Omit<z.infer<typeof schema>, 'CORS_ORIGINS' | 'YOOKASSA_ALLOWED_CIDRS'> & {
  corsOrigins: string[];
  yookassaAllowedCidrs: string[];
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Конфигурация окружения не прошла проверку:\n${lines.join('\n')}`);
  }
  const { CORS_ORIGINS, YOOKASSA_ALLOWED_CIDRS, ...rest } = parsed.data;
  return {
    ...rest,
    corsOrigins: splitList(CORS_ORIGINS),
    yookassaAllowedCidrs: splitList(YOOKASSA_ALLOWED_CIDRS),
  };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
