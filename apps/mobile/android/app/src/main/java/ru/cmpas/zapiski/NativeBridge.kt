package ru.cmpas.zapiski

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.HapticFeedbackConstants
import android.view.WindowManager
import androidx.core.view.WindowCompat
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

    /**
     * Запомнить контекст приложения. Зовётся из `Application.onCreate` —
     * то есть и в том процессе, где активности не будет никогда (виджет,
     * плитка, приём «Поделиться»). Нативных вызовов здесь нет и быть не
     * может: библиотеку загружает активность Tauri, до неё символов ещё нет.
     */
    fun rememberContext(context: Context) {
        if (appContext == null) appContext = context.applicationContext
    }

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

    /**
     * Цвет системных значков сверху: часы, батарея, сигнал.
     *
     * Заказчик: «на системной панели в Андроид, которая сверху, из-за белого
     * фона приложения сливаются системные иконки». Так и есть: по умолчанию
     * Android рисует их СВЕТЛЫМИ — расчёт на тёмное приложение, — и на нашей
     * «Бумаге» они исчезают.
     *
     * Фон панели мы не трогаем (заказчик просил именно это): меняется только
     * `isAppearanceLightStatusBars` — признак «под панелью светло, рисуй
     * значки тёмными». Тот же признак ставится и нижней панели навигации,
     * иначе полоска жеста пропадает ровно так же.
     *
     * Решение принимает фронтенд: тема живёт там, у неё три значения и режим
     * «как в системе», и дублировать этот разбор в Kotlin значило бы завести
     * второй источник истины.
     */
    @JvmStatic
    fun setSystemBarIcons(dark: Boolean) {
        val current = activity?.get() ?: return
        current.runOnUiThread {
            val controller = WindowCompat.getInsetsController(current.window, current.window.decorView)
            controller.isAppearanceLightStatusBars = dark
            controller.isAppearanceLightNavigationBars = dark
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

    /**
     * Лёгкий импульс из процесса без активности — виджет, приёмник тапа.
     * `performHapticFeedback` там недоступен: он требует View.
     */
    fun tick(context: Context) {
        rememberContext(context)
        vibrate(0)
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
    //
    // Только опрос фида. Скачивания и установки здесь больше нет: ссылка на
    // APK открывается во внешнем браузере, а разрешение установщика пакетов
    // убрано из манифеста — из-за него Play Protect блокировал каждую
    // установку (см. apps/mobile/android-permissions.txt).

    @JvmStatic
    fun httpGet(url: String): String = Updates.httpGet(url)

    // ── Экспорт файла ───────────────────────────────────────────────────────

    /** `null` — сохранили; строка — текст ошибки. */
    @JvmStatic
    fun saveToDownloads(name: String, mime: String, sourcePath: String): String? =
        Downloads.save(requireContext(), name, mime, sourcePath)

    // ── Папка пользователя через SAF (ТЗ §4.1 п. 1) ─────────────────────────
    //
    // Все методы, кроме `safPickFolder`, синхронны: Rust зовёт их с рабочего
    // потока. Неудача — исключение (Rust превратит его в ошибку команды),
    // `null` — «такого документа нет», а это законный ответ, а не сбой.

    /**
     * Системный выбор папки. Ответ придёт в `result`: адрес дерева при
     * выборе, пустая строка при отмене (отмена — не ошибка, BEHAVIOR §0).
     */
    @JvmStatic
    fun safPickFolder(requestId: Long) {
        val current = activity?.get()
        val context = current ?: appContext
        if (context == null) {
            result(requestId, false, "выбор папки возможен только при открытом приложении", null)
            return
        }
        val intent = Intent(context, FolderPickActivity::class.java)
            .putExtra(FolderPickActivity.EXTRA_REQUEST_ID, requestId)
        // Из активности — тем же стеком задач; из контекста приложения иначе
        // нельзя вовсе, там NEW_TASK обязателен.
        if (current == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    /**
     * Деревья, разрешение на которые у нас есть прямо сейчас (JSON-массив,
     * новейшее первым). Отсюда приложение восстанавливает выбор папки, если
     * система убила процесс, пока был открыт системный выбор.
     */
    @JvmStatic
    fun safPersistedTrees(): String = Saf.persistedTrees(requireContext())

    /** Отпустить разрешения на все деревья — возврат в каталог приложения. */
    @JvmStatic
    fun safReleaseTrees() = Saf.releaseTrees(requireContext())

    @JvmStatic
    fun safHasAccess(tree: String): Boolean = Saf.hasAccess(requireContext(), tree)

    @JvmStatic
    fun safLabel(tree: String): String? = Saf.label(requireContext(), tree)

    @JvmStatic
    fun safSupportsRename(tree: String): Boolean = Saf.supportsRename(requireContext(), tree)

    @JvmStatic
    fun safList(tree: String, path: String): String? = Saf.list(requireContext(), tree, path)

    @JvmStatic
    fun safRead(tree: String, path: String): ByteArray? = Saf.read(requireContext(), tree, path)

    @JvmStatic
    fun safStat(tree: String, path: String): String? = Saf.stat(requireContext(), tree, path)

    /** Возвращает фактический режим записи: `staged` либо `direct`. */
    @JvmStatic
    fun safWrite(tree: String, path: String, data: ByteArray): String =
        Saf.write(requireContext(), tree, path, data)

    @JvmStatic
    fun safMkdir(tree: String, path: String) = Saf.mkdir(requireContext(), tree, path)

    @JvmStatic
    fun safRemove(tree: String, path: String) = Saf.remove(requireContext(), tree, path)

    /** Открыть вложение системным приложением (замечание 16). */
    @JvmStatic
    fun safOpen(tree: String, path: String): Boolean = Saf.open(requireContext(), tree, path)

    @JvmStatic
    fun safRename(tree: String, from: String, to: String) = Saf.rename(requireContext(), tree, from, to)

    /**
     * Отдать заметку системному «Поделиться».
     *
     * Возвращает `shared`, `copied` или строку с текстом ошибки: приложение
     * обязано сказать человеку, что именно случилось, а не выдавать любую
     * беду за «принять некому».
     *
     * `files` и `mimes` — пути временных копий вложений и их типы, по строке
     * на файл через перевод строки. Пустая строка означает «только текст»:
     * так эта кнопка и работала до появления картинок.
     */
    @JvmStatic
    fun shareText(title: String?, body: String, files: String?, mimes: String?): String =
        try {
            ShareOut.text(
                requireContext(),
                activity?.get(),
                title,
                body,
                files.orEmpty().split('\n').filter { it.isNotBlank() },
                mimes.orEmpty().split('\n').filter { it.isNotBlank() },
            )
        } catch (error: Throwable) {
            /*
             * Наружу — строка, никогда исключение.
             *
             * Мост зовут по имени из Rust: улетевшее исключение он покажет как
             * «Java-сторона завершилась исключением», а по такому тексту чинить
             * нечего. `requireContext()` живёт вне `ShareOut` и бросает, когда
             * контекст ещё не готов, — поэтому обёртка именно здесь.
             */
            "error: ${error.javaClass.simpleName}: ${error.message ?: "без пояснения"}"
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

    private external fun nativeShare()

    private external fun nativeQuickNote()

    private external fun nativeWidgetCommand()

    private external fun nativeAuthCallback()

    /**
     * Результат асинхронной операции. `ok = true` с пустыми данными — это не
     * ошибка, а отмена пользователем (BEHAVIOR §5.2).
     */
    fun result(requestId: Long, ok: Boolean, text: String?, data: ByteArray?) {
        if (!attached) return
        nativeResult(requestId, ok, text, data)
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

    /**
     * В очереди появился возврат после входа: `zapiski://…` или App Link.
     * Адрес не передаётся аргументом — он уже лежит в файле очереди, и это
     * единственный способ не обменять одноразовый токен дважды.
     */
    fun pokeAuthCallback() {
        if (attached) nativeAuthCallback()
    }
}
