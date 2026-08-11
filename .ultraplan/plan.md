# Implementation Plan: §3.3 — иерархия ключей «пароль → master → per-note»

## Context
Сейчас у каждой заметки свой пароль и свой Argon2 при каждой разблокировке; §9 отложен, тумблер «Шифровать новые заметки» мёртв, `deriveNoteKey` написан и не вызывается.

## Changes

### Контейнер v2 и провайдер
- **File**: `packages/core/src/crypto/container.ts:24` — `CONTAINER_VERSION = 2`, во флаги бит 1, после nonce 16 байт `keyId`. v1 декодируется как раньше.
- **File**: `packages/core/src/contract.ts:268` — в `CryptoProvider`: `deriveMasterMaterial(password, salt)` (сырые байты — для биометрии), `importMaster(material, salt)`, `deriveNoteKey(master, keyId)`. `deriveMasterKey` остаётся путём чтения v1.
- **File**: `packages/core/src/crypto/provider.ts:78` — переписать существующий `deriveNoteKey` под `(master, keyId)`; **Reuses**: HKDF-ветка оттуда же, `saltOf` WeakMap `provider.ts:49`.
- **Ключ заметки привязан к `keyId` из заголовка, а не к пути или id заметки** — переименование не расшифровывается заново.

### Файловый слой
- **File**: `packages/core/src/crypto/notes.ts:28` — `encryptNoteFile(…, master, hint)` генерит `keyId`, пишет v2; `decryptNoteFile` ветвится по версии контейнера; новый `rewriteToV2` для ленивой миграции.
- **File**: `packages/core/src/crypto/notes.ts` — новый `createEncryptedNote(storage, provider, path, master, body)`: пишет сразу `.md.enc`, минуя `.md`.

### Приложение
- **File**: `packages/app/src/state/store.ts:1312` — `unlock` → разблокировка ХРАНИЛИЩА: соль (память → `.zapiski/crypto.json` → любой контейнер → новая), Argon2 один раз за сеанс, master в приватном поле контроллера. **Reuses**: `guard` `store.ts:1324`, `putUnlocked` `store.ts:1347`.
- **File**: `packages/app/src/state/store.ts:1288` — `encryptNote(path)` без пароля, когда master есть; `setVaultPassword(password, hint)` для первой установки.
- **File**: `packages/app/src/state/store.ts:1338` — биометрия по `keyId = 'vault'`, отдаёт master-материал (Argon2 не запускается).
- **File**: `packages/app/src/state/store.ts:951` — `createNote`: при `security.encryptNewNotes` и живом master — через `createEncryptedNote`; при запертом хранилище — сначала экран разблокировки.
- **File**: `packages/app/src/state/store.ts:1382` `lockAll` — обнуляет master вместе с `unlocked`.
- **File**: `packages/app/src/state/store.ts` — `changeVaultPassword(old, new)`: новый master и новая соль, перешифровка всех `.md.enc` (два Argon2 на всю операцию, дальше только AES), честный отчёт о том, что не переписалось.

### Экраны
- **File**: `packages/app/src/screens/EncryptSheet.tsx:39` — два режима: «задать пароль хранилища» (первый раз) и «зашифровать» (полей нет).
- **File**: `packages/app/src/screens/LockScreen.tsx:65` — биометрия по `'vault'`.
- **File**: `packages/app/src/screens/SettingsScreen.tsx:457` — оба мёртвых тумблера («Шифровать новые заметки», «Разблокировать биометрией») на реальные преф и enroll; пункт «Сменить пароль» — диалог старый/новый/повтор.

## Implementation Sequence
1. `container.ts` + `provider.ts` + `contract.ts` — формат и ключи, тесты в `packages/core/test/crypto.test.ts` (v2 round-trip, ключи двух заметок различаются, v1 читается).
2. `crypto/notes.ts` — запись v2, ветвление по версии, `createEncryptedNote`, ленивая миграция.
3. `store.ts` — master в сеансе, биометрия к нему, `createNote`, `lockAll`; новый `packages/app/test/crypto.vault-key.test.ts`.
4. Экраны и оба тумблера; `packages/app/test/security.unlock-delay.test.ts` перечитать (счётчик глобальный — остаётся).
5. `scripts/walkthrough.mjs` — путь «шифрование туда-обратно»: задать пароль → замок → разблокировать → вторая заметка открывается без пароля.

## Edge Cases & Risks
- **Плейнтекст на диске**: шифрование новой заметки через `vault.create()` положило бы `.md` до `.md.enc`. Поэтому шаг 2 даёт `createEncryptedNote`, а не «создать и зашифровать».
- **Две соли на двух устройствах**: разблокировка всегда идёт от соли ИЗ контейнера, поэтому расхождение не ломает открытие; сходятся при первом же синке.
- **Автозамок теперь закрывает всё разом** (master один) — это и требует BEHAVIOR §5.3.
- **v1 после миграции**: файл переписывается, синк увидит правку — продукт не выпущен, потерять нечего.
- **Оборванная смена пароля**: контейнер несёт свою соль, поэтому недописанные заметки продолжают открываться СТАРЫМ паролем, а не превращаются в мусор. Экран называет их поимённо.
- **Ключ хранилища нигде не хранится** — ни в `.zapiski/`, ни в облаке: всё нужное для расшифровки лежит в самом контейнере, а пароль в голове. Иначе удаление `.zapiski/` (по устройству документации — восстановимого каталога) убивало бы заметки навсегда.

## Verification
`bash scripts/preflight.sh --dirty && node scripts/walkthrough.mjs`
