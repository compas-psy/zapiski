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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestId = intent?.getLongExtra(EXTRA_REQUEST_ID, 0L) ?: 0L

        val pick = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
        )

        try {
            startActivityForResult(pick, REQUEST_TREE)
        } catch (error: Throwable) {
            // Ни одного приложения-провайдера документов на устройстве нет.
            // Это редкость, но не повод падать: заметки остаются в каталоге
            // приложения, а пользователь получит честный отказ.
            NativeBridge.result(requestId, false, "на устройстве нет системного выбора папки", null)
            finish()
        }
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
            Saf.persist(applicationContext, uri)
            NativeBridge.result(requestId, true, uri.toString(), null)
        } catch (error: Throwable) {
            NativeBridge.result(requestId, false, "не удалось получить доступ к папке", null)
        }
        finish()
    }

    companion object {
        const val EXTRA_REQUEST_ID = "ru.cmpas.zapiski.saf.request"
        private const val REQUEST_TREE = 4301
    }
}
