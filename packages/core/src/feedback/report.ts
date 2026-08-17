/**
 * Обращение из беты: что именно уезжает на сервер.
 *
 * ── Правило, из которого всё следует ────────────────────────────────────────
 *
 * В заметках ЗАПИСОК лежит то, что психолог говорит о клиентах. Значит из
 * формы не может уйти ни строчки содержимого: ни текста, ни заголовка, ни
 * пути, ни имени папки. Это не пожелание к аккуратности — это граница
 * продукта, и держит её тип, а не память разработчика.
 *
 * Отсюда устройство модуля. Тело запроса собирается ОДНОЙ функцией из полей,
 * каждое из которых либо перечислимо (тип обращения, платформа, корзина), либо
 * число, либо текст, который человек написал сам. Ни одно поле не принимает
 * «что-нибудь про хранилище»: нет ни путей, ни имён, ни счётчиков в штуках —
 * только корзины. Сторож `packages/core/test/feedback.report.test.ts` ищет в
 * готовом теле каждую строку настоящего хранилища и падает, если нашёл.
 *
 * ── Почему размер хранилища корзиной ────────────────────────────────────────
 *
 * «412 заметок» — это почти идентификатор: в бете на полсотни человек такое
 * число опознаёт конкретного. Корзина отвечает на вопрос «много ли у него
 * заметок», ради которого поле и заводилось, и не отвечает на вопрос «кто он».
 */
import type { Locale } from '../i18n/i18n.js';

/** Тип обращения — четыре варианта, не десять (спецификация §3). */
export type FeedbackKind = 'broken' | 'awkward' | 'want-feature' | 'other';

/** Откуда пришли в форму. Нужно, чтобы понять, какая точка входа работает. */
export type FeedbackEntry = 'menu' | 'error' | 'sync_conflict' | 'slow_op';

/** Размер хранилища корзиной. Точное число — почти идентификатор. */
export type NotesBucket = '<100' | '100-500' | '500+';

/** Платформа — та же тройка, что у `PlatformCapabilities.kind`. */
export type FeedbackPlatform = 'web' | 'windows' | 'android';

/**
 * Что показывается в блоке «Что будет отправлено» и что уезжает.
 *
 * Каждый пункт человек может отключить, и отключённый исчезает из тела
 * целиком, а не превращается в `null`: пустое поле рядом с заполненными — тоже
 * сообщение о том, что от нас что-то скрыли.
 */
export interface FeedbackDiagnostics {
  version: string;
  platform: FeedbackPlatform;
  locale: Locale;
  notes: NotesBucket;
  encryption: boolean;
  /** Коды, не тексты: `SYNC_CONFLICT`, а не «Не удалось синхронизировать». */
  errorCodes: string[];
  daysSinceInstall: number;
}

/** Согласие по каждому пункту. Умолчание — включено, кроме скриншота. */
export type DiagnosticsConsent = Partial<Record<keyof FeedbackDiagnostics, boolean>>;

/**
 * Обстоятельства, при которых форму открыли из контекста.
 *
 * Все поля перечислимы или числовые. Строк здесь нет и быть не может: любое
 * свободное поле — это дверь, через которую однажды заедет путь к файлу.
 */
export interface FeedbackContext {
  /** Код ошибки до сбоя. Проверяется так же, как коды в диагностике. */
  errorCode?: string;
  /** Что человек делал: перечислимое действие, а не его описание. */
  lastAction?: 'search' | 'sync' | 'import' | 'export' | 'edit' | 'open' | 'attach';
  /** Тип конфликта синхронизации. */
  conflict?: 'merged' | 'both-kept' | 'encrypted';
  /** Сколько устройств участвовало в конфликте. */
  devices?: number;
  /** Длительность долгой операции, мс. */
  durationMs?: number;
}

export interface FeedbackDraft {
  kind: FeedbackKind;
  /** Свободный текст. Единственное место продукта, где мы его принимаем. */
  text: string;
  /** Необязательный контакт для ответа. Пусто по умолчанию. */
  contact?: string;
  /**
   * Скриншот в base64. По умолчанию его НЕТ: прикладывается только явным
   * действием и только после предупреждения о том, что на снимке могут быть
   * видны заметки (спецификация §1).
   */
  screenshot?: string;
  entry: FeedbackEntry;
  context?: FeedbackContext;
}

/** Тело `POST /feedback`. */
export interface FeedbackReport {
  /** Идемпотентность: повтор с тем же `id` не заводит второе обращение. */
  id: string;
  createdAt: number;
  kind: FeedbackKind;
  text: string;
  contact?: string;
  entry: FeedbackEntry;
  context?: FeedbackContext;
  diagnostics?: Partial<FeedbackDiagnostics>;
  screenshot?: string;
}

export interface BuildFeedbackReportInput {
  id: string;
  createdAt: number;
  draft: FeedbackDraft;
  diagnostics: FeedbackDiagnostics;
  consent?: DiagnosticsConsent;
}

/**
 * Код ошибки — это КОД.
 *
 * Заглавные латинские буквы, цифры и подчёркивание, от трёх до сорока
 * символов. Всё, что не подошло, отбрасывается ЦЕЛИКОМ, а не очищается:
 * очистка `read /vault/Личное/Дневник.md` оставила бы обрывок пути, то есть
 * ровно то, ради чего проверка и заводилась.
 */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,39}$/;

export function isErrorCode(value: string): boolean {
  return ERROR_CODE.test(value);
}

/** Порядок пунктов диагностики — он же порядок в блоке «Что будет отправлено». */
const DIAGNOSTIC_KEYS = [
  'version',
  'platform',
  'locale',
  'notes',
  'encryption',
  'errorCodes',
  'daysSinceInstall',
] as const;

/** Заметок в хранилище → корзина. Точное число наружу не уходит никогда. */
export function notesBucket(count: number): NotesBucket {
  if (count < 100) return '<100';
  if (count < 500) return '100-500';
  return '500+';
}

/**
 * Собрать тело обращения.
 *
 * Единственная дорога наружу: всё, что уезжает на сервер, проходит здесь.
 * Поэтому и сторож утечки проверяет именно её результат — не «поля, о которых
 * мы вспомнили», а всё тело целиком.
 */
export function buildFeedbackReport(input: BuildFeedbackReportInput): FeedbackReport {
  const { id, createdAt, draft, diagnostics, consent } = input;

  const kept: Partial<FeedbackDiagnostics> = {};
  for (const key of DIAGNOSTIC_KEYS) {
    if (consent?.[key] === false) continue;
    if (key === 'errorCodes') {
      /* Отбор, а не очистка: код, не похожий на код, выбрасывается целиком. */
      const codes = diagnostics.errorCodes.filter(isErrorCode);
      if (codes.length > 0) kept.errorCodes = codes;
      continue;
    }
    /* Присваивание по одному ключу вместо spread: так TypeScript проверяет
       соответствие типов, а не соглашается на `any`. */
    Object.assign(kept, { [key]: diagnostics[key] });
  }

  const contact = draft.contact?.trim();
  const context = sanitizeContext(draft.context);

  const report: FeedbackReport = {
    id,
    createdAt,
    kind: draft.kind,
    text: draft.text,
    entry: draft.entry,
  };
  /* Условные поля добавляются, а не проставляются в `undefined`: пустое поле в
     JSON — это тоже утверждение, и лишних утверждений мы не делаем. */
  if (contact !== undefined && contact !== '') report.contact = contact;
  if (context !== undefined) report.context = context;
  if (Object.keys(kept).length > 0) report.diagnostics = kept;
  if (draft.screenshot !== undefined && draft.screenshot !== '') {
    report.screenshot = draft.screenshot;
  }
  return report;
}

/** Контекст пропускается по одному полю: чужому здесь взяться неоткуда. */
function sanitizeContext(context?: FeedbackContext): FeedbackContext | undefined {
  if (!context) return undefined;
  const out: FeedbackContext = {};
  if (context.errorCode !== undefined && isErrorCode(context.errorCode)) {
    out.errorCode = context.errorCode;
  }
  if (context.lastAction !== undefined) out.lastAction = context.lastAction;
  if (context.conflict !== undefined) out.conflict = context.conflict;
  if (typeof context.devices === 'number' && Number.isFinite(context.devices)) {
    out.devices = Math.max(0, Math.round(context.devices));
  }
  if (typeof context.durationMs === 'number' && Number.isFinite(context.durationMs)) {
    out.durationMs = Math.max(0, Math.round(context.durationMs));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
