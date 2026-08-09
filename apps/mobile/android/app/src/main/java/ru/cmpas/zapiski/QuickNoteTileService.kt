package ru.cmpas.zapiski

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.TileService

/**
 * Плитка Quick Settings — «эквивалент быстрой заметки» (ТЗ §5.4, BEHAVIOR §8).
 *
 * Тап отмечает намерение в очереди и открывает приложение. Что показать —
 * новую заметку с поднятой клавиатурой (§8) — решает `packages/app`: плитка
 * не знает ни про экраны, ни про заметки.
 */
// minSdk оболочки — 24, а `TileService` появился ровно в 24: отдельная
// проверка версии здесь не нужна.
class QuickNoteTileService : TileService() {

    override fun onClick() {
        super.onClick()
        Inbox.markQuickNote(applicationContext)

        val intent = Intent(applicationContext, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }

        // На Android 14+ запускать активность из плитки можно только через
        // PendingIntent: прямой startActivity система молча игнорирует.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val pending = PendingIntent.getActivity(
                applicationContext,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            startActivityAndCollapse(pending)
        } else {
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(intent)
        }
    }
}
