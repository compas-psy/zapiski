//! Реализация порта `BiometricProvider`.
//!
//! Вся работа с Keystore и `BiometricPrompt` — в Kotlin
//! (`android/.../Biometrics.kt`), здесь только команды и приведение типов.
//!
//! Важное правило (BEHAVIOR §5.1—5.2), которое видно уже отсюда:
//!
//! * `biometrics_available` возвращает `false`, если стойкой биометрии на
//!   устройстве нет или её не поддерживает версия Android. Тогда UI **скроет**
//!   тумблер. Возвращать `true` «на всякий случай» нельзя: пользователь решит,
//!   что заметка защищена отпечатком, а она не будет;
//! * отмена биометрии пользователем — это `Ok(None)`, а не ошибка. UI покажет
//!   поле пароля без единого сообщения.

/// Есть ли на устройстве настроенная стойкая биометрия.
#[tauri::command(async)]
pub fn biometrics_available() -> bool {
    // Ошибка моста — это тоже «нет биометрии». Показывать тумблер, который
    // упадёт при нажатии, хуже, чем не показывать его вовсе.
    crate::android::biometrics_available().unwrap_or(false)
}

/// Положить секрет под биометрию.
#[tauri::command(async)]
pub fn biometrics_enroll(key_id: String, secret: Vec<u8>) -> Result<(), String> {
    if secret.is_empty() {
        return Err("пустой секрет".to_owned());
    }
    crate::android::biometrics_enroll(&key_id, &secret)
}

/// Достать секрет после успешной биометрии. `None` — пользователь отменил.
#[tauri::command(async)]
pub fn biometrics_unlock(key_id: String) -> Result<Option<Vec<u8>>, String> {
    crate::android::biometrics_unlock(&key_id)
}

/// Убрать ключ: снятие шифрования или выключение тумблера.
#[tauri::command(async)]
pub fn biometrics_remove(key_id: String) -> Result<(), String> {
    crate::android::biometrics_remove(&key_id)
}
