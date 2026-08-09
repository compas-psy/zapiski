package ru.cmpas.zapiski

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.DocumentsContract
import org.json.JSONArray
import org.json.JSONObject

/**
 * Папка пользователя через Storage Access Framework.
 *
 * ── Зачем ───────────────────────────────────────────────────────────────────
 *
 * Умолчание на Android — каталог приложения с настоящими `.md` и атомарной
 * записью (`vault.rs`), и оно не меняется. Но ТЗ §4.1 п. 1 называет ключевым
 * сценарий «папка, которую синкает сторонний клиент»: заметки в папке
 * Яндекс.Диска синхронизируются бесплатно, без нашего облака. На Android
 * чужая папка доступна только так — деревом `content://`.
 *
 * ── Чего здесь нет и почему ─────────────────────────────────────────────────
 *
 * Атомарной записи в смысле ТЗ §4.3 («tmp + rename поверх существующего»)
 * SAF не даёт: `DocumentsContract.renameDocument` не заменяет документ с тем
 * же именем, а провайдер вправе вообще не поддерживать переименование. Мы
 * делаем максимум возможного и называем результат честно:
 *
 *   `staged` — провайдер умеет `FLAG_SUPPORTS_RENAME`: байты уходят во
 *              временный документ, затем старый удаляется и временный
 *              занимает его имя. Длинная часть записи безопасна, окно риска —
 *              доли секунды между удалением и переименованием;
 *   `direct` — не умеет: пишем прямо в целевой документ.
 *
 * Врать в эту сторону нельзя: интерфейс показывает пользователю ровно тот
 * режим, который вернулся отсюда.
 *
 * ── Про производительность ──────────────────────────────────────────────────
 *
 * У SAF нет «открыть по пути»: путь разбирается по сегментам, каждый — запрос
 * к провайдеру. Кэш `docId` на дерево спасает обход папок и повторные чтения;
 * инвалидация грубая (по записи в родителя), потому что тихо устаревший
 * `docId` дороже лишнего запроса.
 */
object Saf {

    /** Что вернула запись — эти же слова уезжают в интерфейс. */
    const val MODE_STAGED = "staged"
    const val MODE_DIRECT = "direct"

    private const val MIME_DIR = DocumentsContract.Document.MIME_TYPE_DIR
    private const val MIME_FILE = "text/markdown"

    /** `дерево|путь` → `documentId`. Чистится при любой правке дерева. */
    private val cache = HashMap<String, String>()

    // ── Дерево ──────────────────────────────────────────────────────────────

    /**
     * Разрешение на дерево живёт дольше процесса — но только то, которое мы
     * забрали `takePersistableUriPermission`. Пользователь может отозвать его
     * в настройках Android, поэтому проверяем не «помним ли мы дерево», а
     * «отдаёт ли его система нам прямо сейчас».
     */
    fun hasAccess(context: Context, tree: String): Boolean {
        val uri = Uri.parse(tree)
        val granted = context.contentResolver.persistedUriPermissions.any {
            it.uri == uri && it.isReadPermission && it.isWritePermission
        }
        if (!granted) return false
        return stat(context, tree, "") != null
    }

    /** Имя папки для интерфейса. `null` — дерево недоступно. */
    fun label(context: Context, tree: String): String? {
        val uri = Uri.parse(tree)
        val root = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
        return query(context.contentResolver, root, DocumentsContract.Document.COLUMN_DISPLAY_NAME) { cursor ->
            cursor.getString(0)
        }
    }

    /** Умеет ли провайдер переименование — от этого зависит режим записи. */
    fun supportsRename(context: Context, tree: String): Boolean {
        val uri = Uri.parse(tree)
        val root = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
        val flags = query(context.contentResolver, root, DocumentsContract.Document.COLUMN_FLAGS) { cursor ->
            cursor.getInt(0)
        } ?: return false
        return flags and DocumentsContract.Document.FLAG_SUPPORTS_RENAME != 0
    }

    // ── Операции `VaultStorage` ─────────────────────────────────────────────

    /** JSON-массив записей каталога. `null` — каталога нет. */
    fun list(context: Context, tree: String, path: String): String? {
        val resolver = context.contentResolver
        val treeUri = Uri.parse(tree)
        val parent = documentId(context, tree, path, create = false) ?: return null
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parent)
        val out = JSONArray()

        resolver.query(
            children,
            arrayOf(
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            ),
            null,
            null,
            null,
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                val name = cursor.getString(0) ?: continue
                // Временные документы наши: наружу они не заметки и не файлы.
                if (name.startsWith(".") && name.endsWith(".tmp")) continue
                out.put(
                    JSONObject().apply {
                        put("name", name)
                        put("isDirectory", cursor.getString(1) == MIME_DIR)
                        put("size", if (cursor.isNull(2)) 0L else cursor.getLong(2))
                        put("mtime", if (cursor.isNull(3)) 0L else cursor.getLong(3))
                    },
                )
            }
        } ?: return null

        return out.toString()
    }

    /** Байты документа. `null` — документа нет. */
    fun read(context: Context, tree: String, path: String): ByteArray? {
        val id = documentId(context, tree, path, create = false) ?: return null
        val uri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tree), id)
        return try {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (error: Throwable) {
            null
        }
    }

    /** JSON `{size, mtime, isDirectory}`. `null` — документа нет. */
    fun stat(context: Context, tree: String, path: String): String? {
        val id = documentId(context, tree, path, create = false) ?: return null
        val uri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tree), id)
        return context.contentResolver.query(
            uri,
            arrayOf(
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
            ),
            null,
            null,
            null,
        )?.use { cursor ->
            if (!cursor.moveToFirst()) return@use null
            JSONObject().apply {
                put("size", if (cursor.isNull(0)) 0L else cursor.getLong(0))
                put("mtime", if (cursor.isNull(1)) 0L else cursor.getLong(1))
                put("isDirectory", cursor.getString(2) == MIME_DIR)
            }.toString()
        }
    }

    /**
     * Запись документа. Возвращает фактический режим (`staged`/`direct`).
     *
     * Порядок в `staged` выбран так, чтобы потеря питания в любой момент
     * оставляла на диске либо старую заметку целиком, либо новую целиком:
     * сначала полностью записывается временный документ, и только потом,
     * двумя короткими операциями, он занимает место старого.
     */
    fun write(context: Context, tree: String, path: String, data: ByteArray): String {
        val resolver = context.contentResolver
        val treeUri = Uri.parse(tree)
        val name = path.substringAfterLast('/')
        val parentPath = if (path.contains('/')) path.substringBeforeLast('/') else ""
        val parent = documentId(context, tree, parentPath, create = true)
            ?: throw IllegalStateException("не удалось создать папку: $parentPath")

        if (!supportsRename(context, tree)) {
            val target = childId(resolver, treeUri, parent, name)
                ?: createChild(resolver, treeUri, parent, MIME_FILE, name)
            writeBytes(resolver, DocumentsContract.buildDocumentUriUsingTree(treeUri, target), data)
            remember(tree, path, target)
            return MODE_DIRECT
        }

        val temporary = ".$name.${System.nanoTime()}.tmp"
        val staged = createChild(resolver, treeUri, parent, MIME_FILE, temporary)
        val stagedUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, staged)
        try {
            writeBytes(resolver, stagedUri, data)
        } catch (error: Throwable) {
            // Оборвалась запись — целевой документ не тронут, убираем следы.
            runCatching { DocumentsContract.deleteDocument(resolver, stagedUri) }
            throw error
        }

        val previous = childId(resolver, treeUri, parent, name)
        if (previous != null) {
            DocumentsContract.deleteDocument(
                resolver,
                DocumentsContract.buildDocumentUriUsingTree(treeUri, previous),
            )
        }
        val renamed = DocumentsContract.renameDocument(resolver, stagedUri, name)
            ?: throw IllegalStateException("не удалось переименовать временный документ")
        forget(tree)
        remember(tree, path, DocumentsContract.getDocumentId(renamed))
        return MODE_STAGED
    }

    fun mkdir(context: Context, tree: String, path: String) {
        documentId(context, tree, path, create = true)
            ?: throw IllegalStateException("не удалось создать папку: $path")
    }

    fun remove(context: Context, tree: String, path: String) {
        val id = documentId(context, tree, path, create = false) ?: return
        val uri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tree), id)
        DocumentsContract.deleteDocument(context.contentResolver, uri)
        forget(tree)
    }

    /**
     * Переименование. Смена папки провайдером не поддерживается, поэтому
     * переезд в другую папку делается копированием: прочитать, записать по
     * новому пути, удалить старое. Порядок именно такой — файл не исчезает
     * раньше, чем появится его копия.
     */
    fun rename(context: Context, tree: String, from: String, to: String) {
        val resolver = context.contentResolver
        val treeUri = Uri.parse(tree)
        val id = documentId(context, tree, from, create = false)
            ?: throw IllegalStateException("нечего переименовывать: $from")

        val sameFolder = from.substringBeforeLast('/', "") == to.substringBeforeLast('/', "")
        if (sameFolder && supportsRename(context, tree)) {
            val uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, id)
            DocumentsContract.renameDocument(resolver, uri, to.substringAfterLast('/'))
                ?: throw IllegalStateException("не удалось переименовать: $from")
            forget(tree)
            return
        }

        val data = read(context, tree, from) ?: throw IllegalStateException("нечего переименовывать: $from")
        write(context, tree, to, data)
        remove(context, tree, from)
    }

    // ── Внутреннее ──────────────────────────────────────────────────────────

    private fun writeBytes(resolver: ContentResolver, uri: Uri, data: ByteArray) {
        // "wt" — усечь до нуля перед записью: иначе хвост прежнего документа
        // остался бы за концом новых байтов.
        resolver.openOutputStream(uri, "wt")?.use { stream ->
            stream.write(data)
            stream.flush()
        } ?: throw IllegalStateException("провайдер не дал записать документ")
    }

    /**
     * `documentId` по пути внутри дерева. `create = true` — недостающие папки
     * создаются (аналог `mkdir -p`).
     */
    private fun documentId(context: Context, tree: String, path: String, create: Boolean): String? {
        val treeUri = Uri.parse(tree)
        val resolver = context.contentResolver
        var current = DocumentsContract.getTreeDocumentId(treeUri)
        if (path.isEmpty()) return current

        cache["$tree|$path"]?.let { return it }

        val walked = StringBuilder()
        for (segment in path.split('/')) {
            if (segment.isEmpty()) continue
            if (walked.isNotEmpty()) walked.append('/')
            walked.append(segment)

            val key = "$tree|$walked"
            val cached = cache[key]
            if (cached != null) {
                current = cached
                continue
            }

            val found = childId(resolver, treeUri, current, segment)
            current = when {
                found != null -> found
                !create -> return null
                // Последний сегмент пути создаётся папкой только в `mkdir`:
                // файлы создаёт `write`, и создавать их «по дороге» нельзя.
                else -> createChild(resolver, treeUri, current, MIME_DIR, segment)
            }
            cache[key] = current
        }
        return current
    }

    /** Ребёнок с таким именем. `null` — такого нет. */
    private fun childId(resolver: ContentResolver, treeUri: Uri, parent: String, name: String): String? {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parent)
        resolver.query(
            children,
            arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            ),
            null,
            null,
            null,
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                if (cursor.getString(1) == name) return cursor.getString(0)
            }
        }
        return null
    }

    private fun createChild(
        resolver: ContentResolver,
        treeUri: Uri,
        parent: String,
        mime: String,
        name: String,
    ): String {
        val parentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, parent)
        val created = DocumentsContract.createDocument(resolver, parentUri, mime, name)
            ?: throw IllegalStateException("провайдер не дал создать «$name»")
        val id = DocumentsContract.getDocumentId(created)
        // Провайдер вправе дать другое имя (`Заметка (1).md`) — тогда наш путь
        // указывает не туда, и молча делать вид, что всё в порядке, нельзя.
        val actual = query(resolver, created, DocumentsContract.Document.COLUMN_DISPLAY_NAME) { it.getString(0) }
        if (actual != null && actual != name) {
            runCatching { DocumentsContract.deleteDocument(resolver, created) }
            throw IllegalStateException("провайдер переименовал «$name» в «$actual»")
        }
        return id
    }

    private fun <T> query(resolver: ContentResolver, uri: Uri, column: String, read: (Cursor) -> T): T? =
        resolver.query(uri, arrayOf(column), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) read(cursor) else null
        }

    private fun remember(tree: String, path: String, id: String) {
        cache["$tree|$path"] = id
    }

    /** Дерево изменилось — старые `documentId` больше не обязаны быть верны. */
    private fun forget(tree: String) {
        cache.keys.removeAll { it.startsWith("$tree|") }
    }

    // ── Выбор папки ─────────────────────────────────────────────────────────

    /**
     * Забрать долгоживущее разрешение на выбранное дерево. Без этого доступ
     * умрёт вместе с процессом, и после перезапуска заметки «пропали бы».
     */
    fun persist(context: Context, uri: Uri) {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        context.contentResolver.takePersistableUriPermission(uri, flags)
        cache.clear()
    }
}
