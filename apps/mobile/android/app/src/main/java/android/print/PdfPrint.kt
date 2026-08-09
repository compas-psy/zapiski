package android.print

import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import java.io.File

/**
 * Драйвер `PrintDocumentAdapter` без диалога печати.
 *
 * **Почему этот файл лежит в пакете `android.print`.** Конструкторы
 * `PrintDocumentAdapter.LayoutResultCallback` и `WriteResultCallback` в
 * платформе объявлены пакетно-приватными: система рассчитывает, что их
 * создаёт только она сама, показав пользователю диалог печати. Нам диалог не
 * нужен — контракт `PdfRenderer` требует вернуть **байты**, а из диалога
 * выходит файл, выбранный человеком, а не байты в приложении. Единственный
 * способ создать эти колбэки — объявить свой класс в том же пакете.
 *
 * **Это не гарантированно работает.** ART сверяет не только имя пакета, но и
 * загрузчик классов, поэтому на части устройств вызов упадёт с
 * `IllegalAccessError`. Поэтому здесь нет ни одной попытки скрыть неудачу:
 * ошибка честно уходит наверх, а `PdfPrinter` переключается на запасной путь
 * (`android.graphics.pdf.PdfDocument`). Проверить, какой из путей срабатывает
 * на реальном устройстве, в этом окружении невозможно — Android SDK здесь нет.
 */
class PdfPrint(private val attributes: PrintAttributes) {

    /**
     * Напечатать документ адаптера в файл. `done(null)` — не получилось;
     * причину печатать некуда, решение принимает вызывающий.
     */
    fun print(adapter: PrintDocumentAdapter, target: File, done: (File?) -> Unit) {
        adapter.onLayout(
            null,
            attributes,
            CancellationSignal(),
            object : PrintDocumentAdapter.LayoutResultCallback() {
                override fun onLayoutFinished(info: PrintDocumentInfo?, changed: Boolean) {
                    val descriptor = try {
                        target.parentFile?.mkdirs()
                        ParcelFileDescriptor.open(
                            target,
                            ParcelFileDescriptor.MODE_CREATE or
                                ParcelFileDescriptor.MODE_TRUNCATE or
                                ParcelFileDescriptor.MODE_READ_WRITE,
                        )
                    } catch (error: Throwable) {
                        done(null)
                        return
                    }

                    adapter.onWrite(
                        arrayOf(PageRange.ALL_PAGES),
                        descriptor,
                        CancellationSignal(),
                        object : PrintDocumentAdapter.WriteResultCallback() {
                            override fun onWriteFinished(pages: Array<out PageRange>?) {
                                close(descriptor)
                                adapter.onFinish()
                                done(if (pages.isNullOrEmpty()) null else target)
                            }

                            override fun onWriteFailed(error: CharSequence?) {
                                close(descriptor)
                                adapter.onFinish()
                                done(null)
                            }

                            override fun onWriteCancelled() {
                                close(descriptor)
                                adapter.onFinish()
                                done(null)
                            }
                        },
                    )
                }

                override fun onLayoutFailed(error: CharSequence?) = done(null)

                override fun onLayoutCancelled() = done(null)
            },
            Bundle(),
        )
    }

    private fun close(descriptor: ParcelFileDescriptor) {
        try {
            descriptor.close()
        } catch (error: Throwable) {
            // Файл уже закрыт системой — ничего страшного.
        }
    }
}
