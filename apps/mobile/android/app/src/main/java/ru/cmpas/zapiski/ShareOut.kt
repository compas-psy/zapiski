package ru.cmpas.zapiski

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Отдать заметку системному «Поделиться» — текстом и картинками.
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
    fun text(
        context: Context,
        activity: Activity?,
        title: String?,
        body: String,
        files: List<String> = emptyList(),
        mimes: List<String> = emptyList(),
    ): String = onMainThread { attempt(context, activity, title, body, files, mimes) }

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

    private fun attempt(
        context: Context,
        activity: Activity?,
        title: String?,
        body: String,
        files: List<String>,
        mimes: List<String>,
    ): String {
        /* Картинки заметки. Не собрались — отправляем текст, как и раньше:
           потерять заметку из-за вложения хуже, чем потерять вложение. */
        val attachments = uris(context, files)
        val send = attach(context, Intent(Intent.ACTION_SEND), attachments, mimes).apply {
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

    /**
     * Пути временных копий → `content://`-адреса, которые получатель прочитает.
     *
     * Наше хранилище получателю недоступно: заметки лежат либо в выбранной
     * человеком папке (SAF), либо в приватном каталоге приложения, и права на
     * них есть только у нас. Поэтому картинка уезжает копией из `cache/share`,
     * которую отдаёт `ShareFileProvider` (`res/xml/share_file_paths.xml`).
     *
     * Файл, которого нет или который лежит вне объявленной области, тихо
     * пропускается: провайдер на такой откажет исключением, а из-за вложения
     * терять всю отправку нельзя.
     */
    private fun uris(context: Context, files: List<String>): List<Uri> =
        files.mapNotNull { path ->
            try {
                val file = File(path)
                if (!file.isFile) null
                else FileProvider.getUriForFile(context, "${context.packageName}.share", file)
            } catch (_: Throwable) {
                null
            }
        }

    /**
     * Положить вложения в Intent.
     *
     * Три тонкости, и каждая — обязательная:
     *
     *  1. один файл — `ACTION_SEND` с `EXTRA_STREAM`, несколько —
     *     `ACTION_SEND_MULTIPLE` со списком. Приложения различают эти два
     *     случая, и `SEND` со списком у многих принимающих не работает вовсе;
     *  2. `FLAG_GRANT_READ_URI_PERMISSION` — без него получатель увидит адрес,
     *     но читать по нему не сможет;
     *  3. `ClipData` рядом с `EXTRA_STREAM`. Оно выглядит избыточным, но право
     *     чтения система выдаёт по нему; на части версий Android один только
     *     `EXTRA_STREAM` заканчивается отказом в доступе у принимающего.
     */
    private fun attach(
        context: Context,
        base: Intent,
        uris: List<Uri>,
        mimes: List<String>,
    ): Intent {
        if (uris.isEmpty()) return base.apply { type = "text/plain" }

        val intent = if (uris.size == 1) base else Intent(Intent.ACTION_SEND_MULTIPLE)
        intent.type = commonMime(mimes)
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

        if (uris.size == 1) {
            intent.putExtra(Intent.EXTRA_STREAM, uris.first())
        } else {
            intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
        }

        val clip = ClipData.newUri(context.contentResolver, "", uris.first())
        for (extra in uris.drop(1)) clip.addItem(ClipData.Item(extra))
        intent.clipData = clip
        return intent
    }

    /**
     * Один тип на всё вложенное.
     *
     * Разные типы сводятся к общему семейству (`image/*`), а если и семейства
     * разные — к `*/​*`. Врать конкретным типом нельзя: получатель выбирает по
     * нему обработчик и откроет картинку как документ.
     */
    private fun commonMime(mimes: List<String>): String {
        val clean = mimes.filter { it.isNotBlank() }
        if (clean.isEmpty()) return "*/*"
        if (clean.distinct().size == 1) return clean.first()
        val families = clean.map { it.substringBefore('/') }.distinct()
        return if (families.size == 1) "${families.first()}/*" else "*/*"
    }

    private fun describe(error: Throwable): String =
        "error: ${error.javaClass.simpleName}: ${error.message ?: "без пояснения"}"
}
