/**
 * Проводной контракт ZapiskiCloud.
 *
 * Источник правды по типам протокола — `packages/core/src/contract.ts`
 * (ADR-0003: «типы протокола объявлены один раз и импортируются и клиентом,
 * и сервером»). Здесь они объявлены структурно идентично, а совпадение
 * проверяется тестом `test/contract.conformance.test.ts`: он читает
 * `packages/core/src/contract.ts` и падает, если набор полей разошёлся.
 *
 * Почему не прямой импорт: `packages/core` принадлежит другой команде и на
 * момент написания не собирается как npm-пакет. Прямой импорт сделал бы сборку
 * сервера заложником чужого незавершённого дерева. Тест даёт ту же гарантию
 * «рассинхрон протокола ломает CI», не ломая сборку.
 */

/** Путь внутри vault'а, всегда с прямыми слэшами и без ведущего слэша. */
export type VaultPath = string;

/** Стабильный идентификатор заметки. */
export type NoteId = string;

/** Элемент манифеста синка. Совпадает с `RemoteEntry` из контракта ядра. */
export interface RemoteEntry {
  path: VaultPath;
  etag: string;
  mtime: number;
  size: number;
}

/**
 * Метаданные версии, как их отдаёт сервер.
 *
 * `VersionSnapshot` в контракте ядра содержит поле `body: string` — это
 * *расшифрованный* текст, который существует только на клиенте. Сервер держит
 * зашифрованные байты и отдаёт их отдельным эндпоинтом
 * `GET /api/v1/vault/versions/:noteId/:versionId`, поэтому здесь `body`
 * заменён на `size`/`etag`. Zero-knowledge (ТЗ §2.1.5): открытого текста у
 * сервера нет и быть не может.
 */
export interface RemoteVersionSnapshot {
  id: string;
  noteId: NoteId;
  takenAt: number;
  source: string;
  merged: boolean;
  size: number;
  etag: string;
}

/** Поля `VersionSnapshot`, которые сервер обязан отдавать без изменений. */
export type VersionSnapshotServerFields = Pick<
  RemoteVersionSnapshot,
  'id' | 'noteId' | 'takenAt' | 'source' | 'merged'
>;

// ─────────────────────────────────────────────────────────────────────────────
// Ответы API, специфичные для ZapiskiCloud
// ─────────────────────────────────────────────────────────────────────────────

export interface BlobWriteResult {
  path: VaultPath;
  etag: string;
  mtime: number;
  size: number;
}

export interface ManifestResponse {
  entries: RemoteEntry[];
  /** Занято/доступно байт — чтобы клиент показал состояние без второго запроса. */
  quota: QuotaStatus;
}

export interface QuotaStatus {
  usedBytes: number;
  limitBytes: number;
}

/** Один непрозрачный CRDT-апдейт. Сервер их не интерпретирует. */
export interface CrdtUpdateEnvelope {
  /** Курсор: монотонно растущий идентификатор. Передаётся обратно как `since`. */
  seq: number;
  noteId: NoteId;
  /** Бинарный Yjs-апдейт в base64. */
  update: string;
  createdAt: number;
}

/**
 * Событие мгновенного синка.
 *
 * ТЗ §6: наружу уходят только имена путей, etag и идентификаторы —
 * никакого содержимого. `origin` — устройство-источник, чтобы клиент не
 * реагировал на собственную же запись.
 */
export type LiveEvent =
  | { type: 'changed'; path: VaultPath; etag: string; mtime: number; origin?: string }
  | { type: 'removed'; path: VaultPath; origin?: string }
  | { type: 'crdt'; noteId: NoteId; seq: number; origin?: string };

export type LiveEventKind = LiveEvent['type'];

export type SubscriptionPlan = 'free' | 'trial' | 'monthly' | 'yearly';
export type SubscriptionStatus = 'none' | 'trial' | 'active' | 'grace' | 'expired';

export interface BillingStatus {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  /** Можно ли писать в облако прямо сейчас. Чтение доступно всегда. */
  canWrite: boolean;
  /** ISO-8601 либо null. */
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  trialEndsAt: string | null;
  autoRenew: boolean;
  quota: QuotaStatus;
  /** Сколько дней хранится история версий: 30 (пробный) / 365 (подписка). */
  versionRetentionDays: number;
  prices: {
    monthlyRub: number;
    yearlyMonthlyRub: number;
  };
}

export interface PublishedPageRef {
  slug: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
}

/** Формат, который понимает Tauri updater. */
export interface UpdateFeedResponse {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

/** Единый конверт ошибки. `message` — дословно из реестра BEHAVIOR §11. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
