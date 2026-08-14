package ru.cmpas.zapiski

import android.webkit.WebView
import androidx.activity.OnBackPressedCallback

/**
 * Главная активность: шаблон Tauri плюс одно наше поведение — системное
 * «назад».
 *
 * ── Зачем этот файл вообще есть ─────────────────────────────────────────────
 *
 * Шаблон `tauri android init` создаёт `class MainActivity : TauriActivity()` и
 * больше ничего. Мы кладём свой файл поверх (оверлей копирует `android/**` в
 * сгенерированный проект), потому что перехватить «назад» больше негде: у
 * `TauriActivity` стоит `handleBackNavigation = false`, то есть Tauri
 * сознательно НЕ вешает свой обработчик, а базовый `WryActivity` вешает его
 * только на историю WebView — которой у одностраничного приложения нет.
 *
 * Что видел заказчик: «системная андроидовская кнопка назад должна работать на
 * любом окне приложения. Сейчас меня перекидывает в систему, а не оставляет в
 * приложении». Так и было: жест доходил до системы как «закрыть приложение» —
 * одинаково из настроек, из заметки и из открытой библиотеки.
 *
 * ── Почему решение принимает фронтенд ───────────────────────────────────────
 *
 * Куда именно возвращаться — вопрос про экраны, а не про платформу: сперва
 * закрыть то, что лежит поверх, потом вернуться по истории экранов, потом
 * снять фильтр списка. Такой разбор живёт в `packages/app`
 * (`handleSystemBack`), а активность спрашивает его и уважает ответ: `true` —
 * шаг назад сделан внутри приложения, иначе отдаём событие системе, и она
 * уводит человека из приложения, как и положено на корневом экране
 * (ARCHITECTURE §1).
 *
 * Фронтенд может ещё не подняться (холодный старт) или ответить мусором —
 * тогда ответ не `true`, и поведение остаётся прежним, системным. Это
 * осознанно: приложение, из которого не выйти, хуже приложения, которое
 * закрывается на один жест раньше.
 */
class MainActivity : TauriActivity() {

    override fun onWebViewCreate(webView: WebView) {
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    webView.evaluateJavascript(ASK_FRONTEND) { answer ->
                        if (answer == "true") return@evaluateJavascript
                        /* Идти назад некуда — пропускаем событие дальше, к
                           системному обработчику. Себя на это время выключаем,
                           иначе диспетчер вернёт событие сюда же по кругу. */
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            },
        )
    }

    private companion object {
        /**
         * Имя функции согласовано с `apps/mobile/src/platform/back.ts` — это
         * единственные два места, где оно встречается.
         *
         * Сравнение с `true` на стороне JS, а не Kotlin: `evaluateJavascript`
         * отдаёт JSON, и «undefined» пришло бы строкой `"null"`, которую
         * легко принять за ответ.
         */
        private const val ASK_FRONTEND =
            "(typeof window.__zapiskiSystemBack === 'function'" +
                " && window.__zapiskiSystemBack() === true)"
    }
}
