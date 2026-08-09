//! Реализация порта `BiometricProvider` поверх Windows Hello.
//!
//! Контракт ядра требует от порта не «покажи отпечаток», а «верни секрет
//! после успешной биометрии». Windows Hello сам по себе хранилищем секретов
//! не является, поэтому схема такая (она же используется парольными
//! менеджерами под Windows):
//!
//! 1. `KeyCredentialManager` создаёт пару ключей, закрытый ключ лежит в TPM
//!    и выдаётся только после успешной проверки лица/отпечатка/PIN;
//! 2. подписываем этим ключом фиксированный челлендж, привязанный к `keyId`.
//!    Подпись RSA PKCS#1 v1.5 детерминирована, значит одинаковый челлендж
//!    всегда даёт одинаковые байты;
//! 3. из подписи выводим ключ AES-256-GCM и заворачиваем в него секрет;
//! 4. на диск ложится только шифротекст. Без Windows Hello подпись получить
//!    нельзя, значит нельзя и расшифровать.
//!
//! Что это даёт и чего не даёт. Секрет не хранится в открытом виде и не
//! достаётся простым копированием файла. Но это не замена паролю шифрования:
//! пароль остаётся единственным способом восстановить заметки, если
//! биометрия отвалилась (BEHAVIOR §5.2), и все ошибки этого модуля
//! деградируют именно к нему.
//!
//! ⚠️ Код скомпилирован под `x86_64-pc-windows-msvc`, но **не исполнялся**:
//! в окружении сборки нет Windows. Перед релизом требуется ручная проверка
//! на машине с настроенным Hello (см. отчёт).

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

/// Где лежат завёрнутые секреты. Каталог приложения, а не vault: секрет
/// привязан к устройству и в синхронизацию попадать не должен.
fn blob_path<R: Runtime>(app: &AppHandle<R>, key_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("нет каталога данных приложения: {error}"))?
        .join("hello");
    std::fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    Ok(dir.join(format!("{}.bin", file_stem(key_id))))
}

/// `keyId` приходит из ядра и может быть любым. В имя файла он попадает
/// только в шестнадцатеричном виде — так не важно, что в нём было.
fn file_stem(key_id: &str) -> String {
    key_id.bytes().map(|byte| format!("{byte:02x}")).collect()
}

#[tauri::command]
pub async fn hello_available() -> bool {
    imp::available().await
}

#[tauri::command]
pub async fn hello_enroll<R: Runtime>(
    app: AppHandle<R>,
    key_id: String,
    secret: Vec<u8>,
) -> Result<(), String> {
    let blob = imp::wrap(&key_id, &secret).await?;
    let path = blob_path(&app, &key_id)?;
    std::fs::write(&path, blob).map_err(|error| format!("{}: {error}", path.display()))
}

/// `Ok(None)` — пользователь отменил проверку либо ключа нет. По BEHAVIOR
/// §5.2 это не ошибка: UI просто показывает поле пароля.
#[tauri::command]
pub async fn hello_unlock<R: Runtime>(
    app: AppHandle<R>,
    key_id: String,
) -> Result<Option<Vec<u8>>, String> {
    let path = blob_path(&app, &key_id)?;
    let Ok(blob) = std::fs::read(&path) else {
        return Ok(None);
    };
    imp::unwrap(&key_id, &blob).await
}

#[tauri::command]
pub async fn hello_remove<R: Runtime>(app: AppHandle<R>, key_id: String) -> Result<(), String> {
    let path = blob_path(&app, &key_id)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    }
    imp::forget(&key_id).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use sha2::{Digest, Sha256};
    use windows::core::HSTRING;
    use windows::Security::Credentials::{
        KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
    };
    use windows::Storage::Streams::{DataReader, DataWriter, IBuffer};

    /// Версия формата завёрнутого секрета. Первый байт файла.
    const BLOB_VERSION: u8 = 1;
    const NONCE_LEN: usize = 12;

    pub async fn available() -> bool {
        match KeyCredentialManager::IsSupportedAsync() {
            Ok(operation) => operation.await.unwrap_or(false),
            Err(_) => false,
        }
    }

    pub async fn wrap(key_id: &str, secret: &[u8]) -> Result<Vec<u8>, String> {
        let key = derive_key(key_id, true).await?.ok_or_else(|| {
            "Windows Hello не подтвердил личность".to_owned()
        })?;

        let mut nonce_bytes = [0u8; NONCE_LEN];
        getrandom::fill(&mut nonce_bytes).map_err(|error| format!("нет источника случайности: {error}"))?;

        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|error| format!("не удалось построить шифр: {error}"))?;
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), secret)
            .map_err(|_| "не удалось зашифровать секрет".to_owned())?;

        let mut blob = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
        blob.push(BLOB_VERSION);
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&ciphertext);
        Ok(blob)
    }

    pub async fn unwrap(key_id: &str, blob: &[u8]) -> Result<Option<Vec<u8>>, String> {
        if blob.len() < 1 + NONCE_LEN || blob[0] != BLOB_VERSION {
            return Err("файл ключа Windows Hello повреждён".to_owned());
        }

        let Some(key) = derive_key(key_id, false).await? else {
            // Отмена пользователем или отсутствующий ключ — не ошибка.
            return Ok(None);
        };

        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|error| format!("не удалось построить шифр: {error}"))?;
        let nonce = Nonce::from_slice(&blob[1..1 + NONCE_LEN]);
        match cipher.decrypt(nonce, &blob[1 + NONCE_LEN..]) {
            Ok(secret) => Ok(Some(secret)),
            // Ключ Hello сменился (перенастроили биометрию) — секрет уже не
            // достать. Для UI это то же самое, что отмена: остаётся пароль.
            Err(_) => Ok(None),
        }
    }

    pub async fn forget(key_id: &str) -> Result<(), String> {
        match KeyCredentialManager::DeleteAsync(&credential_name(key_id)) {
            // Ключа могло и не быть — это нормальный исход `remove`.
            Ok(action) => {
                let _ = action.await;
                Ok(())
            }
            Err(_) => Ok(()),
        }
    }

    /// Получить подпись челленджа у Windows Hello и свернуть её в ключ AES.
    ///
    /// `create` — создавать ли учётные данные, если их ещё нет. При
    /// разблокировке создавать нельзя: новый ключ даст другую подпись, и
    /// старый секрет молча перестанет расшифровываться.
    async fn derive_key(key_id: &str, create: bool) -> Result<Option<[u8; 32]>, String> {
        let name = credential_name(key_id);

        let retrieval = if create {
            KeyCredentialManager::RequestCreateAsync(&name, KeyCredentialCreationOption::ReplaceExisting)
                .map_err(win_error)?
                .await
                .map_err(win_error)?
        } else {
            KeyCredentialManager::OpenAsync(&name)
                .map_err(win_error)?
                .await
                .map_err(win_error)?
        };

        let status = retrieval.Status().map_err(win_error)?;
        if status != KeyCredentialStatus::Success {
            return Ok(None);
        }

        let credential = retrieval.Credential().map_err(win_error)?;
        let challenge = to_buffer(&challenge_for(key_id)).map_err(win_error)?;
        let signing = credential
            .RequestSignAsync(&challenge)
            .map_err(win_error)?
            .await
            .map_err(win_error)?;

        if signing.Status().map_err(win_error)? != KeyCredentialStatus::Success {
            return Ok(None);
        }

        let signature = from_buffer(&signing.Result().map_err(win_error)?).map_err(win_error)?;
        if signature.is_empty() {
            return Ok(None);
        }

        let mut hasher = Sha256::new();
        hasher.update(b"zapiski/windows-hello/v1");
        hasher.update(&signature);
        Ok(Some(hasher.finalize().into()))
    }

    /// Челлендж детерминирован и завязан на `keyId`: разные заметки — разные
    /// ключи шифрования, даже если Hello один.
    fn challenge_for(key_id: &str) -> Vec<u8> {
        let mut hasher = Sha256::new();
        hasher.update(b"zapiski/challenge/v1");
        hasher.update(key_id.as_bytes());
        hasher.finalize().to_vec()
    }

    fn credential_name(key_id: &str) -> HSTRING {
        HSTRING::from(format!("ru.cmpas.zapiski.{key_id}"))
    }

    fn to_buffer(bytes: &[u8]) -> windows::core::Result<IBuffer> {
        let writer = DataWriter::new()?;
        writer.WriteBytes(bytes)?;
        writer.DetachBuffer()
    }

    fn from_buffer(buffer: &IBuffer) -> windows::core::Result<Vec<u8>> {
        let reader = DataReader::FromBuffer(buffer)?;
        let length = reader.UnconsumedBufferLength()? as usize;
        let mut out = vec![0u8; length];
        reader.ReadBytes(&mut out)?;
        Ok(out)
    }

    fn win_error(error: windows::core::Error) -> String {
        format!("Windows Hello: {error}")
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Всё остальное
// ─────────────────────────────────────────────────────────────────────────────
//
// Оболочка собирается под linux только для проверки компиляции. Windows Hello
// там нет и подделывать его нечем: `available()` честно отвечает `false`,
// и UI прячет тумблер биометрии (BEHAVIOR §5.1), а не показывает его
// выключенным.

#[cfg(not(windows))]
mod imp {
    pub async fn available() -> bool {
        false
    }

    pub async fn wrap(_key_id: &str, _secret: &[u8]) -> Result<Vec<u8>, String> {
        Err("биометрия доступна только на Windows".to_owned())
    }

    pub async fn unwrap(_key_id: &str, _blob: &[u8]) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }

    pub async fn forget(_key_id: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::file_stem;

    #[test]
    fn имя_файла_не_зависит_от_содержимого_идентификатора() {
        assert_eq!(file_stem("ab"), "6162");
        // Путь внутрь идентификатора не протекает.
        assert!(!file_stem("../../etc/passwd").contains('/'));
    }
}
