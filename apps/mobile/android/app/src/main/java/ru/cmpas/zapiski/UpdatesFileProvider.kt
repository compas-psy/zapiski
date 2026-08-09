package ru.cmpas.zapiski

import androidx.core.content.FileProvider

/**
 * Свой FileProvider — только для передачи скачанного APK системному установщику.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ КЛАСС, А НЕ androidx.core.content.FileProvider НАПРЯМУЮ
 *
 * Шаблон Tauri уже объявляет провайдер с `android:name` равным
 * `androidx.core.content.FileProvider`. Второе объявление с тем же именем —
 * это ошибка сборки: манифест-мержер отвечает «Element provider#… duplicated».
 *
 * Напрашивающееся решение — слить оба объявления в одно, перечислив authorities
 * через `;`. Оно собирается, но **расширяет область доступа**: у шаблона в путях
 * стоят `<external-path path="."/>` и `<cache-path path="."/>`, то есть внешний
 * каталог и кеш приложения целиком. Слияние отдало бы установщику доступ ко
 * всему этому вместо одного каталога с APK.
 *
 * Подкласс решает обе задачи разом: `android:name` другой, значит конфликта нет,
 * а `@xml/file_provider_paths` остаётся своим — ровно `cache/updates`.
 *
 * Реализации не требуется: вся работа в базовом классе.
 */
class UpdatesFileProvider : FileProvider(R.xml.file_provider_paths)
