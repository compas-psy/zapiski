package ru.cmpas.zapiski

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

/**
 * Виджеты рабочего стола (ТЗ §5.4, BEHAVIOR §8).
 *
 *   «Записать» 1×1     — иконка пера и подпись, тап открывает новую заметку;
 *   «Последние» 2×2    — до 4 заголовков с датой, зашифрованные плейсхолдером;
 *   «Закреплённая» 2×2 — заголовок и первые строки, чекбоксы **интерактивны
 *                        прямо в виджете**.
 *
 * **Тема.** Виджет живёт в процессе лаунчера и токенов CSS не видит, поэтому
 * фон и текст берутся из системных атрибутов темы (`?android:attr/…`) — они
 * следуют светлой и тёмной теме ОС сами. Акцент приходит из снимка: цвет
 * вычислен из тех же токенов, что и в приложении, и меняется вместе с
 * выбранным акцентом (§8 «виджеты уважают системную тему и выбранный акцент»).
 *
 * **Обновление — по изменению данных, а не по таймеру** (§8). Поэтому в
 * `res/xml/widget_*.xml` стоит `updatePeriodMillis="0"`, а перерисовку
 * запускает приложение через `widgets_publish`.
 */
object Widgets {

    /** Тап по чекбоксу в «Закреплённой». */
    const val ACTION_TOGGLE = "ru.cmpas.zapiski.WIDGET_TOGGLE"
    /** Тап по строке в «Последних». */
    const val ACTION_OPEN = "ru.cmpas.zapiski.WIDGET_OPEN"
    /** Тап по «+» или по виджету «Записать». */
    const val ACTION_QUICK_NOTE = "ru.cmpas.zapiski.WIDGET_QUICK_NOTE"

    const val EXTRA_NOTE_ID = "noteId"
    const val EXTRA_TODO_INDEX = "todoIndex"
    const val EXTRA_CHECKED = "checked"

    /** Сколько строк показывает «Последние» (§8: до 4). */
    private const val RECENT_ROWS = 4
    /** Сколько строк показывает «Закреплённая» (§8: первые ~6). */
    private const val PINNED_ROWS = 6

    private val RECENT_TITLE = intArrayOf(
        R.id.recent_title_0, R.id.recent_title_1, R.id.recent_title_2, R.id.recent_title_3,
    )
    private val RECENT_DATE = intArrayOf(
        R.id.recent_date_0, R.id.recent_date_1, R.id.recent_date_2, R.id.recent_date_3,
    )
    private val RECENT_ROW = intArrayOf(
        R.id.recent_row_0, R.id.recent_row_1, R.id.recent_row_2, R.id.recent_row_3,
    )
    private val PINNED_ROW = intArrayOf(
        R.id.pinned_row_0, R.id.pinned_row_1, R.id.pinned_row_2,
        R.id.pinned_row_3, R.id.pinned_row_4, R.id.pinned_row_5,
    )
    private val PINNED_BOX = intArrayOf(
        R.id.pinned_box_0, R.id.pinned_box_1, R.id.pinned_box_2,
        R.id.pinned_box_3, R.id.pinned_box_4, R.id.pinned_box_5,
    )
    private val PINNED_TEXT = intArrayOf(
        R.id.pinned_text_0, R.id.pinned_text_1, R.id.pinned_text_2,
        R.id.pinned_text_3, R.id.pinned_text_4, R.id.pinned_text_5,
    )

    /** Перерисовать все виджеты приложения. Зовётся из `widgets_publish`. */
    fun refreshAll(context: Context) {
        val manager = AppWidgetManager.getInstance(context) ?: return
        refresh(context, manager, QuickNoteWidget::class.java)
        refresh(context, manager, RecentWidget::class.java)
        refresh(context, manager, PinnedWidget::class.java)
    }

    private fun refresh(context: Context, manager: AppWidgetManager, provider: Class<*>) {
        val ids = manager.getAppWidgetIds(ComponentName(context, provider))
        if (ids.isEmpty()) return
        for (id in ids) render(context, manager, id, provider)
    }

    fun render(context: Context, manager: AppWidgetManager, id: Int, provider: Class<*>) {
        val snapshot = WidgetData.snapshot(context)
        val views = when (provider) {
            QuickNoteWidget::class.java -> quickNote(context, snapshot)
            RecentWidget::class.java -> recent(context, snapshot)
            PinnedWidget::class.java -> pinned(context, snapshot)
            else -> return
        }
        manager.updateAppWidget(id, views)
    }

    // ── Разметка ────────────────────────────────────────────────────────────

    private fun quickNote(context: Context, snapshot: WidgetData.Snapshot): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_quick_note)
        if (snapshot.accent != 0) views.setInt(R.id.quick_icon, "setColorFilter", snapshot.accent)
        views.setOnClickPendingIntent(R.id.quick_root, broadcast(context, ACTION_QUICK_NOTE, 0, null))
        return views
    }

    private fun recent(context: Context, snapshot: WidgetData.Snapshot): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_recent)
        if (snapshot.accent != 0) views.setInt(R.id.recent_new, "setColorFilter", snapshot.accent)

        views.setOnClickPendingIntent(R.id.recent_header, broadcast(context, ACTION_OPEN, 0, null))
        views.setOnClickPendingIntent(R.id.recent_new, broadcast(context, ACTION_QUICK_NOTE, 1, null))

        val notes = snapshot.recent.take(RECENT_ROWS)
        views.setViewVisibility(R.id.recent_empty, if (notes.isEmpty()) VISIBLE else GONE)

        for (index in 0 until RECENT_ROWS) {
            val note = notes.getOrNull(index)
            if (note == null) {
                views.setViewVisibility(RECENT_ROW[index], GONE)
                continue
            }
            views.setViewVisibility(RECENT_ROW[index], VISIBLE)
            // Зашифрованная заметка — плейсхолдером, без содержимого (§8).
            views.setTextViewText(
                RECENT_TITLE[index],
                if (note.encrypted) context.getString(R.string.widget_encrypted) else note.title,
            )
            views.setTextViewText(RECENT_DATE[index], note.date)
            views.setOnClickPendingIntent(
                RECENT_ROW[index],
                broadcast(context, ACTION_OPEN, 10 + index, Intent().putExtra(EXTRA_NOTE_ID, note.id)),
            )
        }
        return views
    }

    private fun pinned(context: Context, snapshot: WidgetData.Snapshot): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_pinned)
        val note = snapshot.pinned

        if (note == null) {
            views.setViewVisibility(R.id.pinned_empty, VISIBLE)
            views.setTextViewText(R.id.pinned_title, "")
            for (row in PINNED_ROW) views.setViewVisibility(row, GONE)
            return views
        }

        views.setViewVisibility(R.id.pinned_empty, GONE)
        views.setTextViewText(R.id.pinned_title, note.title)
        views.setOnClickPendingIntent(
            R.id.pinned_title,
            broadcast(context, ACTION_OPEN, 20, Intent().putExtra(EXTRA_NOTE_ID, note.id)),
        )

        val lines = note.lines.take(PINNED_ROWS)
        for (index in 0 until PINNED_ROWS) {
            val line = lines.getOrNull(index)
            if (line == null) {
                views.setViewVisibility(PINNED_ROW[index], GONE)
                continue
            }
            views.setViewVisibility(PINNED_ROW[index], VISIBLE)
            views.setTextViewText(PINNED_TEXT[index], line.text)

            if (!line.todo) {
                views.setViewVisibility(PINNED_BOX[index], GONE)
                continue
            }
            views.setViewVisibility(PINNED_BOX[index], VISIBLE)
            views.setImageViewResource(
                PINNED_BOX[index],
                if (line.checked) R.drawable.ic_check_on else R.drawable.ic_check_off,
            )
            if (line.checked && snapshot.accent != 0) {
                views.setInt(PINNED_BOX[index], "setColorFilter", snapshot.accent)
            }
            // Интерактивный чекбокс прямо в виджете (§8).
            views.setOnClickPendingIntent(
                PINNED_BOX[index],
                broadcast(
                    context,
                    ACTION_TOGGLE,
                    100 + index,
                    Intent()
                        .putExtra(EXTRA_NOTE_ID, note.id)
                        .putExtra(EXTRA_TODO_INDEX, line.todoIndex)
                        .putExtra(EXTRA_CHECKED, !line.checked),
                ),
            )
        }
        return views
    }

    private const val VISIBLE = android.view.View.VISIBLE
    private const val GONE = android.view.View.GONE

    /**
     * `PendingIntent` на собственный broadcast.
     *
     * Уникальность обеспечивается и `requestCode`, и `data`: без этого система
     * переиспользует один объект для всех строк, и тап по третьему чекбоксу
     * отметил бы первый.
     */
    private fun broadcast(context: Context, action: String, code: Int, extras: Intent?): PendingIntent {
        val intent = Intent(context, ZapiskiWidgetReceiver::class.java).apply {
            this.action = action
            data = Uri.parse("zapiski://widget/$action/$code")
            if (extras != null) putExtras(extras)
        }
        return PendingIntent.getBroadcast(
            context,
            code,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** Обработка тапа. Общая для всех трёх виджетов. */
    fun handle(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_QUICK_NOTE -> {
                Inbox.markQuickNote(context)
                Inbox.launchApp(context)
            }
            ACTION_OPEN -> {
                val noteId = intent.getStringExtra(EXTRA_NOTE_ID)
                if (!noteId.isNullOrEmpty()) WidgetData.openNote(context, noteId)
                Inbox.launchApp(context)
            }
            ACTION_TOGGLE -> {
                val noteId = intent.getStringExtra(EXTRA_NOTE_ID) ?: return
                val todoIndex = intent.getIntExtra(EXTRA_TODO_INDEX, -1)
                if (todoIndex < 0) return
                val checked = intent.getBooleanExtra(EXTRA_CHECKED, false)

                WidgetData.toggleTodo(context, noteId, todoIndex, checked)
                // Лёгкий импульс на отметку чекбокса (BEHAVIOR §0 и §8).
                NativeBridge.tick(context)
                refreshAll(context)
            }
        }
    }
}

/** «Записать» 1×1. */
class QuickNoteWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) Widgets.render(context, manager, id, QuickNoteWidget::class.java)
    }
}

/** «Последние» 2×2. */
class RecentWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) Widgets.render(context, manager, id, RecentWidget::class.java)
    }
}

/** «Закреплённая» 2×2 с интерактивными чекбоксами. */
class PinnedWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) Widgets.render(context, manager, id, PinnedWidget::class.java)
    }
}

/**
 * Приёмник тапов по виджетам.
 *
 * Отдельный `BroadcastReceiver`, а не сами провайдеры: тап по чекбоксу должен
 * работать одинаково, какой бы виджет его прислал, и не зависеть от того,
 * какие виджеты сейчас на экране.
 */
class ZapiskiWidgetReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try {
            Widgets.handle(context.applicationContext, intent)
        } catch (error: Throwable) {
            // Виджет не имеет экрана, чтобы показать ошибку, а падение
            // приёмника выглядит как «приложение остановлено» поверх лаунчера.
        }
    }
}
