package ru.cmpas.zapiski

import android.content.Context
import android.graphics.Color
import org.json.JSONObject
import java.io.File

/**
 * Данные виджетов: снимок от приложения и очередь отметок обратно.
 *
 * Снимок пишет приложение (`widgets_publish` → `src-tauri/src/widgets.rs`),
 * здесь он только читается. Оболочка **не собирает** содержимое виджета сама:
 * заголовок заметки, порядок «последних» и разбор чекбоксов — продуктовая
 * логика, ей место в ядре (ARCHITECTURE §1). Пока приложение снимок не
 * опубликовало, виджеты честно показывают пустое состояние.
 */
object WidgetData {

    private const val DIR = "widgets"
    private const val SNAPSHOT = "snapshot.json"
    private const val COMMANDS = "commands.jsonl"
    private const val PENDING = "pending.json"

    /** Строка виджета «Последние». */
    data class RecentNote(
        val id: String,
        val title: String,
        val date: String,
        val encrypted: Boolean,
    )

    /** Строка закреплённой заметки: обычная или чекбокс. */
    data class PinnedLine(
        val text: String,
        val todo: Boolean,
        val checked: Boolean,
        val todoIndex: Int,
    )

    data class PinnedNote(val id: String, val title: String, val lines: List<PinnedLine>)

    data class Snapshot(
        /** Акцент темы приложения; 0 — приложение ещё не сообщило цвет. */
        val accent: Int,
        val recent: List<RecentNote>,
        val pinned: PinnedNote?,
    ) {
        val isEmpty: Boolean get() = recent.isEmpty() && pinned == null
    }

    val EMPTY = Snapshot(accent = 0, recent = emptyList(), pinned = null)

    private fun dir(context: Context): File = File(context.filesDir, DIR).apply { mkdirs() }

    /**
     * Прочитать снимок. Любая неудача — пустое состояние: виджет, который
     * показывает вчерашние данные из-за битого файла, врёт пользователю.
     */
    fun snapshot(context: Context): Snapshot {
        val file = File(dir(context), SNAPSHOT)
        if (!file.exists()) return EMPTY
        return try {
            val root = JSONObject(file.readText())
            val overrides = overrides(context)

            val recent = mutableListOf<RecentNote>()
            val array = root.optJSONArray("recent")
            if (array != null) {
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: continue
                    recent.add(
                        RecentNote(
                            id = item.optString("id"),
                            title = item.optString("title"),
                            date = item.optString("date"),
                            encrypted = item.optBoolean("encrypted", false),
                        ),
                    )
                }
            }

            Snapshot(
                accent = parseColor(root.optString("accent")),
                recent = recent,
                pinned = pinned(root.optJSONObject("pinned"), overrides),
            )
        } catch (error: Throwable) {
            EMPTY
        }
    }

    private fun pinned(source: JSONObject?, overrides: Map<Int, Boolean>): PinnedNote? {
        if (source == null) return null
        val lines = mutableListOf<PinnedLine>()
        val array = source.optJSONArray("lines")
        if (array != null) {
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                val todoIndex = item.optInt("todoIndex", -1)
                val checked = item.optBoolean("checked", false)
                lines.add(
                    PinnedLine(
                        text = item.optString("text"),
                        todo = item.optBoolean("todo", false),
                        // Отметка, сделанная в виджете, показывается сразу —
                        // ещё до того, как приложение перепишет `.md`.
                        checked = overrides[todoIndex] ?: checked,
                        todoIndex = todoIndex,
                    ),
                )
            }
        }
        return PinnedNote(
            id = source.optString("id"),
            title = source.optString("title"),
            lines = lines,
        )
    }

    /** `#RRGGBB` из токенов темы. 0 — цвет не сообщили или он непонятен. */
    private fun parseColor(value: String?): Int {
        if (value.isNullOrBlank()) return 0
        return try {
            Color.parseColor(value.trim())
        } catch (error: Throwable) {
            0
        }
    }

    // ── Обратный канал ──────────────────────────────────────────────────────

    /**
     * Отметить чекбокс. Команда уходит в очередь, а её результат сразу
     * запоминается в `pending.json`, чтобы виджет перерисовался с новой
     * галочкой, не дожидаясь приложения.
     */
    fun toggleTodo(context: Context, noteId: String, todoIndex: Int, checked: Boolean) {
        val command = JSONObject()
            .put("kind", "toggle-todo")
            .put("noteId", noteId)
            .put("todoIndex", todoIndex)
            .put("checked", checked)
            .put("at", System.currentTimeMillis())
        Inbox.append(File(dir(context), COMMANDS), command.toString())
        rememberOverride(context, todoIndex, checked)
        NativeBridge.pokeWidgetCommand()
    }

    /**
     * Открыть заметку из виджета «Последние».
     *
     * ⚠️ Команда кладётся в ту же очередь, но применить её пока нечем: в
     * `AppHost` нет ни порта виджетов, ни навигации по идентификатору
     * заметки. Оболочка делает свою половину и открывает приложение; вторая
     * половина — порт (ARCHITECTURE §1).
     */
    fun openNote(context: Context, noteId: String) {
        val command = JSONObject()
            .put("kind", "open-note")
            .put("noteId", noteId)
            .put("todoIndex", 0)
            .put("checked", false)
            .put("at", System.currentTimeMillis())
        Inbox.append(File(dir(context), COMMANDS), command.toString())
        NativeBridge.pokeWidgetCommand()
    }

    private fun overrides(context: Context): Map<Int, Boolean> {
        val file = File(dir(context), PENDING)
        if (!file.exists()) return emptyMap()
        return try {
            val root = JSONObject(file.readText())
            val result = mutableMapOf<Int, Boolean>()
            for (key in root.keys()) {
                val index = key.toIntOrNull() ?: continue
                result[index] = root.optBoolean(key, false)
            }
            result
        } catch (error: Throwable) {
            emptyMap()
        }
    }

    private fun rememberOverride(context: Context, todoIndex: Int, checked: Boolean) {
        val file = File(dir(context), PENDING)
        val root = try {
            if (file.exists()) JSONObject(file.readText()) else JSONObject()
        } catch (error: Throwable) {
            JSONObject()
        }
        try {
            root.put(todoIndex.toString(), checked)
            file.writeText(root.toString())
        } catch (error: Throwable) {
            // Не записали — галочка просто дождётся ответа приложения.
        }
    }
}
