// Консольное окно рядом с приложением в релизной сборке под Windows не нужно.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    zapiski_desktop_lib::run()
}
