package ru.cmpas.zapiski

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.HapticFeedbackConstants
import android.view.WindowManager
import java.lang.ref.WeakReference

/**
 * Мост между Rust-частью оболочки и Android.
 *
 * Rust зовёт отсюда статические методы (`Java_ru_cmpas_zapiski_NativeBridge_*`
 * — обратное направление). Всё, что здесь есть, — платформенные механизмы:
 * ни одного продуктового решения, ни одного экрана (ARCHITECTURE §1).
 *
 * Про потоки. Методы зовутся с рабочих потоков Tauri, а окно и WebView живут
 * на главном; поэтому всё, что трогает UI, обёрнуто в `runOnUiThread`, а всё,
 * что ходит в сеть, наоборот, уводится с главного потока — иначе Android
 * бросит `NetworkOnMainThreadException`.
 */
object NativeBridge {

    /** Имя нативной библиотеки = `[lib] name` из `src-tauri/Cargo.toml`. */
    private const val LIBRARY = "zapiski_mobile_lib"

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var activity: WeakReference<Activity>? = null

    /**
     * Готов ли нативный мост. Виджеты и плитка смотрят на этот флаг, чтобы
     * понять, можно ли достучаться до приложения напрямую или отметку нужно
     * положить в файл очереди и дождаться запуска.
     */
    @Volatile
    var attached: Boolean = false
        private set

    // ── Жизненный цикл ──────────────────────────────────────────────────────

    fun attach(current: Activity) {
        appContext = current.applicationContext
        activity = WeakReference(current)
        if (attached) return
        attached = try {
            // Библиотеку уже загрузила активность Tauri; повторная загрузка —
            // безвредный no-op, зато мост работает и в том порядке запуска,
            // где активность ещё не успела этого сделать.
            System.loadLibrary(LIBRARY)
            nativeInit()
            true
        } catch (error: Throwable) {
            false
        }
    }

    fun detach(current: Activity) {
        if (activity?.get() === current) activity = null
    }

    /** Контекст приложения для виджетов, плитки и очередей. */
    fun context(): Context? = appContext

    private fun requireContext(): Context =
        appContext ?: throw IllegalStateException("контекст приложения ещё не готов")

    // ── Окно ────────────────────────────────────────────────────────────────

    /**
     * FLAG_SECURE (BEHAVIOR §5.3, приёмочный критерий №7): содержимое не
     * попадает ни в превью задач ОС, ни в скриншот.
     */
    @JvmStatic
    fun setSecure(on: Boolean) {
        val current = activity?.get() ?: return
        current.runOnUiThread {
            if (on) {
                current.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            } else {
                current.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
        }
    }

    // ── Хэптика (BEHAVIOR §0) ───────────────────────────────────────────────

    /**
     * 0 — лёгкий импульс (чекбокс, свайп, разблокировка, long-press),
     * 1 — средний (удаление, архивация).
     *
     * Сначала пробуем `performHapticFeedback`: он уважает системную настройку
     * тактильной отдачи и не требует разрешения. Если у окна её нет (например,
     * пользователь выключил отклик на касание, но вибрацию оставил) — вибратор
     * с предопределённым эффектом. Ни один путь не «усиливает» отклик: §0
     * требует деликатности.
     */
    @JvmStatic
    fun haptic(strength: Int) {
        val current = activity?.get()
        if (current == null) {
            vibrate(strength)
            return
        }
        val constant = if (strength >= 1) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                HapticFeedbackConstants.CONFIRM
            } else {
                HapticFeedbackConstants.LONG_PRESS
            }
        } else {
            HapticFeedbackConstants.KEYBOARD_TAP
        }
        // Ответ `performHapticFeedback` доступен только на UI-потоке, поэтому и
        // решение о запасном пути принимается там же: читать его снаружи
        // означало бы гонку с ещё не выполненным Runnable.
        current.runOnUiThread {
            if (!current.window.decorView.performHapticFeedback(constant)) vibrate(strength)
        }
    }

    private fun vibrate(strength: Int) {
        val context = appContext ?: return
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val manager = context.getSystemService(VibratorManager::class.java)
            manager?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        } ?: return
        if (!vibrator.hasVibrator()) return

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val effect = if (strength >= 1) VibrationEffect.EFFECT_CLICK else VibrationEffect.EFFECT_TICK
            vibrator.vibrate(VibrationEffect.createPredefined(effect))
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(if (strength >= 1) 20L else 10L)
        }
    }

    // ── Каталоги ────────────────────────────────────────────────────────────

    /** Приватный каталог приложения: очереди, снимок виджетов, ключи. */
    @JvmStatic
    fun filesDir(): String? = appContext?.filesDir?.absolutePath

    /** Кэш: скачанный APK и временные файлы печати. */
    @JvmStatic
    fun cacheDir(): String? = appContext?.cacheDir?.absolutePath

    /**
     * Каталог приложения во внешней памяти — там лежит vault.
     * `null`, если внешней памяти нет: тогда Rust берёт внутренний каталог.
     */
    @JvmStatic
    fun externalFilesDir(): String? = appContext?.getExternalFilesDir(null)?.absolutePath

    // ── Биометрия ───────────────────────────────────────────────────────────

    @JvmStatic
    fun biometricsAvailable(): Boolean = Biometrics.available(requireContext())

    @JvmStatic
    fun biometricsEnroll(requestId: Long, keyId: String, secret: ByteArray) {
        Biometrics.enroll(activity?.get(), requireContext(), requestId, keyId, secret)
    }

    @JvmStatic
    fun biometricsUnlock(requestId: Long, keyId: String) {
        Biometrics.unlock(activity?.get(), requireContext(), requestId, keyId)
    }

    @JvmStatic
    fun biometricsRemove(keyId: String) {
        Biometrics.remove(requireContext(), keyId)
    }

    // ── Печать ──────────────────────────────────────────────────────────────

    @JvmStatic
    fun renderPdf(requestId: Long, html: String, marginMm: Double) {
        val current = activity?.get()
        if (current == null) {
            result(requestId, false, "печать возможна только при открытом приложении", null)
            return
        }
        current.runOnUiThread { PdfPrinter.render(current, requestId, html, marginMm) }
    }

    // ── Обновление ──────────────────────────────────────────────────────────

    @JvmStatic
    fun httpGet(url: String): String = Updates.httpGet(url)

    @JvmStatic
    fun download(requestId: Long, url: String, destination: String) {
        Thread { Updates.download(requestId, url, destination) }.start()
    }

    @JvmStatic
    fun installApk(path: String) {
        Updates.install(requireContext(), path)
    }

    // ── Виджеты ─────────────────────────────────────────────────────────────

    @JvmStatic
    fun refreshWidgets() {
        appContext?.let { Widgets.refreshAll(it) }
    }

    // ── Rust: сюда мы отдаём результаты ─────────────────────────────────────

    /** Запомнить виртуальную машину. Зовётся один раз, из `attach`. */
    private external fun nativeInit()

    private external fun nativeResult(requestId: Long, ok: Boolean, text: String?, data: ByteArray?)

    private external fun nativeProgress(requestId: Long, done: Long, total: Long)

    private external fun nativeShare()

    private external fun nativeQuickNote()

    private external fun nativeWidgetCommand()

    /**
     * Результат асинхронной операции. `ok = true` с пустыми данными — это не
     * ошибка, а отмена пользователем (BEHAVIOR §5.2).
     */
    fun result(requestId: Long, ok: Boolean, text: String?, data: ByteArray?) {
        if (!attached) return
        nativeResult(requestId, ok, text, data)
    }

    fun progress(requestId: Long, done: Long, total: Long) {
        if (attached) nativeProgress(requestId, done, total)
    }

    /** В очереди share-target появился контент. */
    fun pokeShare() {
        if (attached) nativeShare()
    }

    /** Нажали «Записать»: плитка Quick Settings или виджет 1×1. */
    fun pokeQuickNote() {
        if (attached) nativeQuickNote()
    }

    /** В очереди виджетов появилась отметка чекбокса. */
    fun pokeWidgetCommand() {
        if (attached) nativeWidgetCommand()
    }
}
