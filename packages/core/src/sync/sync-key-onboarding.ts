/**
 * SEC-001 §4 — подключение устройства к зашифрованному синку.
 *
 * Здесь нет UI и нет платформенного кода: сеть приходит инъекцией `fetch`,
 * защищённое хранилище — портом `BiometricProvider` (`contract.ts`), который
 * уже используется для материала пароля vault'а. Новый идентификатор ключа —
 * `sync`, рядом с существующим `vault`.
 *
 * ── Три состояния, а не два ──────────────────────────────────────────────
 *
 *   `none`        — у аккаунта ещё нет SMK: это первое устройство вообще.
 *                   Предлагаем создать ключ и ПОКАЗАТЬ код восстановления.
 *   `needs-code`  — SMK у аккаунта есть, на этом устройстве его нет.
 *                   Нужен код восстановления — один раз на устройство, не
 *                   на каждый вход.
 *   `ready`       — SMK развёрнут и лежит в защищённом хранилище платформы.
 *
 * Различать `none` и `needs-code` обязательно: предложить «создайте ключ»
 * тому, у кого ключ уже есть, значит предложить операцию, которая сделала
 * бы нечитаемым всё уже зашифрованное. Сервер такую подмену отбивает (409),
 * но человек не должен видеть кнопку, которая ведёт в тупик.
 *
 * ── Чего здесь сознательно нет ───────────────────────────────────────────
 *
 * Пароля восстановления как второго пути (design §3, §6.1) — по требованию
 * «выбери один понятный механизм и реализуй его полностью». Ротации SMK
 * (design §2.3, §11) — фаза 2. Обе вещи конструкция допускает добавить
 * позже, ничего здесь не переписывая.
 */
import type { BiometricProvider } from '../contract.js';
import {
  generateRecoveryCode,
  generateSmk,
  parseRecoveryCode,
  unwrapSmk,
  wrapSmk,
  type RecoveryCode,
} from '../crypto/sync-keys.js';
import { fromBase64, randomBytes, toBase64, utf8, fromUtf8 } from '../util/bytes.js';
import { SyncCrypto } from './sync-crypto.js';
import type { FetchLike } from './webdav.js';

/** Идентификатор ключа в платформенном хранилище. Рядом с `vault`. */
export const SYNC_KEY_STORAGE_ID = 'sync';

/** Что кладётся в проверочный конверт. Содержимого заметок в нём нет. */
const CHECK_PLAINTEXT = 'zapiski/sync/v1/check';

export interface SyncKeyRecord {
  enrolled: boolean;
  wrappedSmk?: string;
  accountSalt?: string;
  checkBlob?: string;
  keyVersion?: number;
}

export type SyncKeyState =
  | { status: 'none' }
  | { status: 'needs-code' }
  | { status: 'ready'; crypto: SyncCrypto }
  /**
   * Сервер недоступен — мы НЕ ЗНАЕМ, есть ли у аккаунта ключ.
   *
   * Отдельное состояние, а не `none`: «не дозвонились» и «ключа нет» —
   * разные вещи, и путать их опасно в одну сторону. Приняв недоступность
   * за отсутствие ключа, приложение предложило бы СОЗДАТЬ ключ аккаунту,
   * у которого он, возможно, уже есть, — то есть повело бы человека в
   * операцию, которая сделала бы нечитаемым всё уже зашифрованное (сервер
   * её отобьёт, но предлагать её нельзя).
   */
  | { status: 'unknown' };

export interface SyncKeyOnboardingOptions {
  baseUrl: string;
  /** Уже авторизованный `fetch` — токен и device-id проставляет вызывающий. */
  fetch: FetchLike;
  /** `null` на платформах без защищённого хранилища (Web — см. design §3.1). */
  biometrics: BiometricProvider | null;
}

export class SyncKeyOnboarding {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly biometrics: BiometricProvider | null;

  constructor(options: SyncKeyOnboardingOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch;
    this.biometrics = options.biometrics;
  }

  private async record(): Promise<SyncKeyRecord | null> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/vault/sync-key`, {
      method: 'GET',
    }).catch(() => null);
    if (!response || !response.ok) return null;
    return (await response.json().catch(() => null)) as SyncKeyRecord | null;
  }

  /**
   * Где мы находимся. Кэш платформы пробуется ПЕРВЫМ: устройство, уже
   * прошедшее онбординг, не должно спрашивать код при каждом запуске.
   */
  async state(): Promise<SyncKeyState> {
    const record = await this.record();
    if (record === null) return { status: 'unknown' };
    if (!record.enrolled) return { status: 'none' };
    const salt = record.accountSalt === undefined ? null : fromBase64(record.accountSalt);
    if (salt === null) return { status: 'needs-code' };

    const cached = await this.biometrics?.unlock(SYNC_KEY_STORAGE_ID).catch(() => null);
    if (cached && cached.length > 0) {
      return { status: 'ready', crypto: new SyncCrypto({ smk: cached, accountSalt: salt }) };
    }
    return { status: 'needs-code' };
  }

  /**
   * Первое устройство аккаунта: создать SMK и показать код восстановления.
   *
   * Код возвращается ОДИН раз и здесь же — больше его взять негде: на
   * сервер он не уходит, в хранилище не кладётся, восстановить его из
   * обёртки невозможно. Вызывающий обязан показать его человеку до того,
   * как продолжит.
   */
  async create(): Promise<{ crypto: SyncCrypto; recovery: RecoveryCode } | null> {
    const smk = generateSmk();
    const accountSalt = randomBytes(16);
    const recovery = await generateRecoveryCode();

    const wrapped = await wrapSmk(smk, recovery.secret, accountSalt);
    const crypto = new SyncCrypto({ smk, accountSalt });
    const checkBlob = await crypto.sealManifest(utf8(CHECK_PLAINTEXT));

    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/vault/sync-key`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wrappedSmk: toBase64(wrapped),
        accountSalt: toBase64(accountSalt),
        checkBlob: toBase64(checkBlob),
        keyVersion: 1,
      }),
    }).catch(() => null);
    if (!response || !response.ok) return null;

    await this.cache(smk);
    return { crypto, recovery };
  }

  /**
   * Подключение ЭТОГО устройства кодом восстановления.
   *
   * Опечатка ловится контрольной суммой локально и НЕ доходит до сервера —
   * она не должна ни ходить по сети, ни тратить бюджет троттлинга
   * (design §6.0). Неверный (но корректно набранный) код даёт `wrong-code`
   * после честной попытки развернуть обёртку.
   */
  async unlock(typedCode: string): Promise<
    | { ok: true; crypto: SyncCrypto }
    | { ok: false; reason: 'typo' | 'wrong-code' | 'no-key' | 'offline' }
  > {
    const parsed = await parseRecoveryCode(typedCode);
    if (!parsed.ok) return { ok: false, reason: 'typo' };

    const record = await this.record();
    if (record === null) return { ok: false, reason: 'offline' };
    if (!record.enrolled || record.wrappedSmk === undefined || record.accountSalt === undefined) {
      return { ok: false, reason: 'no-key' };
    }

    const accountSalt = fromBase64(record.accountSalt);
    const smk = await unwrapSmk(fromBase64(record.wrappedSmk), parsed.secret, accountSalt);
    if (smk === null) return { ok: false, reason: 'wrong-code' };

    const crypto = new SyncCrypto({ smk, accountSalt });

    /* Проверочный конверт — второй, независимый признак того, что ключ
       именно тот. Обёртка уже сошлась по тегу GCM, так что это перестраховка,
       но дешёвая: она ловит случай «обёртка от одного аккаунта, соль от
       другого», который тег в одиночку не поймал бы. */
    if (record.checkBlob !== undefined) {
      const opened = await crypto.openManifest(fromBase64(record.checkBlob));
      if (opened === null || fromUtf8(opened) !== CHECK_PLAINTEXT) {
        return { ok: false, reason: 'wrong-code' };
      }
    }

    await this.cache(smk);
    return { ok: true, crypto };
  }

  private async cache(smk: Uint8Array): Promise<void> {
    await this.biometrics?.enroll(SYNC_KEY_STORAGE_ID, smk).catch(() => undefined);
  }

  /**
   * Выход из аккаунта: стереть материал ключа с устройства.
   *
   * Честно про границы (design §11): это НЕ криптографический отзыв. Тот,
   * кто уже снял копию ключа с устройства до выхода, её сохранит — общий
   * симметричный ключ на все устройства иначе не работает. Настоящий отзыв
   * = ротация SMK и перешифровка всего аккаунта, и это фаза 2. Здесь
   * закрывается ровно то, что закрывается: после выхода приложение на этом
   * устройстве больше не может расшифровать синк.
   */
  async forget(): Promise<void> {
    await this.biometrics?.remove(SYNC_KEY_STORAGE_ID).catch(() => undefined);
  }
}
