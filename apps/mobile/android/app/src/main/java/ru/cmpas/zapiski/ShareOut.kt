package ru.cmpas.zapiski

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent

/**
 * Отдать текст заметки системному «Поделиться».
 *
 * Обратная сторона `ShareActivity`: та принимает чужое, эта отдаёт своё.
 *
 * ── Почему три попытки, а не одна ───────────────────────────────────────────
 *
 * Первая версия звала `startActivity` от контекста приложения и возвращала
 * `false` на любую беду. На устройстве заказчика это дало тост «некому
 * передать заметку — ни одно приложение не принимает текст», который был
 * неправдой: приложений там полно. Что произошло на самом деле, узнать было
 * НЕЛЬЗЯ — причина стиралась на месте.
 *
 * Теперь порядок такой:
 *
 *   1. активность, если она жива, — так системное окно поднимается поверх
 *      приложения, и это единственный путь, который прошивки не режут;
 *   2. контекст приложения с `FLAG_ACTIVITY_NEW_TASK` — запасной, на случай
 *      когда активность уже свёрнута;
 *   3. буфер обмена — когда чужого окна не случилось вовсе. Текст у человека
 *      в руках, вставить его можно куда угодно; это хуже, чем чузер, но
 *      несравнимо лучше, чем ничего.
 *
 * Возвращается СТРОКА, а не `Boolean`: `shared`, `copied` или текст ошибки.
 * Приложение показывает разное сообщение на разный исход — и никогда не
 * называет причину, которой не знает.
 */
object ShareOut {

    /** Что случилось: `shared` — открылось окно, `copied` — легло в буфер. */
    fun text(context: Context, activity: Activity?, title: String?, body: String): String {
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
           а мы скажем, что произошло именно это. */
        return try {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText(label ?: "", body))
            "copied"
        } catch (error: Throwable) {
            /* Уже совсем ничего. Текст ошибки уходит наверх и показывается
               человеку: пусть лучше он увидит непонятные слова системы, чем
               наше уверенное и ложное объяснение. */
            val reason = failure ?: error
            "error: ${reason.javaClass.simpleName}: ${reason.message ?: "без пояснения"}"
        }
    }
}
