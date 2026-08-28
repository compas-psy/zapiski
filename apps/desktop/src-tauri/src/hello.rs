//! Реализация порта `BiometricProvider`: Windows Hello на Windows, Touch ID
//! на macOS.
//!
//! Контракт ядра требует от порта не «покажи отпечаток», а «верни секрет
//! после успешной биометрии». Схема хранения у платформ РАЗНАЯ — каждая
//! использует то, что у неё есть от природы, а не копирует приём другой:
//!
//! **Windows.** Hello сам по себе хранилищем секретов не является:
//! 1. `KeyCredentialManager` создаёт пару ключей, закрытый ключ лежит в TPM
//!    и выдаётся только после успешной проверки лица/отпечатка/PIN;
//! 2. подписываем этим ключом фиксированный челлендж, привязанный к `keyId`.
//!    Подпись RSA PKCS#1 v1.5 детерминирована, значит одинаковый челлендж
//!    всегда даёт одинаковые байты;
//! 3. из подписи выводим ключ AES-256-GCM и заворачиваем в него секрет;
//! 4. на диск ложится только шифротекст. Без Windows Hello подпись получить
//!    нельзя, значит нельзя и расшифровать.
//!
//! **macOS.** Keychain, в отличие от Hello, — САМ по себе биометрически
//! защищённое хранилище: элемент с флагом `biometryCurrentSet` система не
//! отдаст без Touch ID, и городить свою криптографию поверх не нужно —
//! секрет ложится в Keychain как есть, файла на диске не остаётся вовсе
//! (см. `imp::enroll` в модуле macOS ниже).
//!
//! Что это даёт и чего не даёт. Секрет не хранится в открытом виде и не
//! достаётся простым копированием файла. Но это не замена паролю шифрования:
//! пароль остаётся единственным способом восстановить заметки, если
//! биометрия отвалилась (BEHAVIOR §5.2), и все ошибки этого модуля
//! деградируют именно к нему.
//!
//! ⚠️ Обе реализации СКОМПИЛИРОВАНЫ под свою платформу, но **не исполнялись**:
//! в окружении сборки нет ни Windows, ни живого Touch ID. Перед релизом
//! требуется ручная проверка на машине с настроенной биометрией.

use tauri::{AppHandle, Runtime};

// ПОЧЕМУ ЭТИ КОМАНДЫ СИНХРОННЫЕ, А НЕ async
//
// Объекты WinRT (`IBuffer`, указатели COM) не реализуют `Send`, а Tauri
// требует `Send` от футуры асинхронной команды. Любой `.await` посреди работы
// с ними даёт «future cannot be sent between threads safely»: значение живёт
// поперёк точки ожидания. Поэтому вместо `.await` используется блокирующий
// `.get()` из `windows-future` — COM-объекты не пересекают границу потока.
//
// Блокировка здесь безвредна: и Windows Hello, и Touch ID и так показывают
// модальное системное окно, а синхронные команды Tauri исполняет вне
// главного потока.
#[tauri::command]
pub fn hello_available() -> bool {
    imp::available()
}

#[tauri::command]
pub fn hello_enroll<R: Runtime>(
    app: AppHandle<R>,
    key_id: String,
    secret: Vec<u8>,
) -> Result<(), String> {
    imp::enroll(&app, &key_id, &secret)
}

/// `Ok(None)` — пользователь отменил проверку либо ключа нет. По BEHAVIOR
/// §5.2 это не ошибка: UI просто показывает поле пароля.
#[tauri::command]
pub fn hello_unlock<R: Runtime>(
    app: AppHandle<R>,
    key_id: String,
) -> Result<Option<Vec<u8>>, String> {
    imp::unlock(&app, &key_id)
}

#[tauri::command]
pub fn hello_remove<R: Runtime>(app: AppHandle<R>, key_id: String) -> Result<(), String> {
    imp::remove(&app, &key_id)
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use std::path::PathBuf;

    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use sha2::{Digest, Sha256};
    use tauri::{AppHandle, Manager, Runtime};
    use windows::core::HSTRING;
    use windows::Security::Credentials::{
        KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
    };
    use windows::Storage::Streams::{DataReader, DataWriter, IBuffer};

    /// Версия формата завёрнутого секрета. Первый байт файла.
    const BLOB_VERSION: u8 = 1;
    const NONCE_LEN: usize = 12;

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

    pub fn available() -> bool {
        match KeyCredentialManager::IsSupportedAsync() {
            Ok(operation) => operation.get().unwrap_or(false),
            Err(_) => false,
        }
    }

    pub fn enroll<R: Runtime>(app: &AppHandle<R>, key_id: &str, secret: &[u8]) -> Result<(), String> {
        let blob = wrap(key_id, secret)?;
        let path = blob_path(app, key_id)?;
        std::fs::write(&path, blob).map_err(|error| format!("{}: {error}", path.display()))
    }

    pub fn unlock<R: Runtime>(app: &AppHandle<R>, key_id: &str) -> Result<Option<Vec<u8>>, String> {
        let path = blob_path(app, key_id)?;
        let Ok(blob) = std::fs::read(&path) else {
            return Ok(None);
        };
        unwrap(key_id, &blob)
    }

    pub fn remove<R: Runtime>(app: &AppHandle<R>, key_id: &str) -> Result<(), String> {
        let path = blob_path(app, key_id)?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        }
        forget(key_id)
    }

    fn wrap(key_id: &str, secret: &[u8]) -> Result<Vec<u8>, String> {
        let key = derive_key(key_id, true)?.ok_or_else(|| {
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

    fn unwrap(key_id: &str, blob: &[u8]) -> Result<Option<Vec<u8>>, String> {
        if blob.len() < 1 + NONCE_LEN || blob[0] != BLOB_VERSION {
            return Err("файл ключа Windows Hello повреждён".to_owned());
        }

        let Some(key) = derive_key(key_id, false)? else {
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

    fn forget(key_id: &str) -> Result<(), String> {
        match KeyCredentialManager::DeleteAsync(&credential_name(key_id)) {
            // Ключа могло и не быть — это нормальный исход `remove`.
            Ok(action) => {
                let _ = action.get();
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
    fn derive_key(key_id: &str, create: bool) -> Result<Option<[u8; 32]>, String> {
        let name = credential_name(key_id);

        let retrieval = if create {
            KeyCredentialManager::RequestCreateAsync(&name, KeyCredentialCreationOption::ReplaceExisting)
                .map_err(win_error)?
                .get()
                .map_err(win_error)?
        } else {
            KeyCredentialManager::OpenAsync(&name)
                .map_err(win_error)?
                .get()
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
            .get()
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
}

// ─────────────────────────────────────────────────────────────────────────────
// macOS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod imp {
    //! Touch ID через Keychain (см. пояснение в шапке файла).
    //!
    //! `LAContext.canEvaluatePolicy` нужен ровно для одной вещи —
    //! `available()`: узнать, есть ли биометрия вообще, БЕЗ запроса пальца,
    //! чтобы решить, показывать ли тумблер (BEHAVIOR §5.1). Сам запрос и
    //! хранение делает Keychain: элемент с `AccessControlOptions::
    //! BIOMETRY_CURRENT_SET` система не отдаст без Touch ID — просить его
    //! отдельно у LocalAuthentication и потом городить свою привязку
    //! результата к секрету незачем.

    use objc2_local_authentication::{LAContext, LAPolicy};
    use security_framework::base::Error as SfError;
    use security_framework::passwords::{
        delete_generic_password, generic_password, set_generic_password_options,
        AccessControlOptions, PasswordOptions,
    };
    use tauri::{AppHandle, Runtime};

    /// `service` у элемента Keychain — общий для всех `keyId`, различает нас
    /// `account`. Тот же идентификатор, что и `tauri.conf.json` → `identifier`.
    const SERVICE: &str = "ru.cmpas.zapiski.hello";

    /// Коды `OSStatus`, при которых «секрет не достать» — это отказ или
    /// отсутствие ключа, а НЕ ошибка (BEHAVIOR §5.2): пользователь отменил
    /// Touch ID, промахнулся отпечатком мимо лимита попыток, или элемента ещё
    /// нет вовсе. Источник — публичный `<Security/SecBase.h>`.
    const ERR_ITEM_NOT_FOUND: i32 = -25300;
    const ERR_USER_CANCELED: i32 = -128;
    const ERR_AUTH_FAILED: i32 = -25293;
    const ERR_INTERACTION_NOT_ALLOWED: i32 = -25308;

    pub fn available() -> bool {
        let context = unsafe { LAContext::new() };
        unsafe {
            context.canEvaluatePolicy_error(
                LAPolicy::DeviceOwnerAuthenticationWithBiometrics,
                std::ptr::null_mut(),
            )
        }
    }

    pub fn enroll<R: Runtime>(_app: &AppHandle<R>, key_id: &str, secret: &[u8]) -> Result<(), String> {
        let mut options = PasswordOptions::new_generic_password(SERVICE, key_id);
        options.set_access_control_options(AccessControlOptions::BIOMETRY_CURRENT_SET);
        // `set_generic_password_options` сам заменяет прежний элемент того же
        // account'а — повторная регистрация не плодит дублей.
        set_generic_password_options(secret, options).map_err(keychain_error)
    }

    pub fn unlock<R: Runtime>(_app: &AppHandle<R>, key_id: &str) -> Result<Option<Vec<u8>>, String> {
        // Само чтение и есть запрос Touch ID: система заблокирует ответ, пока
        // человек не приложит палец или не отменит — ACL стоит на элементе.
        match generic_password(PasswordOptions::new_generic_password(SERVICE, key_id)) {
            Ok(secret) => Ok(Some(secret)),
            Err(error) if is_cancel_or_missing(&error) => Ok(None),
            Err(error) => Err(keychain_error(error)),
        }
    }

    pub fn remove<R: Runtime>(_app: &AppHandle<R>, key_id: &str) -> Result<(), String> {
        match delete_generic_password(SERVICE, key_id) {
            // Элемента могло и не быть — нормальный исход `remove`.
            Ok(()) => Ok(()),
            Err(error) if is_cancel_or_missing(&error) => Ok(()),
            Err(error) => Err(keychain_error(error)),
        }
    }

    fn is_cancel_or_missing(error: &SfError) -> bool {
        matches!(
            error.code(),
            ERR_ITEM_NOT_FOUND | ERR_USER_CANCELED | ERR_AUTH_FAILED | ERR_INTERACTION_NOT_ALLOWED
        )
    }

    fn keychain_error(error: SfError) -> String {
        format!("Keychain: {error}")
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Всё остальное
// ─────────────────────────────────────────────────────────────────────────────
//
// Оболочка собирается под linux только для проверки компиляции. Ни Windows
// Hello, ни Touch ID там нет и подделывать их нечем: `available()` честно
// отвечает `false`, и UI прячет тумблер биометрии (BEHAVIOR §5.1), а не
// показывает его выключенным.

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use tauri::{AppHandle, Runtime};

    pub fn available() -> bool {
        false
    }

    pub fn enroll<R: Runtime>(_app: &AppHandle<R>, _key_id: &str, _secret: &[u8]) -> Result<(), String> {
        Err("биометрия доступна только на Windows и macOS".to_owned())
    }

    pub fn unlock<R: Runtime>(_app: &AppHandle<R>, _key_id: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }

    pub fn remove<R: Runtime>(_app: &AppHandle<R>, _key_id: &str) -> Result<(), String> {
        Ok(())
    }
}
