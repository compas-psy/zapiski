/**
 * Крипто-провайдер (ТЗ §3.3, ADR-0001): AES-256-GCM из WebCrypto + KDF
 * Argon2id из `hash-wasm` с параметрами RFC 9106.
 *
 * Осознанные ограничения (ADR-0001, «Минусы»):
 *  • ключевой материал живёт в `CryptoKey` с `extractable: false`;
 *  • расшифрованный текст существует только в памяти — на диск не пишется
 *    никогда (за это отвечает `crypto/notes.ts`);
 *  • неверный пароль возвращает `null`, а не бросает (BEHAVIOR §5.2).
 */
import { argon2id } from 'hash-wasm';
import type { CryptoProvider, EncryptedContainer, MasterKey } from '../contract.js';
import { fromUtf8, randomBytes, utf8 } from '../util/bytes.js';
import {
  CONTAINER_VERSION,
  decodeContainer,
  encodeContainer,
  encodeHeader,
  KEY_ID_LENGTH,
  LEGACY_CONTAINER_VERSION,
  MAGIC,
  NONCE_LENGTH,
  SALT_LENGTH,
} from './container.js';

/**
 * Параметры Argon2id — второй рекомендованный набор RFC 9106 §4:
 * t = 3, m = 64 МиБ, p = 4, длина тега 32 байта. Версия контейнера = версия
 * параметров: смена параметров means bump `CONTAINER_VERSION`.
 */
export interface Argon2Params {
  iterations: number;
  memorySize: number;
  parallelism: number;
  hashLength: number;
}

export const ARGON2_PARAMS: Argon2Params = {
  iterations: 3,
  memorySize: 65_536,
  parallelism: 4,
  hashLength: 32,
};

export interface WebCryptoProviderOptions {
  /** Облегчённые параметры для тестов и слабых устройств. */
  argon2?: Partial<Argon2Params>;
  subtle?: SubtleCrypto;
}

export class WebCryptoProvider implements CryptoProvider {
  private readonly params: Argon2Params;
  private readonly subtle: SubtleCrypto;
  /**
   * Соль, из которой выведен ключ. Контракт `encrypt(plaintext, key)` соли не
   * передаёт, а контейнеру она нужна — держим привязку в WeakMap, чтобы ключ
   * оставался неэкспортируемым и не таскал за собой сырые байты.
   */
  private readonly saltOf = new WeakMap<CryptoKey, Uint8Array>();
  /**
   * `keyId` ключа заметки. Живёт рядом с солью и по той же причине: `encrypt`
   * получает только ключ, а в заголовок контейнера обязаны попасть оба
   * значения — иначе этот же ключ не выведется при следующем открытии.
   * Ключ без `keyId` — ключ версии 1, и писать им запрещено (см. `encrypt`).
   */
  private readonly keyIdOf = new WeakMap<CryptoKey, Uint8Array>();

  constructor(options: WebCryptoProviderOptions = {}) {
    this.params = { ...ARGON2_PARAMS, ...options.argon2 };
    this.subtle = options.subtle ?? globalThis.crypto.subtle;
  }

  randomSalt(): Uint8Array {
    return randomBytes(SALT_LENGTH);
  }

  randomKeyId(): Uint8Array {
    return randomBytes(KEY_ID_LENGTH);
  }

  /** Argon2id по RFC 9106 → сырой материал для платформенного хранилища. */
  async deriveMasterMaterial(password: string, salt: Uint8Array): Promise<Uint8Array> {
    return this.argon2(password, salt);
  }

  /** Материал → неэкспортируемая HKDF-база, из которой растут ключи заметок. */
  async importMaster(material: Uint8Array, salt: Uint8Array): Promise<MasterKey> {
    const key = await this.subtle.importKey('raw', material as BufferSource, 'HKDF', false, ['deriveKey']);
    return { key, salt };
  }

  /** Пароль → ключ хранилища. Argon2id прогоняется здесь один раз за сеанс. */
  async deriveMaster(password: string, salt: Uint8Array): Promise<MasterKey> {
    const material = await this.deriveMasterMaterial(password, salt);
    const master = await this.importMaster(material, salt);
    // Затираем копию материала в managed-памяти сразу после импорта.
    material.fill(0);
    return master;
  }

  /**
   * Иерархия ключей ТЗ §3.3: master → per-note. Ключ заметки выводится HKDF
   * по `keyId` из заголовка её контейнера — мгновенно, без Argon2id.
   */
  async deriveNoteKey(master: MasterKey, keyId: Uint8Array): Promise<CryptoKey> {
    const key = await this.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: master.salt as BufferSource,
        info: utf8(`zapiski/note/${hex(keyId)}`) as BufferSource,
      },
      master.key,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    this.saltOf.set(key, master.salt);
    this.keyIdOf.set(key, keyId);
    return key;
  }

  /**
   * Ключ контейнера версии 1: Argon2id прямо в AES-ключ, без иерархии.
   * Только чтение — им зашифрованы файлы, созданные до §3.3.
   */
  async deriveLegacyKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const material = await this.argon2(password, salt);
    const key = await this.subtle.importKey('raw', material as BufferSource, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    material.fill(0);
    this.saltOf.set(key, salt);
    return key;
  }

  private async argon2(password: string, salt: Uint8Array): Promise<Uint8Array> {
    return argon2id({
      password,
      salt,
      parallelism: this.params.parallelism,
      iterations: this.params.iterations,
      memorySize: this.params.memorySize,
      hashLength: this.params.hashLength,
      outputType: 'binary',
    });
  }

  async encrypt(plaintext: string, key: CryptoKey, hint?: string): Promise<Uint8Array> {
    const salt = this.saltOf.get(key);
    if (!salt) {
      // Ключ не наш: без соли контейнер нельзя будет открыть после перезапуска.
      throw new Error('Ключ получен не через deriveNoteKey — соль контейнера неизвестна');
    }
    const keyId = this.keyIdOf.get(key);
    if (!keyId) {
      /* Ключ версии 1. Писать им — значит плодить файлы без иерархии, которые
         снова потребуют пароль на каждую заметку. Версия 1 только читается. */
      throw new Error('Шифровать можно только ключом заметки из deriveNoteKey (контейнер версии 2)');
    }
    const nonce = randomBytes(NONCE_LENGTH);
    const data = utf8(plaintext);
    /* Заголовок известен до шифрования — им и подписываем (см. encodeHeader). */
    const header: Omit<EncryptedContainer, 'ciphertext'> = {
      magic: MAGIC,
      version: CONTAINER_VERSION,
      salt,
      nonce,
      keyId,
    };
    if (hint !== undefined && hint !== '') header.hint = hint;
    const aad = encodeHeader(header);
    const encrypted = new Uint8Array(
      await this.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
        key,
        data as BufferSource,
      ),
    );
    data.fill(0);
    return encodeContainer({ ...header, ciphertext: encrypted });
  }

  /**
   * `null` — пароль не подошёл либо контейнер повреждён (BEHAVIOR §5.2).
   *
   * Версию проверяем на «знаем ли мы её», а не на равенство текущей: файлы
   * версии 1 обязаны открываться и после перехода на иерархию ключей. Какой
   * ключ подать — решает вызывающий по `parseHeader().version`.
   */
  async decrypt(container: Uint8Array, key: CryptoKey): Promise<string | null> {
    const parsed = decodeContainer(container);
    if (!parsed) return null;
    if (parsed.version !== CONTAINER_VERSION && parsed.version !== LEGACY_CONTAINER_VERSION) return null;
    try {
      /* Версия 1 писалась без AAD — подписывать там нечего. */
      const algorithm: AesGcmParams =
        parsed.version === LEGACY_CONTAINER_VERSION || !parsed.aad
          ? { name: 'AES-GCM', iv: parsed.nonce as BufferSource }
          : { name: 'AES-GCM', iv: parsed.nonce as BufferSource, additionalData: parsed.aad as BufferSource };
      const plain = await this.subtle.decrypt(algorithm, key, parsed.ciphertext as BufferSource);
      return fromUtf8(new Uint8Array(plain));
    } catch {
      return null;
    }
  }

  parseHeader(
    container: Uint8Array,
  ): Pick<EncryptedContainer, 'version' | 'salt' | 'hint' | 'keyId'> | null {
    const parsed = decodeContainer(container);
    if (!parsed) return null;
    const header: Pick<EncryptedContainer, 'version' | 'salt' | 'hint' | 'keyId'> = {
      version: parsed.version,
      salt: parsed.salt,
    };
    if (parsed.keyId !== undefined) header.keyId = parsed.keyId;
    if (parsed.hint !== undefined) header.hint = parsed.hint;
    return header;
  }
}

/** `keyId` в HKDF-info — строкой: так info читается в отладке глазами. */
function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Задержки после неудачных попыток (BEHAVIOR §5.2): попытки 1–4 без задержки,
 * после 5-й — 30 с, после 8-й — 5 мин. Данные не удаляются никогда.
 */
export function unlockDelayMs(failedAttempts: number): number {
  if (failedAttempts >= 8) return 300_000;
  if (failedAttempts >= 5) return 30_000;
  return 0;
}
