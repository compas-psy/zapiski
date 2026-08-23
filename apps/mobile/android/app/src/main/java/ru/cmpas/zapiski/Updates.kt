package ru.cmpas.zapiski

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Обновление приложения (ТЗ §5.4, `docs/dev/build-and-release.md`).
 *
 * Здесь остался ТОЛЬКО опрос фида. Скачивания и установки больше нет.
 *
 * Приложение качало APK и отдавало его системному установщику, для чего в
 * манифесте стояло `REQUEST_INSTALL_PACKAGES`. Этим разрешением приложение
 * объявляет себя установщиком ДРУГИХ приложений — признак, по которому Play
 * Protect ловит дропперы, — и из-за него блокировалась КАЖДАЯ установка
 * ЗАПИСОК со вторым окном «всё равно установить». Соседние продукты на том же
 * телефоне ставятся молча.
 *
 * Теперь ссылка на APK открывается во внешнем браузере
 * (`apps/mobile/src/platform/updater.ts`), и разрешение «из неизвестных
 * источников» система спрашивает у браузера. Обновление в два тапа вместо
 * одного — несопоставимо дешевле блокировки на каждой установке.
 *
 * Почему сеть в Kotlin, а не в Rust: TLS-стек в Rust потребовал бы собирать
 * `ring`/`openssl` под NDK и утяжелил бы APK на мегабайты при бюджете <30 МБ
 * (ТЗ §6). Системный HTTP-клиент уже есть в каждом телефоне, использует
 * системное хранилище корневых сертификатов и обновляется вместе с ОС.
 *
 * **Молча ничего не происходит.** Приложение только узнаёт о новой версии;
 * что делать дальше, решает человек.
 */
object Updates {

    private const val CONNECT_TIMEOUT = 15_000
    private const val READ_TIMEOUT = 30_000

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
}
