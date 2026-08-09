package ru.cmpas.zapiski

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Обновление приложения (ТЗ §5.4, `docs/dev/build-and-release.md`).
 *
 * Почему не встроенный апдейтер Tauri: на Android его нет — там нет ни
 * установщика, ни проверки подписи движком. Поэтому используются штатные
 * средства платформы: `HttpsURLConnection` для фида и загрузки, `FileProvider`
 * и системный установщик пакетов для установки.
 *
 * Почему сеть в Kotlin, а не в Rust: TLS-стек в Rust потребовал бы собирать
 * `ring`/`openssl` под NDK и утяжелил бы APK на мегабайты при бюджете <30 МБ
 * (ТЗ §6). Системный HTTP-клиент уже есть в каждом телефоне, использует
 * системное хранилище корневых сертификатов и обновляется вместе с ОС.
 *
 * **Молча ничего не ставится.** Экран подтверждения показывает сам Android, а
 * решение начать скачивание принимает пользователь в приложении.
 */
object Updates {

    private const val CONNECT_TIMEOUT = 15_000
    private const val READ_TIMEOUT = 30_000
    private const val BUFFER = 64 * 1024
    private const val APK_MIME = "application/vnd.android.package-archive"

    /**
     * GET, завёрнутый в JSON-конверт: `{"status":…,"body":…}` либо
     * `{"status":0,"error":…}`. Так Rust отличает «обновления нет» (204) от
     * «сеть недоступна» — а это два разных поведения в UI (BEHAVIOR §11).
     */
    fun httpGet(url: String): String {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = CONNECT_TIMEOUT
                readTimeout = READ_TIMEOUT
                setRequestProperty("Accept", "application/json")
            }
            val status = connection.responseCode
            val body = if (status in 200..299) {
                connection.inputStream.bufferedReader().use { it.readText() }
            } else {
                ""
            }
            JSONObject().put("status", status).put("body", body).toString()
        } catch (error: Throwable) {
            // Оффлайн — обычное состояние мобильного приложения, а не сбой.
            JSONObject()
                .put("status", 0)
                .put("error", error.message ?: "сеть недоступна")
                .toString()
        } finally {
            connection?.disconnect()
        }
    }

    /**
     * Скачать APK с прогрессом. Файл пишется во временный и переименовывается:
     * оборванная загрузка не должна выглядеть как готовый пакет.
     */
    fun download(requestId: Long, url: String, destination: String) {
        var connection: HttpURLConnection? = null
        val target = File(destination)
        val partial = File("$destination.part")
        try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = CONNECT_TIMEOUT
                readTimeout = READ_TIMEOUT
            }
            val status = connection.responseCode
            if (status !in 200..299) {
                NativeBridge.result(requestId, false, "сервер обновлений ответил $status", null)
                return
            }

            val total = connection.contentLengthLong
            var done = 0L
            var lastReported = 0L

            partial.parentFile?.mkdirs()
            connection.inputStream.use { input ->
                partial.outputStream().use { output ->
                    val buffer = ByteArray(BUFFER)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        done += read
                        // Прогресс раз в ~1%, а не на каждый килобайт: иначе
                        // JNI-вызовы съедят больше, чем сама загрузка.
                        if (total <= 0 || done - lastReported >= total / 100 + 1) {
                            lastReported = done
                            NativeBridge.progress(requestId, done, total)
                        }
                    }
                    output.flush()
                }
            }

            if (!partial.renameTo(target)) {
                partial.delete()
                NativeBridge.result(requestId, false, "не удалось сохранить пакет", null)
                return
            }
            NativeBridge.progress(requestId, done, if (total > 0) total else done)
            NativeBridge.result(requestId, true, target.absolutePath, null)
        } catch (error: Throwable) {
            partial.delete()
            NativeBridge.result(requestId, false, error.message ?: "не удалось скачать обновление", null)
        } finally {
            connection?.disconnect()
        }
    }

    /**
     * Отдать пакет системному установщику.
     *
     * Разрешение `REQUEST_INSTALL_PACKAGES` объявлено в манифесте, но на
     * Android 8+ его ещё нужно подтвердить в настройках — до подтверждения
     * система молча откажет. Поэтому, если разрешения нет, открываем нужный
     * экран настроек: пользователь видит, чего от него хотят, а не «ничего не
     * произошло».
     */
    fun install(context: Context, path: String) {
        val file = File(path)
        if (!file.exists()) return

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !context.packageManager.canRequestPackageInstalls()
        ) {
            val settings = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(settings)
            return
        }

        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, APK_MIME)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }
}
