/**
 * SEC-001 фаза 1 — граница шифрования синка (design §1, §8).
 *
 * `SyncCrypto` держит SMK аккаунта и превращает его в доменные ключи
 * (`crypto/sync-keys.ts`) на каждую операцию. Всё, что уходит в Облако
 * Записок, проходит через `seal*`, всё, что приходит, — через `open*`.
 * Сам SMK не покидает этот объект: наружу отдаются только байты конверта.
 *
 * ── Конверт ──────────────────────────────────────────────────────────────
 *
 * ```
 *  0  1   версия конверта (1)
 *  1  12  нонс, 96 случайных бит (design §8.1)
 * 13  ..  шифротекст + 16-байтовый тег AES-GCM
 * ```
 *
 * Нонс не секрет и лежит рядом с шифротекстом — так и задумано: секретность
 * даёт ключ, а нонсу нужна только уникальность. Версия конверта подписана
 * как AAD вместе с доменной строкой (см. ниже) — тот же приём, что уже
 * применён к заголовку контейнера заметки (`crypto/container.ts`).
 *
 * ── Почему AAD — доменная строка ─────────────────────────────────────────
 *
 * Ключ и так выведен по домену и объекту, так что перенос шифротекста из
 * одного слота в другой уже не расшифруется. AAD с той же доменной строкой
 * — второй, дешёвый рубеж: он делает невозможной ситуацию «ключи совпали по
 * недосмотру будущей правки деривации, а подмена слота осталась незамеченной».
 * Стоимость — ноль байт в конверте (AAD не хранится, он выводится заново при
 * расшифровке).
 *
 * ── Чем адресуется ключ содержимого ──────────────────────────────────────
 *
 * design §2.2 говорит про `<note_id>` в доменной строке. На границе
 * `SyncBackend.put/get` идентификатора заметки нет — есть путь в vault'е,
 * которым объект и адресуется на сервере. Поэтому для домена `content`
 * идентификатором объекта служит НОРМАЛИЗОВАННЫЙ ПУТЬ, а для `crdt` и
 * `versions` — `note_id`, который на тех путях известен.
 *
 * Переименование заметки при этом не ломает расшифровку, хотя ключ и
 * зависит от пути: объект на сервере адресуется тем же путём, и при
 * переименовании синк заново кладёт содержимое по новому пути (а старый
 * удаляет) — «тот же шифротекст под другим путём» не возникает в принципе.
 * Это отличие от `keyId` локального контейнера (`crypto/container.ts`), где
 * файл переименовывает себя сам и ключ от пути был бы фатален.
 */
import {
  deriveSyncKey,
  SYNC_NONCE_LENGTH,
  syncKeyInfo,
  type SubtleLike,
  type SyncKeyDomain,
} from '../crypto/sync-keys.js';
import { concatBytes, randomBytes, utf8 } from '../util/bytes.js';

/** Версия конверта. Растёт вместе с раскладкой или сменой алгоритма. */
export const SYNC_ENVELOPE_VERSION = 1;

/** 1 байт версии + нонс + минимальный тег GCM. Короче — заведомо не конверт. */
const MIN_ENVELOPE_LENGTH = 1 + SYNC_NONCE_LENGTH + 16;

export interface SyncCryptoOptions {
  /** SMK аккаунта, 256 бит. Не выводится из пароля (design §2.3). */
  smk: Uint8Array;
  /** Публичная соль аккаунта — общая у всех устройств (design §2.2). */
  accountSalt: Uint8Array;
  subtle?: SubtleLike;
}

/**
 * Похож ли блоб на конверт синка. Нужен миграции и совместимости: пока
 * аккаунт не перешифрован, в облаке лежит смесь старых открытых байт и
 * новых конвертов, и читатель обязан отличать одно от другого, а не
 * гадать (design §10, §13).
 */
export function looksLikeEnvelope(data: Uint8Array): boolean {
  return data.length >= MIN_ENVELOPE_LENGTH && data[0] === SYNC_ENVELOPE_VERSION;
}

export class SyncCrypto {
  private readonly smk: Uint8Array;
  private readonly accountSalt: Uint8Array;
  private readonly subtle: SubtleLike | undefined;

  constructor(options: SyncCryptoOptions) {
    this.smk = options.smk;
    this.accountSalt = options.accountSalt;
    this.subtle = options.subtle;
  }

  private key(domain: SyncKeyDomain, objectId?: string): Promise<CryptoKey> {
    return deriveSyncKey(this.smk, this.accountSalt, domain, objectId, this.subtle);
  }

  private get api(): SubtleLike {
    return this.subtle ?? globalThis.crypto.subtle;
  }

  /** Зашифровать байты домена `domain` для объекта `objectId`. */
  async seal(domain: SyncKeyDomain, objectId: string | undefined, plaintext: Uint8Array): Promise<Uint8Array> {
    const key = await this.key(domain, objectId);
    const nonce = randomBytes(SYNC_NONCE_LENGTH);
    const header = new Uint8Array([SYNC_ENVELOPE_VERSION]);
    const aad = concatBytes(header, utf8(syncKeyInfo(domain, objectId)));
    const ciphertext = new Uint8Array(
      await this.api.encrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
        key,
        plaintext as BufferSource,
      ),
    );
    return concatBytes(header, nonce, ciphertext);
  }

  /**
   * `null` — не наш конверт, чужой ключ или порча. Никогда не бросает: тот
   * же контракт, что у `decrypt()` заметки (BEHAVIOR §5.2). Вызывающий сам
   * решает, что делать с `null`, — для синка это ветка «конфликт над
   * шифротекстом» (design §9), а не падение.
   */
  async open(
    domain: SyncKeyDomain,
    objectId: string | undefined,
    envelope: Uint8Array,
  ): Promise<Uint8Array | null> {
    if (!looksLikeEnvelope(envelope)) return null;
    const header = envelope.slice(0, 1);
    const nonce = envelope.slice(1, 1 + SYNC_NONCE_LENGTH);
    const ciphertext = envelope.slice(1 + SYNC_NONCE_LENGTH);
    try {
      const key = await this.key(domain, objectId);
      const aad = concatBytes(header, utf8(syncKeyInfo(domain, objectId)));
      const plain = await this.api.decrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
        key,
        ciphertext as BufferSource,
      );
      return new Uint8Array(plain);
    } catch {
      return null;
    }
  }

  sealContent(path: string, data: Uint8Array): Promise<Uint8Array> {
    return this.seal('content', path, data);
  }

  openContent(path: string, envelope: Uint8Array): Promise<Uint8Array | null> {
    return this.open('content', path, envelope);
  }

  sealCrdt(noteId: string, update: Uint8Array): Promise<Uint8Array> {
    return this.seal('crdt', noteId, update);
  }

  openCrdt(noteId: string, envelope: Uint8Array): Promise<Uint8Array | null> {
    return this.open('crdt', noteId, envelope);
  }

  sealVersion(noteId: string, data: Uint8Array): Promise<Uint8Array> {
    return this.seal('versions', noteId, data);
  }

  openVersion(noteId: string, envelope: Uint8Array): Promise<Uint8Array | null> {
    return this.open('versions', noteId, envelope);
  }

  sealManifest(data: Uint8Array): Promise<Uint8Array> {
    return this.seal('manifest', undefined, data);
  }

  openManifest(envelope: Uint8Array): Promise<Uint8Array | null> {
    return this.open('manifest', undefined, envelope);
  }
}
