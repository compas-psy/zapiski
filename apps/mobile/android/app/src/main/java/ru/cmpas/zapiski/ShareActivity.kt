package ru.cmpas.zapiski

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
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
        val directory = File(cacheDir, "share").apply { mkdirs() }
        val target = File(directory, "share-${System.currentTimeMillis()}-${uri.hashCode()}.bin")

        val copied = try {
            contentResolver.openInputStream(uri)?.use { input ->
                target.outputStream().use { output -> input.copyTo(output) }
            } != null
        } catch (error: Throwable) {
            false
        }
        if (!copied) return null

        val mime = contentResolver.getType(uri) ?: type
        return JSONObject().apply {
            put("kind", "image")
            put("path", target.absolutePath)
            put("mime", mime)
        }
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
