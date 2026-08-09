package ru.cmpas.zapiski

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Возврат после входа (ТЗ §5.5).
 *
 * Ловит две вещи и обе кладёт в очередь:
 *
 *  * `zapiski://auth/...` — deep-link, которым сервер уводит браузер обратно
 *    в приложение (`AUTH_SUCCESS_REDIRECT`);
 *  * `https://zapiski.cmpas.ru/auth/...` и адрес самой ссылки из письма —
 *    App Links. Система открывает их в приложении, минуя браузер, но только
 *    если владение доменом подтверждено (`assetlinks.json` на сайте). Не
 *    подтверждено — откроется браузер, и путь останется прежним.
 *
 * Активность невидима и живёт миллисекунды: она не решает ничего, только
 * передаёт адрес приложению (ARCHITECTURE §1). Разбирает адрес и обменивает
 * токен `packages/app` — там же, где это делается для веба и Windows.
 *
 * Своя активность, а не `intent-filter` на главной, — по той же причине, что
 * и у share-target: ссылка приходит и когда приложения нет в памяти, и очередь
 * переживает холодный старт.
 */
class AuthActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            accept(intent)
        } catch (error: Throwable) {
            // Intent приходит извне: что угодно в нём может быть неожиданным.
            // Падать нельзя — просто ничего не принимаем.
        }
        finish()
    }

    private fun accept(source: Intent?) {
        if (source == null || source.action != Intent.ACTION_VIEW) return
        val url = source.data?.toString().orEmpty()
        // Адрес в журнал не пишется никогда: во фрагменте едет токен сессии.
        if (url.isEmpty()) return

        Inbox.putAuth(this, url)
        Inbox.launchApp(this)
    }
}
