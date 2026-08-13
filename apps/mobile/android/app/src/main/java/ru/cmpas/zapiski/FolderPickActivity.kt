package ru.cmpas.zapiski

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Системный выбор папки (`ACTION_OPEN_DOCUMENT_TREE`).
 *
 * Отдельная невидимая активность, а не код в главной, по той же причине, что
 * и у `ShareActivity`: результат выбора приходит в `onActivityResult`, а
 * главную активность генерирует Tauri — переопределять её значит форкать
 * чужой шаблон и ловить конфликты при каждом обновлении CLI.
 *
 * Интерфейса здесь нет: диалог рисует система, а предупреждение о том, чем
 * выбранная папка отличается от папки приложения, показывает `packages/app`
 * (тексты — в каталоге ядра, ТЗ §6).
 */
class FolderPickActivity : Activity() {

    private var requestId: Long = 0

    /**
     * Системный выбор уже открыт.
     *
     * Пока он открыт, наша активность в фоне, и Android вправе её уничтожить —
     * а потом воссоздать вместе с результатом. `onCreate` при этом выполняется
     * заново, и без этого флага открывался ВТОРОЙ выбор поверх первого: человек
     * выбирал папку, а его снова спрашивали, где она.
     */
    private var launched = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestId = intent?.getLongExtra(EXTRA_REQUEST_ID, 0L) ?: 0L
        launched = savedInstanceState?.getBoolean(STATE_LAUNCHED) == true
        if (launched) return

        val pick = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
        )

        try {
            startActivityForResult(pick, REQUEST_TREE)
            launched = true
        } catch (error: Throwable) {
            // Ни одного приложения-провайдера документов на устройстве нет.
            // Это редкость, но не повод падать: заметки остаются в каталоге
            // приложения, а пользователь получит честный отказ.
            NativeBridge.result(requestId, false, "на устройстве нет системного выбора папки", null)
            finish()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_LAUNCHED, launched)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_TREE) {
            finish()
            return
        }

        val uri = if (resultCode == RESULT_OK) data?.data else null
        if (uri == null) {
            // Отмена — не ошибка и сообщений не требует (BEHAVIOR §0).
            NativeBridge.result(requestId, true, "", null)
            finish()
            return
        }

        try {
            // Разрешение обязано пережить перезапуск: иначе после закрытия
            // приложения заметки «пропали бы» вместе с доступом к папке.
            //
            // Флаги берём из ответа системы, а не из головы: провайдер выдаёт
            // ровно то, что выдал, и просить у него больше — верный
            // SecurityException вместо папки.
            Saf.persist(applicationContext, uri, data?.flags ?: 0)
            NativeBridge.result(requestId, true, uri.toString(), null)
        } catch (error: Throwable) {
            NativeBridge.result(requestId, false, "не удалось получить доступ к папке", null)
        }
        finish()
    }

    companion object {
        const val EXTRA_REQUEST_ID = "ru.cmpas.zapiski.saf.request"
        private const val REQUEST_TREE = 4301
        private const val STATE_LAUNCHED = "ru.cmpas.zapiski.saf.launched"
    }
}
