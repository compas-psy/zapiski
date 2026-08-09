//! Виджеты рабочего стола и плитка Quick Settings — половина оболочки
//! (BEHAVIOR §8).
//!
//! Обмен данными устроен через два файла в приватном каталоге приложения:
//!
//! * `widgets/snapshot.json` — что показывать. Пишет приложение (команда
//!   `widgets_publish`), читают Kotlin-провайдеры. Запись атомарна: виджет,
//!   прочитавший половину файла, показал бы обрезанный заголовок.
//! * `widgets/commands.jsonl` — что пользователь сделал в виджете. Пишет
//!   Kotlin построчно (одна команда — одна строка), забирает приложение.
//!
//! Почему очередь именно файлом: тап по чекбоксу возможен, когда приложения в
//! памяти нет вообще. Файл переживает и это, и перезагрузку телефона.
//!
//! Гарантия «ровно один раз»: очередь всегда забирается через `rename` —
//! Kotlin в этот момент начинает писать в новый файл, а прочитанное уже
//! никому не достанется повторно. Поэтому событие фронтенду и команда
//! `widgets_take_commands` не могут выдать одну и ту же отметку дважды.
//!
//! ⚠️ **Последняя миля упирается в контракт.** В `AppHost`
//! (`packages/app/src/contract.ts`) порта виджетов нет, поэтому позвать
//! `widgets_publish` приложению пока нечем. Оболочка делает свою половину:
//! механизм, формат и перерисовка готовы. Вторая половина — поле в `AppHost`
//! (ARCHITECTURE §1: «не хватает порта — добавляется порт, а не экран»).
//! Собирать содержимое виджета в оболочке нельзя: заголовок заметки, порядок
//! «последних» и разбор чекбоксов — продуктовая логика, она живёт в ядре.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Событие «пользователь что-то сделал в виджете».
/// Используется только Android-веткой (`android.rs`): под linux крейт
/// собирается ради проверки компиляции, и до этих точек дело не доходит.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub const EVENT_WIDGET_COMMAND: &str = "zapiski://widget-command";

const DIR: &str = "widgets";
const SNAPSHOT: &str = "snapshot.json";
const COMMANDS: &str = "commands.jsonl";
const TAKEN: &str = "commands.taken.jsonl";

/// Забор очереди — операция «прочитать и опустошить», её нельзя выполнять
/// двумя потоками одновременно.
static DRAIN_LOCK: Mutex<()> = Mutex::new(());

/// Команда из виджета. Пока это только отметка чекбокса (§8).
#[derive(Serialize, Deserialize, Clone)]
pub struct WidgetCommand {
    pub kind: String,
    #[serde(rename = "noteId")]
    pub note_id: String,
    #[serde(rename = "todoIndex")]
    pub todo_index: u32,
    pub checked: bool,
    /// Момент нажатия, миллисекунды epoch: команда могла пролежать в очереди.
    pub at: i64,
}

fn widgets_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = crate::android::files_dir()
        .ok()
        .flatten()
        .map(PathBuf::from)
        .or_else(|| app.path().app_data_dir().ok())
        .ok_or_else(|| "не удалось определить каталог приложения".to_owned())?;
    Ok(base.join(DIR))
}

/// Отдать виджетам новое состояние и перерисовать их.
///
/// Перерисовка идёт **по изменению данных, а не по таймеру** — прямое
/// требование §8: виджет, который просыпается раз в полчаса, показывает
/// вчерашние заметки и тратит батарею.
#[tauri::command(async)]
pub fn widgets_publish<R: Runtime>(
    app: AppHandle<R>,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    if !snapshot.is_object() {
        return Err("снимок виджетов должен быть объектом".to_owned());
    }

    let directory = widgets_dir(&app)?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("{}: {error}", directory.display()))?;

    let target = directory.join(SNAPSHOT);
    let body = serde_json::to_vec(&snapshot)
        .map_err(|error| format!("снимок не сериализуется: {error}"))?;
    crate::vault::write_atomic(&target, &body)
        .map_err(|error| format!("{}: {error}", target.display()))?;

    // Не удалось перерисовать — данные всё равно записаны, и следующий раз
    // виджет прочитает их сам. Поэтому ошибка моста здесь не фатальна.
    let _ = crate::android::refresh_widgets();
    Ok(())
}

/// Забрать накопившиеся команды из виджетов.
#[tauri::command(async)]
pub fn widgets_take_commands<R: Runtime>(app: AppHandle<R>) -> Vec<WidgetCommand> {
    widgets_dir(&app).map(|dir| drain(&dir)).unwrap_or_default()
}

/// Kotlin сообщил, что в очереди что-то появилось. Забираем и отправляем
/// фронтенду — приложение работает, значит, отметка применится сразу.
/// Используется только Android-веткой (`android.rs`): под linux крейт
/// собирается ради проверки компиляции, и до этих точек дело не доходит.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn poke() {
    let Some(handle) = crate::platform::app_handle() else {
        return;
    };
    let Ok(directory) = widgets_dir(&handle) else {
        return;
    };
    for command in drain(&directory) {
        let _ = handle.emit(EVENT_WIDGET_COMMAND, command);
    }
}

/// Прочитать очередь и опустошить её.
fn drain(directory: &PathBuf) -> Vec<WidgetCommand> {
    let _guard = DRAIN_LOCK.lock();

    let queue = directory.join(COMMANDS);
    let taken = directory.join(TAKEN);

    // Забираем файл переименованием: Kotlin с этого момента пишет в новый,
    // и ни одна команда не потеряется между чтением и удалением.
    if std::fs::rename(&queue, &taken).is_err() {
        return Vec::new();
    }
    let content = std::fs::read_to_string(&taken).unwrap_or_default();
    let _ = std::fs::remove_file(&taken);

    parse_queue(&content)
}

/// Разбор JSONL. Битая строка пропускается: очередь пишет другой процесс,
/// который мог быть убит на середине строки.
fn parse_queue(content: &str) -> Vec<WidgetCommand> {
    content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<WidgetCommand>(line).ok())
        .filter(|command| command.kind == "toggle-todo")
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn разбирает_очередь_и_пропускает_обрывки() {
        let content = concat!(
            r#"{"kind":"toggle-todo","noteId":"n1","todoIndex":0,"checked":true,"at":1}"#,
            "\n",
            // Обрыв записи: процесс убили на середине строки.
            r#"{"kind":"toggle-todo","noteId":"n2","todoInd"#,
            "\n",
            // Чужая команда неизвестного вида — игнорируем, а не гадаем.
            r#"{"kind":"burn-vault","noteId":"n3","todoIndex":0,"checked":true,"at":2}"#,
            "\n",
            r#"{"kind":"toggle-todo","noteId":"n4","todoIndex":3,"checked":false,"at":4}"#,
            "\n",
        );

        let commands = parse_queue(content);
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].note_id, "n1");
        assert!(commands[0].checked);
        assert_eq!(commands[1].note_id, "n4");
        assert_eq!(commands[1].todo_index, 3);
    }
}
