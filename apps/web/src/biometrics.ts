/**
 * Биометрия в вебе — WebAuthn с расширением PRF (ARCHITECTURE §2).
 *
 * Контракт `BiometricProvider` требует вернуть ТОТ ЖЕ секрет, который положили
 * при регистрации. WebAuthn секретов не хранит: PRF отдаёт детерминированный
 * псевдослучайный вывод для пары (учётные данные, salt). Поэтому секрет
 * заворачивается этим выводом в AES-GCM, а наружу в IndexedDB уезжает только
 * шифртекст — без успешной биометрии он бесполезен.
 *
 * Если PRF или платформенный аутентификатор недоступны, провайдер равен `null`:
 * тумблер «Разблокировать отпечатком» тогда СКРЫТ, а не «выключен и недоступен»
 * (BEHAVIOR §5.1).
 */
import type { BiometricProvider } from '@zapiski/core';

const DB_NAME = 'zapiski';
const STORE = 'biometrics';
/** Соль PRF: фиксированная, различает назначения вывода, секретом не является. */
const PRF_SALT: ArrayBuffer = toBuffer(new TextEncoder().encode('zapiski.note-key.v1'));

interface Enrollment {
  credentialId: ArrayBuffer;
  iv: ArrayBuffer;
  wrapped: ArrayBuffer;
}

/** Расширения WebAuthn, которых ещё нет в стандартных типах DOM. */
interface PrfExtensionResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

export function createWebAuthnBiometrics(): BiometricProvider | null {
  if (typeof window === 'undefined') return null;
  if (typeof PublicKeyCredential === 'undefined') return null;
  if (!window.isSecureContext) return null;
  if (typeof indexedDB === 'undefined') return null;

  return {
    async isAvailable(): Promise<boolean> {
      const check = PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
      if (typeof check !== 'function') return false;
      return check.call(PublicKeyCredential).catch(() => false);
    },

    async enroll(keyId: string, secret: Uint8Array): Promise<void> {
      const created = (await navigator.credentials.create({
        publicKey: {
          challenge: randomBytes(32),
          rp: { name: 'ЗАПИСКИ', id: location.hostname },
          user: { id: new TextEncoder().encode(keyId), name: keyId, displayName: keyId },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            residentKey: 'required',
            userVerification: 'required',
          },
          extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!created) throw new Error('Биометрия недоступна');

      const results = created.getClientExtensionResults() as PrfExtensionResults;
      if (results.prf?.enabled !== true) {
        /* Аутентификатор PRF не умеет — регистрацию не оставляем висеть. */
        throw new Error('PRF не поддерживается');
      }

      /* Вывод PRF доступен не при создании, а при получении — спрашиваем сразу. */
      const output = await evaluatePrf(created.rawId);
      if (!output) throw new Error('PRF не вернул значение');

      const key = await importWrapKey(output);
      const iv = randomBytes(12);
      const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, toBuffer(secret));
      await put(keyId, { credentialId: created.rawId, iv: iv.buffer, wrapped });
    },

    /** `null` — пользователь отменил или ключа нет. Отмена не ошибка (§5.2). */
    async unlock(keyId: string): Promise<Uint8Array | null> {
      const record = await get(keyId);
      if (!record) return null;
      const output = await evaluatePrf(record.credentialId);
      if (!output) return null;
      try {
        const key = await importWrapKey(output);
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: record.iv },
          key,
          record.wrapped,
        );
        return new Uint8Array(plain);
      } catch {
        return null;
      }
    },

    async remove(keyId: string): Promise<void> {
      await drop(keyId);
    },
  };
}

/** Запрос биометрии и вывод PRF для сохранённых учётных данных. */
async function evaluatePrf(credentialId: ArrayBuffer): Promise<Uint8Array | null> {
  try {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId: location.hostname,
        userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: credentialId }],
        extensions: {
          prf: { eval: { first: PRF_SALT } },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!assertion) return null;
    const results = assertion.getClientExtensionResults() as PrfExtensionResults;
    const first = results.prf?.results?.first;
    return first ? new Uint8Array(first) : null;
  } catch {
    /* Отмена пользователем — не ошибка: экран покажет поле пароля. */
    return null;
  }
}

async function importWrapKey(material: Uint8Array): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', toBuffer(material));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Байты со СВОИМ `ArrayBuffer`: WebCrypto не принимает вид на SharedArrayBuffer. */
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(bytes);
  return bytes;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy.buffer;
}

/* ── IndexedDB ────────────────────────────────────────────────────────────── */

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function put(keyId: string, value: Enrollment): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, keyId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

async function get(keyId: string): Promise<Enrollment | null> {
  const db = await openDb();
  if (!db) return null;
  const value = await new Promise<Enrollment | null>((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(keyId);
    request.onsuccess = () => resolve((request.result as Enrollment) ?? null);
    request.onerror = () => resolve(null);
  });
  db.close();
  return value;
}

async function drop(keyId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(keyId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}
