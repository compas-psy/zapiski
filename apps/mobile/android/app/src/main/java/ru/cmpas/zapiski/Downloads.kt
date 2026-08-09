package ru.cmpas.zapiski

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/**
 * Экспорт файла пользователю (BEHAVIOR §9): md, zip, html, docx, PDF.
 *
 * Android 10 и новее: запись в «Загрузки» через MediaStore — без единого
 * разрешения. `WRITE_EXTERNAL_STORAGE` не запрашивается принципиально: оно
 * даёт доступ ко всей памяти устройства ради одного файла.
 *
 * Android 9 и старше: MediaStore для «Загрузок» там ещё нет, а публичный
 * каталог требует того самого разрешения. Поэтому файл ложится в каталог
 * приложения во внешней памяти — рядом с vault'ом, откуда его видно с
 * компьютера по USB. Это честное различие поведения на старых версиях, а не
 * молчаливый отказ.
 */
object Downloads {

    /** `null` — получилось; строка — текст ошибки для Rust. */
    fun save(context: Context, name: String, mime: String, sourcePath: String): String? {
        val source = File(sourcePath)
        if (!source.exists()) return "нечего сохранять: файл не найден"

        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveViaMediaStore(context, name, mime, source)
            } else {
                saveToAppDirectory(context, name, source)
            }
        } catch (error: Throwable) {
            error.message ?: "не удалось сохранить файл"
        }
    }

    private fun saveViaMediaStore(context: Context, name: String, mime: String, source: File): String? {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            // Пока файл не дописан, он не виден другим приложениям: половина
            // экспортированного архива никому не нужна.
            put(MediaStore.Downloads.IS_PENDING, 1)
        }

        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: return "«Загрузки» недоступны"

        return try {
            resolver.openOutputStream(uri)?.use { output ->
                source.inputStream().use { input -> input.copyTo(output) }
            } ?: return "не удалось открыть файл для записи"

            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            null
        } catch (error: Throwable) {
            resolver.delete(uri, null, null)
            error.message ?: "не удалось сохранить файл"
        }
    }

    private fun saveToAppDirectory(context: Context, name: String, source: File): String? {
        val directory = context.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS)
            ?: return "внешняя память недоступна"
        directory.mkdirs()
        source.copyTo(File(directory, name), overwrite = true)
        return null
    }
}
