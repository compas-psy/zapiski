//! Реализация порта `UpdaterProvider` для Android.
//!
//! Встроенный апдейтер Tauri на Android не работает: там нет ни установщика
//! пакетов, ни проверки подписи движком. Поэтому обновление собрано из
//! штатных средств платформы.
//!
//! 1. **Проверка.** GET на
//!    `https://zapiski.cmpas.ru/api/v1/updates/android/{{current_version}}`.
//!    Сервер отвечает `204`, если ставить нечего, и манифестом
//!    Tauri-формата, если есть (`server/src/routes/updates.ts`). Текущая
//!    версия берётся из метаданных пакета — не из строки в коде, иначе она
//!    разъедется с `tauri.conf.json` в первый же релиз.
//! 2. **Установка — не наша.** Оболочка ТОЛЬКО узнаёт о новой версии; ссылку
//!    на APK открывает внешний браузер (`src/platform/updater.ts`), и дальше
//!    человек ставит пакет обычным путём.
//!
//!    Раньше здесь были скачивание и передача пакета системному установщику,
//!    для чего в манифесте стояло `REQUEST_INSTALL_PACKAGES`. Этим разрешением
//!    приложение объявляет себя установщиком ДРУГИХ приложений — признак, по
//!    которому Play Protect ловит дропперы, — и из-за него блокировалась
//!    КАЖДАЯ установка со вторым окном «всё равно установить». Соседние
//!    продукты на том же телефоне ставятся молча. Два тапа вместо одного
//!    несопоставимо дешевле блокировки на каждой установке.
//!
//! Подпись проверяет ОС: пакет с другой подписью не встанет поверх
//! установленного. Отсюда требование к CI — keystore и алиас не меняются
//! между релизами.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

/// Адрес фида. Совпадает с тем, что отдаёт `server/src/routes/updates.ts`.
const FEED: &str = "https://zapiski.cmpas.ru/api/v1/updates/android";

/// Ключ платформы в манифесте. Точное совпадение или префикс `android-`
/// (`android-universal`, `android-arm64` и т.п.).
const PLATFORM: &str = "android";

/// `UpdateInfo` из контракта ядра. Поля — camelCase: их читает TypeScript.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: String,
    pub pub_date: String,
    pub url: String,
}

/// Ответ Java-моста на HTTP-запрос.
#[derive(Deserialize)]
struct HttpResult {
    status: i32,
    #[serde(default)]
    body: String,
    #[serde(default)]
    error: String,
}

/// Манифест обновления (тот же формат, что у Tauri updater).
#[derive(Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    pub_date: String,
    platforms: std::collections::HashMap<String, ManifestPlatform>,
}

#[derive(Deserialize)]
struct ManifestPlatform {
    url: String,
}

/// Спросить фид. `None` — обновления нет; это не ошибка.
#[tauri::command(async)]
pub fn updater_check<R: Runtime>(app: AppHandle<R>) -> Result<Option<UpdateInfo>, String> {
    let current = app.package_info().version.to_string();
    let url = format!("{FEED}/{current}");

    let raw = crate::android::http_get(&url)?;
    let result: HttpResult = serde_json::from_str(&raw)
        .map_err(|error| format!("непонятный ответ моста: {error}"))?;

    // 204 — «обновления нет». Единственный способ сказать это в нашем фиде.
    if result.status == 204 {
        return Ok(None);
    }
    if result.status != 200 {
        return Err(if result.error.is_empty() {
            format!("сервер обновлений ответил {}", result.status)
        } else {
            result.error
        });
    }

    let manifest: Manifest = serde_json::from_str(&result.body)
        .map_err(|error| format!("непонятный манифест обновления: {error}"))?;

    // Сервер уже сравнил версии, но доверять этому целиком нельзя: манифест
    // мог быть выложен вручную. Ставить то, что уже стоит, — худший вид
    // навязчивости.
    if manifest.version == current {
        return Ok(None);
    }

    let Some(platform) = select_platform(&manifest) else {
        return Ok(None);
    };

    Ok(Some(UpdateInfo {
        version: manifest.version,
        notes: manifest.notes,
        pub_date: manifest.pub_date,
        url: platform,
    }))
}

/// Найти в манифесте ссылку для Android.
fn select_platform(manifest: &Manifest) -> Option<String> {
    if let Some(exact) = manifest.platforms.get(PLATFORM) {
        return Some(exact.url.clone());
    }
    let prefix = format!("{PLATFORM}-");
    manifest
        .platforms
        .iter()
        .find(|(name, _)| name.starts_with(&prefix))
        .map(|(_, value)| value.url.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(json: &str) -> Manifest {
        serde_json::from_str(json).expect("манифест должен разбираться")
    }

    #[test]
    fn выбирает_ссылку_для_android() {
        let value = manifest(
            r#"{
              "version": "0.2.0",
              "notes": "",
              "pub_date": "2026-09-01T10:00:00Z",
              "platforms": {
                "windows-x86_64": { "signature": "s", "url": "https://x/zapiski.msi" },
                "android-universal": { "signature": "", "url": "https://x/zapiski.apk" }
              }
            }"#,
        );
        assert_eq!(
            select_platform(&value).as_deref(),
            Some("https://x/zapiski.apk")
        );
    }

    #[test]
    fn релиз_только_для_windows_не_подходит() {
        let value = manifest(
            r#"{
              "version": "0.2.0",
              "platforms": { "windows-x86_64": { "signature": "s", "url": "https://x/z.msi" } }
            }"#,
        );
        assert!(select_platform(&value).is_none());
    }
}
