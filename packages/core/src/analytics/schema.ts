/**
 * Реестр событий аналитики (O-260817-05, `analytics/schema/events.yaml`).
 *
 * `charter/12_ANALYTICS.md §1`, правило 2: содержание не измеряется никогда.
 * `buildAnalyticsEvent` — это не «валидация формата», а редакционный барьер:
 * из входных `props` в событие попадают ТОЛЬКО ключи, объявленные здесь для
 * данного имени события, и только если их значение проходит проверку типа.
 * Всё остальное — включая случайно переданный текст заметки в неизвестном
 * поле — отбрасывается молча, а не логируется и не отправляется куда-либо.
 */

export const ANALYTICS_SCHEMA_VERSION = 1;

export const LENGTH_BUCKETS = ['xs', 's', 'm', 'l', 'xl'] as const;
export type LengthBucket = (typeof LENGTH_BUCKETS)[number];

/** Корзина длины вместо точного числа символов — намеренно грубая (см. шапку файла). */
export function lengthBucket(chars: number): LengthBucket {
  const n = Number.isFinite(chars) && chars > 0 ? chars : 0;
  if (n < 100) return 'xs';
  if (n < 500) return 's';
  if (n < 2000) return 'm';
  if (n < 5000) return 'l';
  return 'xl';
}

type PropSpec =
  | { type: 'number' }
  | { type: 'boolean' }
  | { type: 'enum'; values: readonly string[] };

export const ANALYTICS_EVENT_SCHEMA = {
  note_saved: {
    length_bucket: { type: 'enum', values: LENGTH_BUCKETS },
    encrypted: { type: 'boolean' },
  },
  note_searched: {
    query_length_bucket: { type: 'enum', values: LENGTH_BUCKETS },
    results_count: { type: 'number' },
  },
  sync_completed: {
    pushed: { type: 'number' },
    pulled: { type: 'number' },
    conflicts: { type: 'number' },
  },
  export_requested: {
    format: { type: 'enum', values: ['md', 'html', 'docx', 'pdf', 'zip'] },
    notes_count: { type: 'number' },
  },
} as const satisfies Record<string, Record<string, PropSpec>>;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENT_SCHEMA;

export interface AnalyticsEvent {
  event: AnalyticsEventName;
  ts: string;
  props: Record<string, number | boolean | string>;
  schemaVersion: number;
}

function matchesType(spec: PropSpec, value: unknown): boolean {
  if (spec.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (spec.type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string' && (spec.values as readonly string[]).includes(value);
}

/**
 * `null`, если `name` не входит в реестр — вызывающая сторона должна не
 * поставить событие в очередь, а не отправить его «как есть». Из `props`
 * остаются только объявленные для этого события ключи с подходящим типом;
 * лишние поля и поля с неподходящим типом отбрасываются без предупреждения.
 */
export function buildAnalyticsEvent(
  name: string,
  props: Record<string, unknown>,
  now: () => number = () => Date.now(),
): AnalyticsEvent | null {
  if (!Object.prototype.hasOwnProperty.call(ANALYTICS_EVENT_SCHEMA, name)) return null;
  const eventName = name as AnalyticsEventName;
  const spec = ANALYTICS_EVENT_SCHEMA[eventName];
  const safeProps: Record<string, number | boolean | string> = {};
  for (const [key, propSpec] of Object.entries(spec)) {
    const value = props[key];
    if (matchesType(propSpec as PropSpec, value)) safeProps[key] = value as number | boolean | string;
  }
  return {
    event: eventName,
    ts: new Date(now()).toISOString(),
    props: safeProps,
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
  };
}
