package ru.cmpas.zapiski

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Отдать текст заметки системному «Поделиться».
 *
 * Обратная сторона `ShareActivity`: та принимает чужое, эта отдаёт своё.
 *
 * ── Две попытки, два разных отказа ──────────────────────────────────────────
 *
 * Первая версия звала `startActivity` от контекста приложения и возвращала
 * `false` на любую беду. На устройстве это дало тост «ни одно приложение не
 * принимает текст» — неправду: приложений там полно, а причина стиралась.
 *
 * Вторая версия научилась называть причину и получила от заказчика ответ
 * «Java-сторона завершилась исключением». То есть исключение улетало В JNI,
 * а не обрабатывалось здесь. Отсюда правило этого файла:
 *
 *   1. **всё делается на главном потоке.** Команда Tauri выполняется в пуле,
 *      а `startActivity` и буфер обмена — вещи UI-потока: Android имеет право
 *      отказать вызову из чужого потока, и отказывает;
 *   2. **наружу не улетает ни одно исключение.** Java обязана вернуть строку
 *      при любом исходе, иначе мост отвечает «Java-сторона завершилась
 *      исключением» — фраза, по которой чинить нечего.
 *
 * Порядок попыток: активность (её прошивки режут реже всего), затем контекст
 * приложения с `FLAG_ACTIVITY_NEW_TASK`, затем буфер обмена — текст у человека
 * в руках, вставить можно куда угодно. Это хуже чузера и несравнимо лучше
 * пустоты.
 */
object ShareOut {

    /** Сколько ждём главный поток. Он занят разве что кадром анимации. */
    private const val UI_TIMEOUT_SECONDS = 5L

    /** Что случилось: `shared` — открылось окно, `copied` — легло в буфер. */
    fun text(context: Context, activity: Activity?, title: String?, body: String): String =
        onMainThread { attempt(context, activity, title, body) }

    /**
     * Выполнить на главном потоке и дождаться ответа.
     *
     * Если мы уже на нём — просто выполняем: лишний `post` отложил бы работу
     * на следующий кадр без всякой пользы.
     */
    private fun onMainThread(work: () -> String): String {
        if (Looper.myLooper() == Looper.getMainLooper()) return work()

        var answer = "error: главный поток не ответил за ${UI_TIMEOUT_SECONDS} с"
        val done = CountDownLatch(1)
        Handler(Looper.getMainLooper()).post {
            answer = try {
                work()
            } catch (error: Throwable) {
                describe(error)
            } finally {
                done.countDown()
            }
        }
        return try {
            if (done.await(UI_TIMEOUT_SECONDS, TimeUnit.SECONDS)) answer else answer
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            describe(error)
        }
    }

    private fun attempt(context: Context, activity: Activity?, title: String?, body: String): String {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, body)
            /* Тема — для почты и мессенджеров, которые её показывают. Пустое
               название не подставляем: «Без названия» в теме письма выглядит
               как ошибка отправителя, а не как отсутствие заголовка. */
            if (!title.isNullOrBlank()) putExtra(Intent.EXTRA_SUBJECT, title)
        }
        /* `createChooser` вместо голого `ACTION_SEND` намеренно: без него
           Android молча отправит в приложение, выбранное «по умолчанию»
           когда-то раньше, и человек не поймёт, куда делась заметка. */
        val label = if (title.isNullOrBlank()) null else title
        var failure: Throwable? = null

        if (activity != null && !activity.isFinishing) {
            try {
                activity.startActivity(Intent.createChooser(send, label))
                return "shared"
            } catch (error: Throwable) {
                failure = error
            }
        }

        try {
            val chooser = Intent.createChooser(send, label).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(chooser)
            return "shared"
        } catch (error: Throwable) {
            failure = error
        }

        /* Окно не поднялось. Заметку человек всё равно получит — через буфер,
           и мы скажем, что произошло именно это. */
        return try {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText(label ?: "", body))
            "copied"
        } catch (error: Throwable) {
            /* Уже совсем ничего. Текст ошибки уходит наверх и показывается
               человеку: пусть лучше он увидит непонятные слова системы, чем
               наше уверенное и ложное объяснение. */
            describe(failure ?: error)
        }
    }

    private fun describe(error: Throwable): String =
        "error: ${error.javaClass.simpleName}: ${error.message ?: "без пояснения"}"
}
