//! Реализация порта `VaultStorage` со стороны нативной ФС.
//!
//! Здесь живёт только запись. Чтение, обход каталога, `stat`, `mkdir`,
//! `remove` и `rename` делает `@tauri-apps/plugin-fs` из фронтенда — это
//! обычные операции, и своя команда для них ничего не добавила бы.
//!
//! Запись — другое дело. ТЗ §4.3 и ARCHITECTURE §2 требуют, чтобы она была
//! **атомарной**: «прерывание синка на любом байте не портит файл». В JS это
//! требование выполнить нельзя: между `writeFile(tmp)` и `rename(tmp, dst)`
//! проходит два IPC-раунда, а Android убивает фоновые процессы без
//! предупреждения — падение между шагами оставило бы временный файл и
//! устаревший оригинал. Поэтому «tmp → fsync → rename» выполняется целиком
//! внутри одной команды, в одном процессе, без возможности вклиниться.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_fs::FsExt;

/// Имя каталога vault'а внутри каталога приложения.
const VAULT_DIR: &str = "Записки";

/// Корень открытого vault'а. `None` — vault ещё не открывали.
#[derive(Default)]
pub struct VaultRoot(Mutex<Option<PathBuf>>);

impl VaultRoot {
    fn get(&self) -> Option<PathBuf> {
        self.0.lock().ok().and_then(|guard| guard.clone())
    }

    fn set(&self, path: PathBuf) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = Some(path);
        }
    }
}

/// Заголовок с путём внутри vault'а у сырого (бинарного) запроса записи.
const PATH_HEADER: &str = "x-vault-path";

/// Открыть каталог как vault.
///
/// Здесь же каталог выдаётся в рантайм-скоуп плагина `fs`: скоуп изначально
/// пуст (см. `tauri.conf.json`), поэтому до открытия vault'а приложение не
/// имеет доступа ни к одному файлу.
#[tauri::command(async)]
pub fn vault_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRoot>,
    path: String,
) -> Result<String, String> {
    let root = PathBuf::from(&path);
    fs::create_dir_all(&root).map_err(|error| format!("не удалось создать {path}: {error}"))?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("не удалось открыть каталог {path}: {error}"))?;

    if !root.is_dir() {
        return Err(format!("{} — не каталог", root.display()));
    }

    app.fs_scope()
        .allow_directory(&root, true)
        .map_err(|error| format!("не удалось выдать доступ к {}: {error}", root.display()))?;

    state.set(root.clone());

    // Открытие vault'а — первое, что делает приложение на старте, и к этому
    // моменту фронтенд уже подписан на события. Поэтому именно здесь
    // взводится отложенная «быстрая заметка»: раньше событие ушло бы в
    // пустоту (BEHAVIOR §8, плитка Quick Settings поднимает приложение с нуля).
    crate::platform::flush_quick_note();

    Ok(root.to_string_lossy().into_owned())
}

/// Абсолютный путь открытого vault'а — фронтенду он нужен, чтобы строить
/// аргументы для plugin-fs.
#[tauri::command(async)]
pub fn vault_root(state: State<'_, VaultRoot>) -> Option<String> {
    state.get().map(|root| root.to_string_lossy().into_owned())
}

/// Путь vault'а по умолчанию.
///
/// На Android «выбери любую папку» не существует: произвольный каталог общей
/// памяти приложению недоступен (scoped storage), а SAF отдаёт дерево
/// `content://`, поверх которого нет ни `rename`, ни атомарной записи —
/// то есть нет и инварианта §4.3.
///
/// Поэтому vault лежит в каталоге приложения во внешней памяти
/// (`/storage/emulated/0/Android/data/ru.cmpas.zapiski/files/Записки`): это
/// настоящие файлы `.md` на настоящей ФС, их видно с компьютера по USB, и
/// «file over app» соблюдён полностью. Если внешней памяти нет — внутренний
/// каталог приложения.
#[tauri::command(async)]
pub fn vault_default_root<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let base = crate::android::external_files_dir()
        .ok()
        .flatten()
        .or_else(|| crate::android::files_dir().ok().flatten())
        .map(PathBuf::from)
        .or_else(|| app.path().app_data_dir().ok())
        .ok_or_else(|| "не удалось определить каталог приложения".to_owned())?;

    let root = base.join(VAULT_DIR);
    fs::create_dir_all(&root).map_err(|error| format!("{}: {error}", root.display()))?;
    Ok(root.to_string_lossy().into_owned())
}

/// Атомарная запись файла vault'а (ТЗ §4.3).
///
/// Тело запроса — сырые байты, путь — в заголовке: так вложение на несколько
/// мегабайт не превращается в JSON-массив чисел по дороге через IPC.
#[tauri::command]
pub async fn vault_write_atomic<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, VaultRoot>,
    request: Request<'_>,
) -> Result<(), String> {
    let relative = request
        .headers()
        .get(PATH_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| format!("в запросе нет заголовка {PATH_HEADER}"))?;
    let relative = percent_decode(relative)?;

    let data = match request.body() {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        InvokeBody::Json(_) => return Err("тело запроса должно быть бинарным".to_owned()),
    };

    let root = state.get().ok_or_else(|| "vault не открыт".to_owned())?;
    let target = resolve_in_root(&root, &relative)?;
    write_atomic(&target, data).map_err(|error| format!("{}: {error}", target.display()))
}

/// tmp → fsync → rename. Именно в этом порядке и без возврата управления
/// наружу между шагами.
pub(crate) fn write_atomic(target: &Path, data: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "у пути нет каталога")
    })?;
    fs::create_dir_all(parent)?;

    let temporary = parent.join(temporary_name(target));

    let write_result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(data)?;
        // Без fsync rename может «обогнать» данные: каталожная запись уже
        // указывает на новый файл, а его содержимое ещё в кэше. Телефон,
        // у которого сел аккумулятор, оставил бы файл нулевой длины — ровно
        // ту потерю заметки, которую §4.3 запрещает.
        file.sync_all()?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    if let Err(error) = fs::rename(&temporary, target) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    // Долговечность самой записи каталога: без этого rename может не пережить
    // потерю питания, хотя данные уже на диске.
    if let Ok(dir) = fs::File::open(parent) {
        let _ = dir.sync_all();
    }

    Ok(())
}

/// Имя временного файла — рядом с целевым (тот же том, иначе rename перестаёт
/// быть атомарным) и с расширением `.tmp`, чтобы обходчик vault'а не принял
/// его за заметку.
fn temporary_name(target: &Path) -> String {
    let stem = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_owned());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    format!(".{stem}.{nanos}.tmp")
}

/// Путь внутри vault'а → абсолютный путь, с проверкой, что мы не вышли наружу.
///
/// `VaultPath` по контракту ядра — всегда прямые слэши и без ведущего слэша.
/// Всё остальное отвергается здесь, а не «нормализуется»: тихо исправленный
/// путь — это тихо записанный не туда файл.
fn resolve_in_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() {
        return Err("пустой путь".to_owned());
    }
    if relative.starts_with('/') || relative.starts_with('\\') {
        return Err(format!("путь должен быть относительным: {relative}"));
    }

    let mut result = root.to_path_buf();
    for segment in relative.split('/') {
        if segment.is_empty() || segment == "." {
            return Err(format!("пустой сегмент пути: {relative}"));
        }
        if segment == ".." {
            return Err(format!("выход за пределы vault'а: {relative}"));
        }
        if segment.contains('\\') {
            return Err(format!("недопустимый сегмент пути: {segment}"));
        }
        result.push(segment);
    }

    if !result.starts_with(root) {
        return Err(format!("выход за пределы vault'а: {relative}"));
    }
    Ok(result)
}

/// Заголовки HTTP допускают только ASCII, а пути в vault'е кириллические,
/// поэтому фронтенд шлёт путь percent-encoded.
fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .ok_or_else(|| format!("обрезанная последовательность в пути: {value}"))?;
            let hex = std::str::from_utf8(hex)
                .map_err(|_| format!("нечитаемая последовательность в пути: {value}"))?;
            let byte = u8::from_str_radix(hex, 16)
                .map_err(|_| format!("нечитаемая последовательность в пути: {value}"))?;
            out.push(byte);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| format!("путь не в UTF-8: {value}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn отвергает_выход_за_пределы_vault() {
        let root = Path::new("/vault");
        assert!(resolve_in_root(root, "../secrets.md").is_err());
        assert!(resolve_in_root(root, "Проекты/../../secrets.md").is_err());
        assert!(resolve_in_root(root, "/etc/passwd").is_err());
        assert!(resolve_in_root(root, "").is_err());
        assert!(resolve_in_root(root, "Проекты//Идея.md").is_err());
    }

    #[test]
    fn собирает_путь_внутри_vault() {
        let root = Path::new("/vault");
        let path = resolve_in_root(root, "Проекты/Идея.md").expect("путь должен собраться");
        assert_eq!(path, Path::new("/vault/Проекты/Идея.md"));
    }

    #[test]
    fn декодирует_кириллицу_из_заголовка() {
        assert_eq!(
            percent_decode("%D0%98%D0%B4%D0%B5%D1%8F.md").unwrap(),
            "Идея.md"
        );
        assert_eq!(percent_decode("plain.md").unwrap(), "plain.md");
        assert!(percent_decode("%D0").is_err());
    }

    #[test]
    fn запись_атомарна_и_перезаписывает() {
        let dir = std::env::temp_dir().join(format!("zapiski-mobile-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let target = dir.join("Заметка.md");

        write_atomic(&target, b"first").expect("первая запись");
        assert_eq!(fs::read(&target).unwrap(), b"first");

        write_atomic(&target, b"second").expect("перезапись");
        assert_eq!(fs::read(&target).unwrap(), b"second");

        // Временных файлов после успешной записи не остаётся.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "временный файл не убран");

        let _ = fs::remove_dir_all(&dir);
    }
}
