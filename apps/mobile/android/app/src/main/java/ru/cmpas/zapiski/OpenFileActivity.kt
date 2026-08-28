package ru.cmpas.zapiski

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import java.io.File

/**
 * Ассоциация `.md`: «Открыть с помощью» из файлового менеджера (ТЗ §5.4).
 *
 * Своя невидимая активность, а не intent-filter на `MainActivity`, — тот же
 * приём и по той же причине, что у `ShareActivity`: переопределять
 * сгенерированную Tauri `MainActivity` значило бы форкать её шаблон, а
 * очередь должна доставить путь и после того, как систем убила процесс
 * приложения между выбором файла и запуском.
 *
 * В отличие от `ShareActivity`, здесь не готовый payload заметки, а СЫРОЙ
 * файл: `AppIntent.open-file` только называет путь, а куда его положить,
 * решает диалог выбора папки в `packages/app` (тот же диалог, что и у
 * ассоциации на Windows) — не эта активность.
 */
class OpenFileActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            accept(intent)
        } catch (error: Throwable) {
            // Intent пришёл от чужого приложения — падать нельзя.
        }
        finish()
    }

    private fun accept(source: Intent?) {
        val uri = source?.data ?: return
        val name = displayName(uri) ?: uri.lastPathSegment ?: return
        /*
         * Манифест ловит `.md` и по расширению независимо от заявленного
         * типа (стоковый Android не знает MIME markdown), и по нескольким
         * явно названным типам — оба пути сюда могут привести чужой файл.
         * Решает имя: чужое расширение молча пропускаем, как и в
         * `ShareActivity`.
         */
        val lower = name.lowercase()
        if (!lower.endsWith(".md") && !lower.endsWith(".markdown")) return

        val target = stage(uri, name) ?: return
        Inbox.putOpenFile(this, target.absolutePath)
        Inbox.launchApp(this)
    }

    /**
     * Байты копируются в ПРИВАТНЫЙ каталог приложения, а не в кэш: файл
     * читает `AppHost.readOpenedFile` уже после того, как человек выбрал
     * папку в диалоге, и это может занять время — система не обязана
     * сохранить кэш нетронутым до тех пор.
     *
     * Своя подпапка на файл, а не общий каталог: путь для `AppIntent.open-
     * file` — это и есть будущее имя заметки (`App.tsx` берёт его от
     * последнего сегмента пути), и таймстамп в имени файла испортил бы его.
     */
    private fun stage(uri: Uri, name: String): File? {
        val directory = File(filesDir, "inbox/incoming/${System.currentTimeMillis()}-${uri.hashCode()}")
            .apply { mkdirs() }
        val target = File(directory, name)
        val copied = try {
            contentResolver.openInputStream(uri)?.use { input ->
                target.outputStream().use { output -> input.copyTo(output) }
            } != null
        } catch (error: Throwable) {
            false
        }
        return if (copied) target else null
    }

    private fun displayName(uri: Uri): String? =
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (!cursor.moveToFirst()) return@use null
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0) cursor.getString(index) else null
            }
        } catch (error: Throwable) {
            null
        }
}
