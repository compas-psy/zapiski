package ru.cmpas.zapiski

import android.app.Activity
import android.graphics.pdf.PdfDocument
import android.print.PdfPrint
import android.print.PrintAttributes
import android.util.TypedValue
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.File

/**
 * `PdfRenderer` — печать средствами Android.
 *
 * Ядро отдаёт самодостаточный HTML, а страницы рисует движок печати платформы:
 * только так кириллица печатается с нормальными шрифтами и переносами
 * (контракт `PdfRenderer` в `packages/core/src/contract.ts`).
 *
 * Два пути, в порядке предпочтения:
 *
 *  1. **Системный конвейер печати.** У скрытого `WebView` берётся
 *     `PrintDocumentAdapter` — тот самый, которым система печатает страницу,
 *     когда пользователь выбирает «Сохранить в PDF». Пагинацию, поля и
 *     переносы делает платформа.
 *  2. **Запасной путь** — `android.graphics.pdf.PdfDocument` (системный
 *     писатель PDF) плюс рисование WebView на канву страницы. Включается,
 *     если первый путь недоступен (см. комментарий в `PdfPrint`).
 *
 * Диалога печати не показывается ни в одном из путей: контракт требует
 * байты, а диалог отдаёт файл, выбранный пользователем.
 *
 * Временный файл удаляется всегда, включая ошибочный исход: печатается
 * расшифрованная заметка, и оставлять её на диске нельзя (BEHAVIOR §5.3).
 */
object PdfPrinter {

    /** A4 в точках (1/72 дюйма) — та же метрика, что у PrintAttributes. */
    private const val PAGE_WIDTH_PT = 595
    private const val PAGE_HEIGHT_PT = 842
    private const val MM_PER_INCH = 25.4

    /**
     * Вызывается на главном потоке: `WebView` можно создавать только там.
     * Результат уезжает Rust'у через `NativeBridge.result`.
     */
    fun render(activity: Activity, requestId: Long, html: String, marginMm: Double) {
        val target = File(File(activity.cacheDir, "print").apply { mkdirs() }, "print-$requestId.pdf")

        val webView = WebView(activity)
        webView.settings.javaScriptEnabled = false
        // Документ самодостаточен: ни одного сетевого обращения при печати
        // быть не должно — это приватность, а не оптимизация.
        webView.settings.blockNetworkLoads = true
        webView.settings.allowFileAccess = false

        webView.webViewClient = object : WebViewClient() {
            private var finished = false

            override fun onPageFinished(view: WebView, url: String) {
                if (finished) return
                finished = true
                // Даём кадр на раскладку: onPageFinished приходит до того, как
                // WebView успевает измерить содержимое.
                view.post { print(view, requestId, target, marginMm) }
            }
        }

        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
    }

    private fun print(webView: WebView, requestId: Long, target: File, marginMm: Double) {
        val margin = (marginMm * 1000 / MM_PER_INCH).toInt()
        val attributes = PrintAttributes.Builder()
            .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
            .setResolution(PrintAttributes.Resolution("pdf", "pdf", 300, 300))
            .setMinMargins(PrintAttributes.Margins(margin, margin, margin, margin))
            .build()

        val finish = { file: File? ->
            deliver(requestId, file)
            webView.destroy()
        }

        try {
            val adapter = webView.createPrintDocumentAdapter("zapiski")
            PdfPrint(attributes).print(adapter, target) { file ->
                if (file != null) {
                    finish(file)
                } else {
                    finish(drawFallback(webView, target))
                }
            }
        } catch (error: Throwable) {
            // Системный конвейер недоступен (см. PdfPrint) — рисуем сами.
            finish(drawFallback(webView, target))
        }
    }

    /**
     * Запасной путь: страницы рисуются на канву `PdfDocument`.
     *
     * Разбиение по страницам здесь наше, а не платформенное, поэтому строка на
     * границе страницы может разрезаться. Это заметно хуже первого пути —
     * именно поэтому он и запасной.
     */
    private fun drawFallback(webView: WebView, target: File): File? {
        return try {
            val contentWidth = webView.width.takeIf { it > 0 } ?: return null
            val contentHeight = webView.contentHeight.takeIf { it > 0 }?.let {
                TypedValue.applyDimension(
                    TypedValue.COMPLEX_UNIT_DIP,
                    it.toFloat(),
                    webView.resources.displayMetrics,
                ).toInt()
            } ?: return null

            val scale = PAGE_WIDTH_PT.toFloat() / contentWidth
            val pageContentHeight = (PAGE_HEIGHT_PT / scale).toInt().coerceAtLeast(1)
            val pages = (contentHeight + pageContentHeight - 1) / pageContentHeight

            val document = PdfDocument()
            for (index in 0 until pages) {
                val info = PdfDocument.PageInfo.Builder(PAGE_WIDTH_PT, PAGE_HEIGHT_PT, index + 1).create()
                val page = document.startPage(info)
                page.canvas.scale(scale, scale)
                page.canvas.translate(0f, -(index * pageContentHeight).toFloat())
                webView.draw(page.canvas)
                document.finishPage(page)
            }

            target.parentFile?.mkdirs()
            target.outputStream().use { document.writeTo(it) }
            document.close()
            target
        } catch (error: Throwable) {
            null
        }
    }

    /** Прочитать результат, отдать байты и убрать файл в любом исходе. */
    private fun deliver(requestId: Long, file: File?) {
        if (file == null || !file.exists()) {
            NativeBridge.result(requestId, false, "не удалось напечатать документ", null)
            return
        }
        val bytes = try {
            file.readBytes()
        } catch (error: Throwable) {
            null
        }
        file.delete()

        if (bytes == null || bytes.isEmpty()) {
            NativeBridge.result(requestId, false, "не удалось напечатать документ", null)
        } else {
            NativeBridge.result(requestId, true, null, bytes)
        }
    }
}
