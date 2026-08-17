//! Байты из тела IPC-запроса — каким бы путём они ни приехали.
//!
//! ── Почему это не одна строка `InvokeBody::Raw` ─────────────────────────────
//!
//! Документация Tauri («Accessing Raw Request») говорит: пошлите с фронтенда
//! `Uint8Array`, примите в команде `tauri::ipc::Request` и разберите
//! `InvokeBody::Raw`. Ровно так у нас и было написано.
//!
//! На Android это не работает НИКОГДА. В транспорте Tauri
//! (`tauri/scripts/ipc-protocol.js`) стоит:
//!
//! ```js
//! // on Android we never use it because Android does not have support to reading the request body
//! const canUseCustomProtocol = osName !== 'android'
//! ```
//!
//! То есть на Android запрос уходит не POST-ом по своему протоколу, а через
//! `window.ipc.postMessage`, где всё сообщение целиком проходит через
//! `JSON.stringify`. Сериализатор Tauri превращает `Uint8Array` в
//! `Array.from(val)` — массив чисел. До команды доезжает `InvokeBody::Json`,
//! и проверка «тело должно быть бинарным» отвергает СВОИ ЖЕ данные.
//!
//! Цена ошибки была полной: `vault_write_atomic`, `saf_write` и `save_file` —
//! то есть сохранение заметки в каталог приложения, сохранение в выбранную
//! папку и экспорт файла — не могли отработать ни разу. В документации об
//! этом ограничении нет ни слова; оно есть только в исходнике транспорта.
//!
//! ── Что делаем ──────────────────────────────────────────────────────────────
//!
//! Принимаем оба вида тела:
//!
//!   · `Raw` — путь своего протокола (Windows, iOS, дев-сборка в браузере);
//!   · `Json({ "data": "<base64>" })` — так шлёт оболочка Android
//!     (`platform/ipc.ts`). На массиве чисел «[255,216,…]» вложение в 3 МБ
//!     превращается в строку на ~12 МБ и в вектор из трёх миллионов
//!     `serde_json::Value` — это десятки мегабайт кучи на телефоне. base64
//!     даёт 1.33× и один разбор строки. Объект, а не голая строка, потому что
//!     тип `InvokeArgs` в `@tauri-apps/api` строку не принимает;
//!   · `Json("<base64>")` — та же строка без обёртки, на случай другого
//!     вызывающего;
//!   · `Json([255, 216, …])` — массив чисел. Оставлен нарочно: так тело
//!     выглядит, если его послали штатным способом из документации, и
//!     отвергать его во второй раз было бы повторением той же ошибки.

use std::borrow::Cow;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request};

/// Поле с байтами у тела-объекта. То же имя пишет `platform/ipc.ts`.
const BODY_KEY: &str = "data";

/// Байты тела запроса. Заимствуются, если приехали сырыми, — лишней копии на
/// вложении в несколько мегабайт быть не должно.
pub fn request_bytes<'a>(request: &'a Request<'_>) -> Result<Cow<'a, [u8]>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes.as_slice())),
        InvokeBody::Json(value) => decode_json_body(value).map(Cow::Owned),
    }
}

/// Тело, приехавшее JSON-ом: строка base64 или массив байтов.
pub(crate) fn decode_json_body(value: &Value) -> Result<Vec<u8>, String> {
    match value {
        Value::String(encoded) => STANDARD
            .decode(encoded)
            .map_err(|error| format!("тело запроса не разбирается как base64: {error}")),
        Value::Array(items) => {
            let mut bytes = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let number = item
                    .as_u64()
                    .ok_or_else(|| format!("в теле запроса не байт на позиции {index}"))?;
                bytes.push(u8::try_from(number).map_err(|_| {
                    format!("в теле запроса число {number} на позиции {index} — не байт")
                })?);
            }
            Ok(bytes)
        }
        Value::Object(fields) => {
            let inner = fields.get(BODY_KEY).ok_or_else(|| {
                format!(
                    "в теле запроса нет поля «{BODY_KEY}»; есть: {}",
                    fields.keys().cloned().collect::<Vec<_>>().join(", ")
                )
            })?;
            decode_json_body(inner)
        }
        /* Диагностика называет то, что реально приехало: «тело должно быть
        бинарным» не помогло ни разу — из него не видно, чем оно было. */
        other => Err(format!(
            "тело запроса не байты: {}",
            match other {
                Value::Null => "null",
                Value::Bool(_) => "логическое значение",
                Value::Number(_) => "число",
                Value::String(_) | Value::Array(_) | Value::Object(_) =>
                    unreachable!("разобраны выше"),
            }
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn принимает_base64() {
        let value = Value::String(STANDARD.encode("Идея.md"));
        assert_eq!(decode_json_body(&value).unwrap(), "Идея.md".as_bytes());
    }

    #[test]
    fn принимает_массив_байтов() {
        /* Ровно так `JSON.stringify` сериализует `Uint8Array` в транспорте
        Tauri: `Array.from(val)`. */
        let value: Value = serde_json::from_str("[208,152,208,180,208,181,209,143]").unwrap();
        assert_eq!(decode_json_body(&value).unwrap(), "Идея".as_bytes());
    }

    #[test]
    fn пустое_тело_это_пустые_байты() {
        /* Пустая заметка — обычное дело, и она обязана сохраняться. */
        assert!(decode_json_body(&Value::String(String::new()))
            .unwrap()
            .is_empty());
        assert!(decode_json_body(&serde_json::from_str("[]").unwrap())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn принимает_объект_оболочки_android() {
        /* Ровно то, что кладёт `callRaw` в `platform/ipc.ts`. */
        let value: Value =
            serde_json::json!({ BODY_KEY: STANDARD.encode("# Заголовок\n\nтекст") });
        assert_eq!(
            decode_json_body(&value).unwrap(),
            "# Заголовок\n\nтекст".as_bytes()
        );
    }

    #[test]
    fn отвергает_не_байты_и_называет_причину() {
        let object: Value = serde_json::from_str(r#"{"0":1}"#).unwrap();
        let message = decode_json_body(&object).unwrap_err();
        assert!(
            message.contains(BODY_KEY) && message.contains('0'),
            "непонятная причина: {message}",
        );

        let big: Value = serde_json::from_str("[256]").unwrap();
        assert!(decode_json_body(&big).unwrap_err().contains("не байт"));

        let signed: Value = serde_json::from_str("[-1]").unwrap();
        assert!(decode_json_body(&signed).unwrap_err().contains("не байт"));
    }
}
