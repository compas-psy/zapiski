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
 *              временный документ, старая заметка отводится в сторону под
 *              служебным именем, и только потом временный занимает её место.
 *              Полная копия на диске есть в любой момент; если питание
 *              пропало между двумя переименованиями, отведённая версия
 *              возвращается на место при следующем обходе каталога;
 *   `direct` — не умеет: пишем прямо в целевой документ.
 *
 * Врать в эту сторону нельзя: интерфейс показывает пользователю ровно тот
 * режим, который вернулся отсюда.
 *
 * ── Про производительность ──────────────────────────────────────────────────
 *
 * У SAF нет «открыть по пути»: путь разбирается по сегментам, каждый — запрос
 * к провайдеру. Кэш `documentId` спасает и обход папок, и повторные чтения;
 * при записи, удалении и переименовании чистится ровно затронутый путь вместе
 * с тем, что под ним.
 */
object Saf {

    /** Что вернула запись — эти же слова уезжают в интерфейс. */
    const val MODE_STAGED = "staged"
    const val MODE_DIRECT = "direct"

    private const val MIME_DIR = DocumentsContract.Document.MIME_TYPE_DIR

    /**
     * Тип по расширению.
     *
     * Это не косметика. `createDocument` вправе ДОПИСАТЬ к имени расширение,
     * выведенное из типа: `Заметка.md` с типом `application/octet-stream`
     * штатный провайдер Android превращает в `Заметка.md.bin`. Путь заметки
     * обязан совпадать с именем файла байт в байт, поэтому тип подбирается
     * под расширение, а результат создания всё равно проверяется по имени.
     */
    private val MIME_BY_EXTENSION = mapOf(
        "md" to "text/markdown",
        "txt" to "text/plain",
        "csv" to "text/csv",
        "json" to "application/json",
        "pdf" to "application/pdf",
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "gif" to "image/gif",
        "webp" to "image/webp",
        "svg" to "image/svg+xml",
        "mp3" to "audio/mpeg",
        "m4a" to "audio/mp4",
        "ogg" to "audio/ogg",
        "wav" to "audio/x-wav",
        "mp4" to "video/mp4",
        "zip" to "application/zip",
    )

    /**
     * Тип для незнакомого расширения (`.md.enc`, `.bin`).
     *
     * Именно незнакомый системе: у известного типа провайдер попытается
     * привести имя к «правильному» расширению, а у незнакомого — оставит имя
     * как есть. Нам нужно второе.
     */
    private const val MIME_OPAQUE = "application/x-zapiski"

    /**
     * Имя отведённой в сторону заметки: `.<имя>.<наносекунды>.old.tmp`.
     * Из него восстанавливается исходное имя, если запись оборвалась.
     */
    private val BACKUP_NAME = Regex("""^\.(.+)\.\d+\.old\.tmp$""")

    private fun mimeOf(name: String): String {
        val extension = name.substringAfterLast('.', "").lowercase()
        return MIME_BY_EXTENSION[extension] ?: MIME_OPAQUE
    }

    /** `дерево|путь` → `documentId`. Чистится точечно, по изменённым путям. */
    private val cache = HashMap<String, String>()

    /** `дерево` → умеет ли провайдер переименование. */
    private val renameSupport = HashMap<String, Boolean>()

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

    /**
     * Умеет ли провайдер переименование — от этого зависит режим записи.
     *
     * Ответ кэшируется: его спрашивает каждая запись, а запись случается на
     * каждом автосохранении (BEHAVIOR §0, debounce 500 мс). Свойство дерева
     * за время сеанса не меняется.
     */
    fun supportsRename(context: Context, tree: String): Boolean {
        renameSupport[tree]?.let { return it }
        val uri = Uri.parse(tree)
        val root = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
        val flags = query(context.contentResolver, root, DocumentsContract.Document.COLUMN_FLAGS) { cursor ->
            cursor.getInt(0)
        } ?: return false
        val supported = flags and DocumentsContract.Document.FLAG_SUPPORTS_RENAME != 0
        renameSupport[tree] = supported
        return supported
    }

    // ── Операции `VaultStorage` ─────────────────────────────────────────────

    /** JSON-массив записей каталога. `null` — каталога нет. */
    fun list(context: Context, tree: String, path: String): String? {
        val resolver = context.contentResolver
        val treeUri = Uri.parse(tree)
        val parent = documentId(context, tree, path, create = false) ?: return null
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parent)

        val rows = ArrayList<JSONObject>()
        val names = HashSet<String>()
        /** Отведённые в сторону заметки: `имя` → `documentId` копии. */
        val backups = HashMap<String, String>()

        resolver.query(
            children,
            arrayOf(
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            ),
            null,
            null,
            null,
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                val name = cursor.getString(0) ?: continue
                if (name.startsWith(".") && name.endsWith(".tmp")) {
                    // Временные документы наши, и наружу они не отдаются. Но
                    // отведённую в сторону заметку надо запомнить: если её
                    // место осталось пустым, значит запись оборвалась.
                    BACKUP_NAME.find(name)?.let { match ->
                        backups[match.groupValues[1]] = cursor.getString(4)
                    }
                    continue
                }
                names.add(name)
                rows.add(
                    JSONObject().apply {
                        put("name", name)
                        put("isDirectory", cursor.getString(1) == MIME_DIR)
                        put("size", if (cursor.isNull(2)) 0L else cursor.getLong(2))
                        put("mtime", if (cursor.isNull(3)) 0L else cursor.getLong(3))
                    },
                )
            }
        } ?: return null

        // Запись оборвалась между двумя переименованиями: новая версия не
        // встала на место, старая лежит рядом под служебным именем. Возвращаем
        // её — пользователь остаётся с прежней версией заметки, а не без неё
        // (ТЗ §2.1.4: потерь не бывает).
        for ((name, id) in backups) {
            if (names.contains(name)) continue
            val restored = runCatching {
                DocumentsContract.renameDocument(
                    resolver,
                    DocumentsContract.buildDocumentUriUsingTree(treeUri, id),
                    name,
                )
            }.getOrNull() ?: continue
            forgetPath(tree, if (path.isEmpty()) name else "$path/$name")
            val size = query(resolver, restored, DocumentsContract.Document.COLUMN_SIZE) { it.getLong(0) } ?: 0L
            rows.add(
                JSONObject().apply {
                    put("name", name)
                    put("isDirectory", false)
                    put("size", size)
                    put("mtime", 0L)
                },
            )
        }

        val out = JSONArray()
        for (row in rows) out.put(row)
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
     * оставляла на диске полную копию заметки — старую либо новую: сначала
     * целиком записывается временный документ, затем старая заметка отводится
     * в сторону, и лишь потом временный занимает её имя. Ни в одной точке нет
     * состояния «обеих версий нет».
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
                ?: createChild(resolver, treeUri, parent, mimeOf(name), name, verifyName = true)
            writeBytes(resolver, DocumentsContract.buildDocumentUriUsingTree(treeUri, target), data)
            remember(tree, path, target)
            return MODE_DIRECT
        }

        // Имя временного документа проверять незачем: работаем по его
        // `documentId`, а нужное имя он получит переименованием — и вот там
        // провайдер уже обязан взять имя как есть.
        val temporary = ".$name.${System.nanoTime()}.tmp"
        val staged = createChild(resolver, treeUri, parent, mimeOf(name), temporary, verifyName = false)
        val stagedUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, staged)
        try {
            writeBytes(resolver, stagedUri, data)
        } catch (error: Throwable) {
            // Оборвалась запись — целевой документ не тронут, убираем следы.
            runCatching { DocumentsContract.deleteDocument(resolver, stagedUri) }
            throw error
        }

        // Старую заметку не удаляем, а отводим в сторону: между удалением и
        // переименованием есть момент, когда файла с нужным именем нет вовсе,
        // и падение ровно в нём стоило бы пользователю заметки. После отвода
        // на диске всегда есть хотя бы одна полная копия.
        val previous = childId(resolver, treeUri, parent, name)
        val backup = previous?.let { id ->
            val moved = DocumentsContract.renameDocument(
                resolver,
                DocumentsContract.buildDocumentUriUsingTree(treeUri, id),
                ".$name.${System.nanoTime()}.old.tmp",
            )
            // `null` — имя сменилось, а адрес документа прежний.
            if (moved == null) id else DocumentsContract.getDocumentId(moved)
        }

        val renamedUri = try {
            // `null` в этом API означает «имя сменилось, адрес прежний».
            DocumentsContract.renameDocument(resolver, stagedUri, name) ?: stagedUri
        } catch (error: Throwable) {
            restore(resolver, treeUri, backup, name)
            runCatching { DocumentsContract.deleteDocument(resolver, stagedUri) }
            throw error
        }

        val actual = query(resolver, renamedUri, DocumentsContract.Document.COLUMN_DISPLAY_NAME) { it.getString(0) }
        if (actual != name) {
            // Провайдер дал документу другое имя. Молча оставить его нельзя:
            // путь заметки в vault'е и имя файла разошлись бы, а заметка
            // «пропала» бы из списка. Возвращаем старую и говорим прямо.
            runCatching { DocumentsContract.deleteDocument(resolver, renamedUri) }
            restore(resolver, treeUri, backup, name)
            throw IllegalStateException("провайдер переименовал «$name» в «${actual ?: "без имени"}»")
        }

        backup?.let {
            runCatching {
                DocumentsContract.deleteDocument(resolver, DocumentsContract.buildDocumentUriUsingTree(treeUri, it))
            }
        }
        forgetPath(tree, path)
        remember(tree, path, DocumentsContract.getDocumentId(renamedUri))
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
        forgetPath(tree, path)
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
            val target = to.substringAfterLast('/')
            // `null` в этом API означает «имя сменилось, адрес прежний».
            val renamedUri = DocumentsContract.renameDocument(resolver, uri, target) ?: uri
            val actual = query(resolver, renamedUri, DocumentsContract.Document.COLUMN_DISPLAY_NAME) {
                it.getString(0)
            }
            if (actual != target) throw IllegalStateException("не удалось переименовать: $from")
            forgetPath(tree, from)
            forgetPath(tree, to)
            return
        }

        val data = read(context, tree, from) ?: throw IllegalStateException("нечего переименовывать: $from")
        write(context, tree, to, data)
        remove(context, tree, from)
    }

    // ── Внутреннее ──────────────────────────────────────────────────────────

    /**
     * Вернуть отведённую в сторону заметку на её место. Вызывается на любом
     * пути отказа записи: пользователь остаётся с прежней версией, а не без
     * заметки вовсе (ТЗ §2.1.4 — потерь не бывает).
     */
    private fun restore(resolver: ContentResolver, treeUri: Uri, backup: String?, name: String) {
        if (backup == null) return
        runCatching {
            DocumentsContract.renameDocument(
                resolver,
                DocumentsContract.buildDocumentUriUsingTree(treeUri, backup),
                name,
            )
        }
    }

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
                // По дороге создаются только папки: файл создаёт `write`.
                else -> createChild(resolver, treeUri, current, MIME_DIR, segment, verifyName = true)
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

    /**
     * Создать документ. `verifyName` — обязана ли фактическая запись
     * называться именно так: провайдер вправе дать своё имя (`Заметка (1).md`,
     * `Заметка.md.bin`), а путь заметки и имя файла обязаны совпадать.
     */
    private fun createChild(
        resolver: ContentResolver,
        treeUri: Uri,
        parent: String,
        mime: String,
        name: String,
        verifyName: Boolean,
    ): String {
        val parentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, parent)
        val created = DocumentsContract.createDocument(resolver, parentUri, mime, name)
            ?: throw IllegalStateException("провайдер не дал создать «$name»")
        val id = DocumentsContract.getDocumentId(created)
        if (!verifyName) return id

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

    /**
     * Путь изменился — его `documentId` (и всё, что под ним) больше не
     * обязан быть верным. Чистим точечно: полная очистка на каждом
     * автосохранении заставляла бы заново обходить дерево при следующем
     * чтении, а обход в SAF — запрос на каждый сегмент пути.
     */
    private fun forgetPath(tree: String, path: String) {
        val exact = "$tree|$path"
        val nested = "$exact/"
        cache.keys.removeAll { it == exact || it.startsWith(nested) }
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
