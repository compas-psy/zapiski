package ru.cmpas.zapiski

import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.io.File

/**
 * Файловые очереди между процессными состояниями приложения.
 *
 * Виджет, плитка Quick Settings и «Поделиться» работают, когда приложения в
 * памяти может не быть вовсе. Поэтому всё, что делает пользователь снаружи,
 * сначала ложится строкой в файл, а Rust забирает файл, когда фронтенд готов
 * (`src-tauri/src/platform.rs`, `widgets.rs`).
 *
 * Формат — JSONL: одна команда = одна строка. Дописывание строки в конец
 * файла переживает и убийство процесса (потеряется максимум последняя,
 * недописанная строка, и разбор её пропустит), и одновременную запись из
 * разных процессов.
 */
object Inbox {

    private const val DIR = "inbox"
    private const val SHARE = "share.jsonl"
    private const val QUICK_NOTE = "quick-note"
    private const val AUTH = "auth.jsonl"

    private fun dir(context: Context): File = File(context.filesDir, DIR).apply { mkdirs() }

    /** Положить в очередь share-payload и разбудить приложение, если оно живо. */
    fun putShare(context: Context, payload: JSONObject) {
        append(File(dir(context), SHARE), payload.toString())
        NativeBridge.pokeShare()
    }

    /**
     * Отметить «нажали „Записать“».
     *
     * Отметка — пустой файл, а не счётчик: десять тапов по плитке подряд
     * означают одно намерение, а не десять новых заметок.
     */
    fun markQuickNote(context: Context) {
        File(dir(context), QUICK_NOTE).also { if (!it.exists()) it.createNewFile() }
        NativeBridge.pokeQuickNote()
    }

    /**
     * Положить в очередь адрес возврата после входа и разбудить приложение.
     *
     * Одна строка = один переход. Адрес не пишется в журнал ни здесь, ни
     * дальше по дороге: во фрагменте едет токен сессии (ТЗ §5.5).
     */
    fun putAuth(context: Context, url: String) {
        append(File(dir(context), AUTH), url.replace("\n", ""))
        NativeBridge.pokeAuthCallback()
    }

    /** Дописать строку. Ошибку глотаем: очередь — не источник истины. */
    fun append(file: File, line: String) {
        try {
            file.parentFile?.mkdirs()
            file.appendText(line + "\n")
        } catch (error: Throwable) {
            // Некуда записать — значит, действие не доедет до приложения.
            // Показать это пользователю оболочка не может (у виджета нет
            // экрана), а падать в чужом процессе тем более нельзя.
        }
    }

    /**
     * Поднять приложение на передний план.
     *
     * Ни один экран здесь не рисуется: оболочка только просит систему открыть
     * приложение, а что показать — решает `packages/app` (ARCHITECTURE §1).
     */
    fun launchApp(context: Context) {
        val intent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        context.startActivity(intent)
    }
}
