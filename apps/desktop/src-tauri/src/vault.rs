//! Реализация порта `VaultStorage` со стороны нативной ФС.
//!
//! Здесь живёт только запись. Чтение, обход каталога, `stat`, `mkdir`,
//! `remove` и `rename` делает `@tauri-apps/plugin-fs` из фронтенда — это
//! обычные операции, и своя команда для них ничего не добавила бы.
//!
//! Запись — другое дело. ТЗ §4.3 и ARCHITECTURE §2 требуют, чтобы она была
//! **атомарной**: «прерывание синка на любом байте не портит файл». В JS это
//! требование выполнить нельзя: между `writeFile(tmp)` и `rename(tmp, dst)`
//! проходит два IPC-раунда, и падение процесса между ними оставит на диске
//! временный файл и нетронутый (то есть устаревший) оригинал. Поэтому
//! последовательность «tmp → fsync → rename» выполняется целиком внутри одной
//! команды, в одном процессе, без возможности вклиниться.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_fs::FsExt;

/// Корень открытого vault'а. `None` — vault ещё не выбран (онбординг).
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
/// Здесь же каталог выдаётся в рантайм-скоупы: `fs` — чтобы фронтенд мог
/// читать файлы через plugin-fs, `asset` — чтобы вложения показывались в
/// `<img src="asset://...">`. Оба скоупа изначально пусты (см.
/// `tauri.conf.json`), поэтому до выбора vault'а приложение не имеет доступа
/// ни к одному файлу пользователя.
#[tauri::command(async)]
pub fn vault_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRoot>,
    path: String,
) -> Result<String, String> {
    let root = PathBuf::from(&path)
        .canonicalize()
        .map_err(|error| format!("не удалось открыть каталог {path}: {error}"))?;

    if !root.is_dir() {
        return Err(format!("{} — не каталог", root.display()));
    }

    app.fs_scope()
        .allow_directory(&root, true)
        .map_err(|error| format!("не удалось выдать доступ к {}: {error}", root.display()))?;
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|error| format!("не удалось выдать доступ к {}: {error}", root.display()))?;

    state.set(root.clone());
    Ok(root.to_string_lossy().into_owned())
}

/// Абсолютный путь открытого vault'а — фронтенду он нужен, чтобы строить
/// аргументы для plugin-fs.
#[tauri::command(async)]
pub fn vault_root(state: State<'_, VaultRoot>) -> Option<String> {
    state.get().map(|root| root.to_string_lossy().into_owned())
}

/// Атомарная запись файла vault'а (ТЗ §4.3).
///
/// Тело запроса — сырые байты, путь — в заголовке: так гигабайтная картинка
/// не превращается в JSON-массив из чисел по дороге через IPC.
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
    write_atomic(&root, &target, data).map_err(|error| format!("{}: {error}", target.display()))
}

/// tmp → fsync → rename. Именно в этом порядке и без возврата управления
/// наружу между шагами.
fn write_atomic(root: &Path, target: &Path, data: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "у пути нет каталога")
    })?;

    // Проверка ДО create_dir_all: иначе каталоги создались бы уже по ту
    // сторону симлинка, и запрет опоздал бы.
    ensure_inside(root, parent)?;
    fs::create_dir_all(parent)?;
    // И после: теперь каталог точно существует и раскрывается целиком, а не
    // до ближайшего существующего предка.
    ensure_inside(root, parent)?;

    let temporary = parent.join(temporary_name(target));

    // Блок нужен, чтобы файл закрылся до rename: на Windows переименовать
    // открытый файл нельзя.
    let write_result = (|| -> std::io::Result<()> {
        // `create_new`, а не `create`: если по этому имени кто-то успел
        // положить симлинк, открытие обязано провалиться, а не пройти по
        // ссылке наружу. Обычный `File::create` симлинк бы разыменовал.
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(data)?;
        // Без fsync rename может «обогнать» данные: каталожная запись уже
        // указывает на новый файл, а его содержимое ещё в кэше. После
        // внезапного отключения питания получим файл нулевой длины —
        // ровно та потеря заметки, которую §4.3 запрещает.
        file.sync_all()?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    // На Windows std::fs::rename делает MoveFileEx с MOVEFILE_REPLACE_EXISTING,
    // то есть заменяет существующий файл одной атомарной операцией.
    if let Err(error) = fs::rename(&temporary, target) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    // Долговечность самой записи каталога. На Windows каталог как файл не
    // открывается, и аналога нет — там надёжность обеспечивает сам
    // MoveFileEx, поэтому шаг платформенный.
    #[cfg(unix)]
    if let Ok(dir) = fs::File::open(parent) {
        let _ = dir.sync_all();
    }

    Ok(())
}

/// Каталог `dir` действительно лежит внутри vault'а — с раскрытием ссылок.
///
/// Лексической проверки `resolve_in_root` для этого мало. Она смотрит на
/// строку, а строка ничего не знает о симлинках и junction'ах: путь
/// `vault/архив/Идея.md`, где `архив` — ссылка на `C:\Windows\System32`,
/// проходит её целиком и уводит запись наружу. А ссылку в vault может
/// положить не только пользователь: vault синхронизируется, и вредоносный
/// «архив» приезжает с чужого устройства как обычный файл.
///
/// Поэтому берём ближайшего **существующего** предка (сам каталог мог ещё не
/// быть создан), раскрываем его `canonicalize` — то есть проходим все ссылки
/// до настоящего пути — и сверяем с так же раскрытым корнем. Симлинк внутри
/// vault'а, ведущий внутрь же vault'а, при этом остаётся разрешённым: он
/// никуда не уводит.
fn ensure_inside(root: &Path, dir: &Path) -> std::io::Result<()> {
    let root = fs::canonicalize(root)?;

    // `symlink_metadata`, а не `exists`: `exists` идёт по ссылке и на висячей
    // ссылке отвечает «нет», из-за чего мы проскочили бы её и проверили
    // предка, который уже ни при чём.
    let mut probe = dir;
    let anchor = loop {
        if probe.symlink_metadata().is_ok() {
            break probe;
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "не нашли ни одного существующего каталога на пути",
                ))
            }
        }
    };

    // canonicalize висячей ссылки провалится — и это правильный исход:
    // писать по ссылке в никуда мы не станем.
    let anchor = fs::canonicalize(anchor)?;
    if !anchor.starts_with(&root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "путь ведёт за пределы vault'а: {} вне {}",
                anchor.display(),
                root.display()
            ),
        ));
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
        .map(|d| d.as_nanos())
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
        // Обратный слэш и двоеточие на Windows означают смену каталога или
        // тома — в сегменте им делать нечего.
        if segment.contains('\\') || segment.contains(':') {
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
///
/// `pub(crate)`, потому что тем же способом приезжает имя файла в
/// `save::save_file`: две копии декодера разъехались бы на первом же
/// исправлении.
pub(crate) fn percent_decode(value: &str) -> Result<String, String> {
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
        assert!(resolve_in_root(root, "C:\\Windows").is_err());
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
        assert_eq!(percent_decode("%D0%98%D0%B4%D0%B5%D1%8F.md").unwrap(), "Идея.md");
        assert_eq!(percent_decode("plain.md").unwrap(), "plain.md");
        assert!(percent_decode("%D0").is_err());
    }

    /// Свой каталог на каждый тест: тесты идут в потоках одного процесса, и
    /// общий каталог они бы делили.
    fn temporary_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zapiski-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("каталог для теста");
        dir
    }

    #[test]
    fn запись_атомарна_и_перезаписывает() {
        let dir = temporary_dir("write");
        let target = dir.join("Заметка.md");

        write_atomic(&dir, &target, b"first").expect("первая запись");
        assert_eq!(fs::read(&target).unwrap(), b"first");

        write_atomic(&dir, &target, b"second").expect("перезапись");
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

    #[test]
    fn создаёт_подкаталоги_внутри_vault() {
        let dir = temporary_dir("subdir");
        let target = dir.join("Проекты").join("Идея.md");

        write_atomic(&dir, &target, b"внутри").expect("запись в новый подкаталог");
        assert_eq!(fs::read(&target).unwrap(), "внутри".as_bytes());

        let _ = fs::remove_dir_all(&dir);
    }

    /// Регрессия на обход строковой проверки корня симлинком.
    ///
    /// Симлинк внутрь vault'а мог приехать синхронизацией с чужого
    /// устройства, поэтому проверка не может опираться на то, что содержимое
    /// vault'а создавал сам пользователь.
    #[cfg(unix)]
    #[test]
    fn не_пишет_по_симлинку_наружу() {
        let dir = temporary_dir("symlink");
        let vault = dir.join("vault");
        let outside = dir.join("снаружи");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, vault.join("архив")).unwrap();

        // Лексическая проверка такой путь пропускает — он «внутри» строкой.
        let target = resolve_in_root(&vault, "архив/Секрет.md").expect("строкой путь валиден");

        let denied = write_atomic(&vault, &target, b"наружу")
            .expect_err("запись по симлинку наружу должна быть отвергнута");
        assert_eq!(denied.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(!outside.join("Секрет.md").exists(), "файл всё-таки уехал наружу");

        let _ = fs::remove_dir_all(&dir);
    }

    /// Симлинк, ведущий внутрь того же vault'а, остаётся разрешённым: он
    /// никуда не уводит, и запрещать его значило бы ломать рабочие раскладки.
    #[cfg(unix)]
    #[test]
    fn разрешает_симлинк_внутрь_vault() {
        let dir = temporary_dir("symlink-inside");
        let vault = dir.join("vault");
        fs::create_dir_all(vault.join("Проекты")).unwrap();
        std::os::unix::fs::symlink(vault.join("Проекты"), vault.join("Ярлык")).unwrap();

        let target = resolve_in_root(&vault, "Ярлык/Идея.md").expect("строкой путь валиден");
        write_atomic(&vault, &target, b"внутри").expect("запись по ссылке внутрь vault'а");
        assert_eq!(fs::read(vault.join("Проекты").join("Идея.md")).unwrap(), "внутри".as_bytes());

        let _ = fs::remove_dir_all(&dir);
    }
}
