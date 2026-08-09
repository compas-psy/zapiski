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
import type { CryptoProvider, EncryptedContainer } from '../contract.js';
import { fromUtf8, randomBytes, utf8 } from '../util/bytes.js';
import { CONTAINER_VERSION, decodeContainer, encodeContainer, MAGIC, NONCE_LENGTH, SALT_LENGTH } from './container.js';

/**
 * Параметры Argon2id — второй рекомендованный набор RFC 9106 §4:
 * t = 3, m = 64 МиБ, p = 4, длина тега 32 байта. Версия контейнера = версия
 * параметров: смена параметров means bump `CONTAINER_VERSION`.
 */
export const ARGON2_PARAMS = {
  iterations: 3,
  memorySize: 65_536,
  parallelism: 4,
  hashLength: 32,
} as const;

export interface WebCryptoProviderOptions {
  /** Облегчённые параметры для тестов и слабых устройств. */
  argon2?: Partial<typeof ARGON2_PARAMS>;
  subtle?: SubtleCrypto;
}

export class WebCryptoProvider implements CryptoProvider {
  private readonly params: typeof ARGON2_PARAMS;
  private readonly subtle: SubtleCrypto;
  /**
   * Соль, из которой выведен ключ. Контракт `encrypt(plaintext, key)` соли не
   * передаёт, а контейнеру она нужна — держим привязку в WeakMap, чтобы ключ
   * оставался неэкспортируемым и не таскал за собой сырые байты.
   */
  private readonly saltOf = new WeakMap<CryptoKey, Uint8Array>();

  constructor(options: WebCryptoProviderOptions = {}) {
    this.params = { ...ARGON2_PARAMS, ...options.argon2 };
    this.subtle = options.subtle ?? globalThis.crypto.subtle;
  }

  randomSalt(): Uint8Array {
    return randomBytes(SALT_LENGTH);
  }

  /** Argon2id по RFC 9106 → неэкспортируемый AES-256-GCM ключ. */
  async deriveMasterKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const material = await this.argon2(password, salt);
    const key = await this.subtle.importKey('raw', material as BufferSource, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    // Затираем копию материала в managed-памяти сразу после импорта.
    material.fill(0);
    this.saltOf.set(key, salt);
    return key;
  }

  /**
   * Иерархия ключей ТЗ §3.3: master → per-note. Ключ заметки выводится HKDF
   * из того же материала, поэтому смена пароля не требует перешифровки
   * вложений по одному.
   */
  async deriveNoteKey(password: string, salt: Uint8Array, noteId: string): Promise<CryptoKey> {
    const material = await this.argon2(password, salt);
    const base = await this.subtle.importKey('raw', material as BufferSource, 'HKDF', false, ['deriveKey']);
    material.fill(0);
    const key = await this.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: utf8(`zapiski/note/${noteId}`) as BufferSource },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
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
      throw new Error('Ключ получен не через deriveMasterKey — соль контейнера неизвестна');
    }
    const nonce = randomBytes(NONCE_LENGTH);
    const data = utf8(plaintext);
    const encrypted = new Uint8Array(
      await this.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, data as BufferSource),
    );
    data.fill(0);
    const container: EncryptedContainer = {
      magic: MAGIC,
      version: CONTAINER_VERSION,
      salt,
      nonce,
      ciphertext: encrypted,
    };
    if (hint !== undefined && hint !== '') container.hint = hint;
    return encodeContainer(container);
  }

  /** `null` — пароль не подошёл либо контейнер повреждён (BEHAVIOR §5.2). */
  async decrypt(container: Uint8Array, key: CryptoKey): Promise<string | null> {
    const parsed = decodeContainer(container);
    if (!parsed || parsed.version !== CONTAINER_VERSION) return null;
    try {
      const plain = await this.subtle.decrypt(
        { name: 'AES-GCM', iv: parsed.nonce as BufferSource },
        key,
        parsed.ciphertext as BufferSource,
      );
      return fromUtf8(new Uint8Array(plain));
    } catch {
      return null;
    }
  }

  parseHeader(container: Uint8Array): Pick<EncryptedContainer, 'version' | 'salt' | 'hint'> | null {
    const parsed = decodeContainer(container);
    if (!parsed) return null;
    const header: Pick<EncryptedContainer, 'version' | 'salt' | 'hint'> = {
      version: parsed.version,
      salt: parsed.salt,
    };
    if (parsed.hint !== undefined) header.hint = parsed.hint;
    return header;
  }
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
