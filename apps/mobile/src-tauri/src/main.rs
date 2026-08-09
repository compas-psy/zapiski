// На Android точкой входа служит библиотека (`tauri::mobile_entry_point`),
// а этот бинарь нужен, чтобы крейт собирался и проверялся на хосте.
fn main() {
    zapiski_mobile_lib::run()
}
