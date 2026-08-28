package ru.cmpas.zapiski

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Patterns
import org.json.JSONObject
import java.io.File

/**
 * Приёмник системного «Поделиться» (BEHAVIOR §8).
 *
 * Своя активность, а не `intent-filter` на главной, по двум причинам:
 *
 *  * она невидима (`Theme.NoDisplay`) и живёт миллисекунды — пользователь не
 *    видит вспышки приложения поверх того, чем он делится;
 *  * она работает одинаково и когда приложение запущено, и когда его нет в
 *    памяти: payload всегда ложится в очередь, а `packages/app` разбирает его,
 *    когда доберётся.
 *
 * Здесь нет ни одного элемента интерфейса. Модалку с превью и выбором папки
 * (§8) рисует приложение — это продуктовый экран, ему место в `packages/app`.
 */
class ShareActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            accept(intent)
        } catch (error: Throwable) {
            // Intent пришёл от чужого приложения: что угодно внутри него может
            // быть неожиданным. Падать нельзя — просто ничего не принимаем.
        }
        finish()
    }

    private fun accept(source: Intent?) {
        if (source == null) return
        val payloads = when (source.action) {
            Intent.ACTION_SEND -> listOfNotNull(single(source))
            Intent.ACTION_SEND_MULTIPLE -> multiple(source)
            else -> emptyList()
        }
        if (payloads.isEmpty()) return

        for (payload in payloads) Inbox.putShare(this, payload)
        Inbox.launchApp(this)
    }

    private fun single(source: Intent): JSONObject? {
        val type = source.type.orEmpty()
        if (type.startsWith("image/")) {
            val uri = uriExtra(source, Intent.EXTRA_STREAM) ?: return null
            return image(uri, type)
        }

        /*
         * Файл, а не текст: Telegram и подобные шлют документ через
         * EXTRA_STREAM, а не EXTRA_TEXT, независимо от заявленного типа
         * (заказчик: «в Telegram прислали .md файл → поделиться»). Проверяем
         * EXTRA_STREAM раньше EXTRA_TEXT — иначе файл молча провалился бы в
         * «нет EXTRA_TEXT → ничего не приняли», как было до этой правки.
         */
        val streamUri = uriExtra(source, Intent.EXTRA_STREAM)
        if (streamUri != null) return markdownFile(streamUri)

        val text = source.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: return null
        val subject = source.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()
        return text(text, subject)
    }

    private fun multiple(source: Intent): List<JSONObject> {
        val type = source.type.orEmpty()
        if (!type.startsWith("image/")) return emptyList()
        val uris = urisExtra(source) ?: return emptyList()
        return uris.mapNotNull { image(it, type) }
    }

    /**
     * Текст или ссылка. Различие — свойство содержимого, а не intent'а:
     * «поделиться ссылкой» приходит тем же `text/plain`.
     *
     * Заголовок (`EXTRA_SUBJECT`) браузеры кладут рядом со ссылкой; он
     * пригодится приложению, чтобы собрать `[заголовок](url)` без похода в
     * сеть (§8).
     */
    private fun text(value: String, subject: String?): JSONObject {
        val trimmed = value.trim()
        val isLink = trimmed.isNotEmpty() &&
            !trimmed.contains(' ') &&
            Patterns.WEB_URL.matcher(trimmed).matches()

        return JSONObject().apply {
            put("kind", if (isLink) "link" else "text")
            if (isLink) {
                put("url", trimmed)
                if (!subject.isNullOrBlank()) put("text", subject)
            } else {
                put("text", value)
            }
        }
    }

    /**
     * Картинка. Байты копируются в кэш и передаются путём: `content://` живёт
     * ровно столько, сколько живёт эта активность, а приложение прочитает
     * payload позже — возможно, после перезапуска.
     */
    private fun image(uri: Uri, type: String): JSONObject? {
        val target = stage(uri) ?: return null
        val mime = contentResolver.getType(uri) ?: type
        return JSONObject().apply {
            put("kind", "image")
            put("path", target.absolutePath)
            put("mime", mime)
        }
    }

    /**
     * Файл `.md`, пришедший через «Поделиться» (ТЗ §5.4, BEHAVIOR §8).
     *
     * Решает ИМЯ файла, а не `intent.type`: тип, который сообщает
     * отправитель, для `.md` не стандартизован — `text/plain` и
     * `application/octet-stream` встречаются одинаково часто, — а имя не
     * подделаешь и без него. Незнакомое расширение молча пропускаем, как и
     * раньше пропускался любой непонятный `intent` (чужое приложение — веры
     * ему нет).
     *
     * Тот же payload, что и у ассоциации на Windows (`packages/core`
     * `SharedPayload.kind === 'file'`): `path` ведёт на временную копию,
     * `name` — исходное имя для заголовка заметки после импорта.
     */
    private fun markdownFile(uri: Uri): JSONObject? {
        val name = displayName(uri) ?: return null
        val lower = name.lowercase()
        if (!lower.endsWith(".md") && !lower.endsWith(".markdown")) return null

        val target = stage(uri) ?: return null
        return JSONObject().apply {
            put("kind", "file")
            put("name", name)
            put("path", target.absolutePath)
        }
    }

    /** Скопировать байты `content://` во временный файл кэша. */
    private fun stage(uri: Uri): File? {
        val directory = File(cacheDir, "share").apply { mkdirs() }
        val target = File(directory, "share-${System.currentTimeMillis()}-${uri.hashCode()}.bin")
        val copied = try {
            contentResolver.openInputStream(uri)?.use { input ->
                target.outputStream().use { output -> input.copyTo(output) }
            } != null
        } catch (error: Throwable) {
            false
        }
        return if (copied) target else null
    }

    /** Настоящее имя файла за `content://` — ContentResolver его знает, Uri почти никогда. */
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

    private fun uriExtra(source: Intent, name: String): Uri? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            source.getParcelableExtra(name, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            source.getParcelableExtra(name)
        }

    private fun urisExtra(source: Intent): List<Uri>? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            source.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            source.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
        }
}
