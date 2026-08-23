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
  /**
   * То же для приложений — Windows и Android: возврат идёт по собственной
   * схеме (`zapiski://auth/callback`). Пусто — используется
   * AUTH_SUCCESS_REDIRECT.
   *
   * Почему приложениям нужна своя схема, а не https. Https-адрес отдаёт
   * человека БРАУЗЕРУ: на Windows приложение перехватить его не может вовсе, а
   * на Android перехват (App Links) работает только после подтверждения
   * владения доменом — файлом `assetlinks.json` с отпечатком ключа, которым
   * подписан установленный APK. Пока такого файла нет, Chrome честно
   * показывает сайт, и человек остаётся в браузере с сессией, которая нужна
   * приложению. Ровно это и увидел заказчик: «переадресует на сайт и не
   * возвращается в приложение».
   *
   * Своя схема ни от чего внешнего не зависит — так вход в родных
   * приложениях и полагается замыкать (RFC 8252).
   */
  AUTH_SUCCESS_REDIRECT_APP: z.string().optional(),
  /**
   * Прежнее имя той же настройки, когда своя схема была только у Windows.
   * Читается, если новое не задано: сервер с прежним окружением обязан
   * продолжать работать.
   */
  AUTH_SUCCESS_REDIRECT_DESKTOP: z.string().optional(),

  /**
   * Токен ночного цикла для `GET /api/v1/feedback`.
   *
   * Не задан — ручка не пускает НИКОГО. Забытая настройка не имеет права
   * превращаться в открытую дверь: за ней лежат тексты живых людей.
   */
  FEEDBACK_SERVICE_TOKEN: z.string().min(24).optional(),

  /** ADR-0003 §7: существующий postfix на хосте, новых почтовых сервисов нет. */
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: int(25),
  SMTP_SECURE: bool(false),
  /**
   * Релей на этой же машине, личность подтвердить нечем: STARTTLS остаётся,
   * но сертификат не проверяется. Подробности и обоснование — в
   * `SmtpOptions.localRelayWithoutCertificate`. Умолчание `false`: для
   * внешнего релея проверка обязана оставаться строгой.
   */
  SMTP_LOCAL_RELAY: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** ALLOWED_SENDER_DOMAINS: cmpas.ru. */
  MAIL_FROM: z.string().default('ЗАПИСКИ <zapiski@cmpas.ru>'),

  YANDEX_CLIENT_ID: z.string().optional(),
  YANDEX_CLIENT_SECRET: z.string().optional(),
  YANDEX_REDIRECT_URI: z.string().optional(),


  /** ТЗ §7: 10 ГБ на аккаунт. */
  QUOTA_BYTES: int(10 * GIB),
  /** Предел размера одного блоба. */
  MAX_BLOB_BYTES: int(64 * MIB),
  /** Предел размера одного CRDT-апдейта. */
  MAX_CRDT_BYTES: int(4 * MIB),
  /** Предел размера опубликованной страницы. */
  MAX_PUBLISHED_BYTES: int(2 * MIB),

  /**
   * Оплата включена? На MVP — НЕТ, и это решение заказчика, а не заглушка.
   *
   * ── Что означает «выключена» ────────────────────────────────────────────
   *
   * Право на запись в облако есть у каждого, кто вошёл. Ничего не истекает,
   * ничего не надо начинать, экраны тарифов спрятаны. Код подписки, таблицы,
   * вебхуки и проверки остаются на месте — включается одной переменной.
   *
   * ── Почему выключатель на сервере, а не в приложении ────────────────────
   *
   * Право на запись выдаёт сервер: спрятать paywall в интерфейсе мало —
   * запись всё равно получила бы 402, и человек увидел бы «синхронизация
   * приостановлена» на пустом месте. Ровно это и случилось: у нового
   * пользователя подписки нет по определению, первый же аплоад упирался в
   * 402, и приложение называло это «Подписка закончилась» — сообщение о
   * конце того, что не начиналось.
   *
   * ── Почему по умолчанию выключено ───────────────────────────────────────
   *
   * Умолчание описывает сегодняшний продукт: он бесплатный. Включение оплаты
   * — сознательный шаг (переменная здесь + `BILLING_ENABLED` в
   * `@zapiski/core` для интерфейса), а не то, что случается само при
   * разворачивании на новом сервере.
   */
  BILLING_ENABLED: bool(false),

  /** ТЗ §4.2: 30 дней истории для пробного периода. */
  VERSION_RETENTION_TRIAL_DAYS: int(30),
  /** ТЗ §4.2: 365 дней для подписки. */
  VERSION_RETENTION_PAID_DAYS: int(365),
  /** SCREENS §9: «Попробовать 14 дней». */
  TRIAL_DAYS: int(14),
  /** Льготный период после неудачного продления. */
  GRACE_DAYS: int(7),
  PRICE_MONTHLY_RUB: int(299),
  PRICE_YEARLY_MONTHLY_RUB: int(224),

  /*
   * Т-Банк (эквайринг). Имена переменных повторяют имена секретов, которые
   * заказчик завёл в репозитории (`TINKOFF_*`): расхождение здесь стоило бы
   * молчаливого «оплата недоступна» при полностью настроенном терминале.
   *
   * Пусто — приём оплаты через Т-Банк просто не предлагается; это не отказ, а
   * отсутствие настройки, и путь через ЮKassa при этом не затрагивается.
   */
  TINKOFF_TERMINAL_KEY: z.string().optional(),
  TINKOFF_PASSWORD: z.string().optional(),
  /** Адрес API. Отдельной переменной — ради тестового терминала банка. */
  TINKOFF_API_BASE: z.string().default('https://securepay.tinkoff.ru/v2'),
  /*
   * Чек по 54-ФЗ. Это свойства ПРОДАВЦА, а не кода: система налогообложения и
   * ставка НДС берутся из личного кабинета и меняются без правки программы.
   * Умолчания — УСН «доходы» и «без НДС»: самое частое сочетание для ИП и
   * малых ООО. Ошибка видна сразу — банк отвергает `Init` с описанием причины.
   */
  TINKOFF_TAXATION: z.string().default('usn_income'),
  TINKOFF_VAT: z.string().default('none'),

  /** Фид автообновлений: JSON на диске. Формат — см. README. */
  UPDATES_MANIFEST_PATH: z.string().optional(),

  PUBLISH_ENABLED: bool(true),
  /** ТЗ §6: аналитика opt-in. Выключена, пока пользователь не согласился. */
  ANALYTICS_ENABLED: bool(false),

  /**
   * Origin'ы клиентов через запятую. Пусто — CORS выключен.
   *
   * Клиентов не один: кроме сайта в список обязаны входить окна приложений.
   * Tauri выдаёт им собственный origin — `http://tauri.localhost` на Windows
   * и Android, `tauri://localhost` на macOS и iOS, — и без него движок
   * отбивает каждый запрос ещё до сервера. Дефект при этом выглядит как
   * поломка синхронизации: вход проходит (токен приезжает диплинком, минуя
   * сеть), а обмен с облаком молча падает.
   */
  CORS_ORIGINS: z.string().optional(),
  /**
   * Кому верить в X-Forwarded-For. Значение по умолчанию — `1`: один прокси
   * (nginx), и адрес клиента берётся на один переход левее конца цепочки.
   *
   * `true` здесь было бы дырой: Fastify взял бы самый левый элемент, а его
   * пишет сам клиент. Тогда любой, кто дотянется до порта приложения, может
   * назваться каким угодно адресом — и обойти всё, что смотрит на `request.ip`.
   */
  TRUST_PROXY: z.string().optional(),

  /**
   * Мост в приёмник ПРАКТИКИ (`POST /ingest`, `charter/12_ANALYTICS.md §3`,
   * C4) — пересылка событий, принятых `/api/v1/analytics/events`, в общий
   * контур. Оба значения обязаны быть заданы ВМЕСТЕ: адрес без секрета
   * означал бы слепую отправку без аутентификации (устав §6.1, «сервис не
   * придумывает себе право появиться в проде тихо»); секрет без адреса
   * послать некуда. Пусто — мост выключен, событие остаётся только у
   * ЗАПИСОК; это не отказ, а отсутствие настройки, и `index.ts` пишет об
   * этом в лог при старте явно, а не молчит (тот же приём, что для
   * YANDEX_CLIENT_ID/SECRET).
   *
   * Секрет шлётся заголовком на КАЖДЫЙ пересылаемый запрос. На день написания
   * этого моста сам `/ingest` ПРАКТИКИ его не проверяет (прочитан код
   * `src/app/api/ingest/route.ts` в `/tmp/work/cmpas.ru` — там нет проверки
   * заголовка вовсе, см. коммит) — заголовок форвард-совместим на будущее,
   * а не защита сегодня. Это ограничение стороны ПРАКТИКИ, не этого репозитория.
   */
  PRACTICE_INGEST_URL: z.string().url().optional(),
  PRACTICE_INGEST_SECRET: z.string().min(1).optional(),
});

export type TrustProxySetting = boolean | number | string[];

export type Env = Omit<z.infer<typeof schema>, 'CORS_ORIGINS' | 'TRUST_PROXY'> & {
  corsOrigins: string[];
  trustProxy: TrustProxySetting;
};

/**
 * `false` / `0` — не верить заголовку вовсе;
 * целое N — доверять N ближайшим прокси;
 * список IP/CIDR — доверять только этим адресам;
 * `true` — доверять всей цепочке (только для отладки, в проде не ставить).
 */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  if (raw === undefined || raw.trim().length === 0) return 1;
  const value = raw.trim();
  if (value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return splitList(value);
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Конфигурация окружения не прошла проверку:\n${lines.join('\n')}`);
  }
  const { CORS_ORIGINS, TRUST_PROXY, ...rest } = parsed.data;
  return {
    ...rest,
    corsOrigins: splitList(CORS_ORIGINS),
    trustProxy: parseTrustProxy(TRUST_PROXY),
  };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
