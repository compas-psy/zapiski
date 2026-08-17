package ru.cmpas.zapiski

import android.app.Activity
import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

/**
 * `BiometricProvider`: Android Keystore + BiometricPrompt.
 *
 * Схема (BEHAVIOR §5.1—5.2):
 *
 *   enroll  — в Keystore заводится AES-ключ с `setUserAuthenticationRequired`,
 *             им шифруется секрет, шифротекст ложится в приватный каталог
 *             приложения. Сам ключ Keystore не покидает никогда, а секрет
 *             лежит на диске только зашифрованным.
 *   unlock  — `BiometricPrompt` с `CryptoObject`: ключ становится пригоден
 *             к использованию только после успешной биометрии.
 *
 * **Честность вместо галочки.** `available()` возвращает `true`, только если
 * на устройстве настроена стойкая биометрия и версия Android умеет
 * `BiometricPrompt` (API 28+). Иначе — `false`, и UI **скроет** тумблер
 * (BEHAVIOR §5.1), а не покажет его выключенным.
 *
 * `setInvalidatedByBiometricEnrollment(true)` — сознательное решение: если в
 * систему добавили новый отпечаток, ключ становится непригодным. Это ровно то
 * поведение, которого ждёт человек, отдавший телефон в чужие руки на минуту.
 * Заметка при этом не теряется: пароль продолжает работать.
 */
object Biometrics {

    private const val KEY_PREFIX = "zapiski."
    private const val DIR = "biometrics"
    private const val TRANSFORMATION =
        "${KeyProperties.KEY_ALGORITHM_AES}/${KeyProperties.BLOCK_MODE_GCM}/${KeyProperties.ENCRYPTION_PADDING_NONE}"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val TAG_BITS = 128
    private const val IV_BYTES = 12

    fun available(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
        return try {
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> {
                    val manager = context.getSystemService(BiometricManager::class.java)
                    manager?.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
                        BiometricManager.BIOMETRIC_SUCCESS
                }
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> {
                    val manager = context.getSystemService(BiometricManager::class.java)
                    @Suppress("DEPRECATION")
                    manager?.canAuthenticate() == BiometricManager.BIOMETRIC_SUCCESS
                }
                else -> {
                    // На Android 9 отдельного BiometricManager ещё нет.
                    val manager = context.getSystemService(android.hardware.fingerprint.FingerprintManager::class.java)
                    @Suppress("DEPRECATION")
                    manager != null && manager.isHardwareDetected && manager.hasEnrolledFingerprints()
                }
            }
        } catch (error: Throwable) {
            false
        }
    }

    fun enroll(activity: Activity?, context: Context, requestId: Long, keyId: String, secret: ByteArray) {
        if (activity == null) {
            NativeBridge.result(requestId, false, "биометрия доступна только при открытом приложении", null)
            return
        }
        try {
            val key = createKey(alias(keyId))
            val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key) }

            // Ключ заведён с `userAuthenticationRequired`, поэтому даже
            // шифрование требует биометрии. Это не лишний шаг: человек, включая
            // тумблер, ровно один раз подтверждает, что телефон в его руках.
            prompt(
                activity,
                context,
                cipher,
                failed = { error ->
                    // Ключ без сохранённого шифротекста бесполезен и мешает
                    // следующей попытке: `createKey` перезапишет псевдоним, а
                    // старый файл остался бы читаться чужим ключом.
                    remove(context, keyId)
                    NativeBridge.result(requestId, false, describe(error), null)
                },
            ) { authenticated ->
                if (authenticated == null) {
                    // Отмена при включении тумблера: ключ не нужен.
                    remove(context, keyId)
                    NativeBridge.result(requestId, false, "включение биометрии отменено", null)
                    return@prompt
                }
                try {
                    val encrypted = authenticated.doFinal(secret)
                    store(context, keyId).writeBytes(authenticated.iv + encrypted)
                    NativeBridge.result(requestId, true, null, null)
                } catch (error: Throwable) {
                    remove(context, keyId)
                    NativeBridge.result(requestId, false, error.message ?: "не удалось сохранить ключ", null)
                }
            }
        } catch (error: Throwable) {
            NativeBridge.result(requestId, false, error.message ?: "биометрия недоступна", null)
        }
    }

    fun unlock(activity: Activity?, context: Context, requestId: Long, keyId: String) {
        if (activity == null) {
            NativeBridge.result(requestId, false, "биометрия доступна только при открытом приложении", null)
            return
        }
        try {
            val file = store(context, keyId)
            if (!file.exists()) {
                NativeBridge.result(requestId, false, "для этой заметки биометрия не настроена", null)
                return
            }
            val blob = file.readBytes()
            if (blob.size <= IV_BYTES) {
                NativeBridge.result(requestId, false, "повреждён ключ биометрии", null)
                return
            }

            val key = loadKey(alias(keyId))
            if (key == null) {
                // Ключ инвалидирован — например, в систему добавили отпечаток.
                // Это не ошибка приложения: остаётся ввод пароля.
                NativeBridge.result(requestId, true, null, null)
                return
            }

            val iv = blob.copyOfRange(0, IV_BYTES)
            val payload = blob.copyOfRange(IV_BYTES, blob.size)
            val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
            }

            prompt(
                activity,
                context,
                cipher,
                failed = { error -> NativeBridge.result(requestId, false, describe(error), null) },
            ) { authenticated ->
                if (authenticated == null) {
                    // Отмена биометрии пользователем — не ошибка (BEHAVIOR §5.2):
                    // `ok = true` и пустые данные означают «показать пароль».
                    NativeBridge.result(requestId, true, null, null)
                    return@prompt
                }
                try {
                    NativeBridge.result(requestId, true, null, authenticated.doFinal(payload))
                } catch (error: Throwable) {
                    NativeBridge.result(requestId, false, error.message ?: "не удалось прочитать ключ", null)
                }
            }
        } catch (error: Throwable) {
            NativeBridge.result(requestId, false, error.message ?: "биометрия недоступна", null)
        }
    }

    fun remove(context: Context, keyId: String) {
        try {
            keystore().deleteEntry(alias(keyId))
        } catch (error: Throwable) {
            // Записи может не быть — это нормальный исход удаления.
        }
        try {
            store(context, keyId).delete()
        } catch (error: Throwable) {
            // Файла может не быть.
        }
    }

    // ── Внутреннее ──────────────────────────────────────────────────────────

    /**
     * `keyId` — путь заметки в vault'е: кириллица, слэши, пробелы. Псевдоним
     * Keystore таких вольностей не любит, поэтому берём SHA-256.
     */
    private fun alias(keyId: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(keyId.toByteArray(Charsets.UTF_8))
        return KEY_PREFIX + digest.joinToString("") { "%02x".format(it) }
    }

    private fun store(context: Context, keyId: String): File {
        val directory = File(context.filesDir, DIR).apply { mkdirs() }
        return File(directory, alias(keyId) + ".bin")
    }

    private fun keystore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun createKey(alias: String): SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        generator.init(builder.build())
        return generator.generateKey()
    }

    /** `null` — ключа нет или он инвалидирован системой. */
    private fun loadKey(alias: String): SecretKey? = try {
        keystore().getKey(alias, null) as? SecretKey
    } catch (error: Throwable) {
        null
    }

    /**
     * Системный диалог биометрии. `null` в колбэке — отмена или неуспех;
     * различать их незачем: BEHAVIOR §5.2 в обоих случаях показывает поле
     * пароля без единого сообщения.
     *
     * ── Почему здесь два уровня try/catch ───────────────────────────────────
     *
     * Всё, что ниже, выполняется на ГЛАВНОМ потоке: сам показ — через
     * `runOnUiThread`, колбэки — через `mainExecutor`. А вызывающая сторона
     * (`enroll`/`unlock`) к этому моменту уже вернулась из своего `try`, и её
     * `catch` до сюда не достаёт. Значит любое исключение отсюда — необработанное
     * исключение главного потока, то есть смерть процесса.
     *
     * Именно так выглядел отказ, с которым пришёл заказчик: «при включении
     * биометрии приложение просто крашится». Ни тоста, ни строки в обратной
     * связи — потому что показать их было уже некому. Первый кандидат на само
     * исключение — `SecurityException` от `authenticate()` без разрешения
     * `USE_BIOMETRIC` (его в манифесте не было; см. `apply-android-overlay.mjs`),
     * но починка нужна независимо от того, какое исключение окажется там
     * завтра: диалог биометрии не имеет права уносить с собой приложение.
     *
     * `failed` отделён от `done(null)` намеренно. `done(null)` означает
     * «человек отказался, покажите пароль» — нормальный исход. Отказ системы —
     * другое дело: он обязан назвать причину словами, иначе на устройстве, где
     * консоли нет, разбираться будет нечем.
     */
    private fun prompt(
        activity: Activity,
        context: Context,
        cipher: Cipher,
        failed: (Throwable) -> Unit,
        done: (Cipher?) -> Unit,
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            done(null)
            return
        }
        activity.runOnUiThread {
            /* Колбэки системы приходят на главный поток так же, как этот блок,
               и точно так же не имеют права из него выпасть. */
            val deliver = { authenticated: Cipher? ->
                try {
                    done(authenticated)
                } catch (error: Throwable) {
                    failed(error)
                }
            }
            try {
                val builder = BiometricPrompt.Builder(context)
                    .setTitle(context.getString(R.string.biometric_title))
                    .setSubtitle(context.getString(R.string.biometric_subtitle))
                    .setNegativeButton(
                        context.getString(R.string.biometric_cancel),
                        context.mainExecutor,
                    ) { _, _ -> deliver(null) }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    builder.setConfirmationRequired(false)
                }

                builder.build().authenticate(
                    BiometricPrompt.CryptoObject(cipher),
                    CancellationSignal(),
                    context.mainExecutor,
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            deliver(result.cryptoObject?.cipher)
                        }

                        override fun onAuthenticationError(code: Int, message: CharSequence) {
                            deliver(null)
                        }

                        override fun onAuthenticationFailed() {
                            // Палец не подошёл — диалог остаётся открытым и человек
                            // пробует ещё раз. Ответ Rust'у здесь не отправляем.
                        }
                    },
                )
            } catch (error: Throwable) {
                failed(error)
            }
        }
    }

    /**
     * Причина отказа словами — с классом исключения.
     *
     * `SecurityException` и `IllegalStateException` в этом месте означают разные
     * поломки сборки, а `message` у обеих бывает пустым. Без класса человек
     * получил бы «биометрия недоступна» на любой из них, и починить по такому
     * сообщению нечего. Содержимого заметок здесь нет и быть не может: сюда
     * попадают только исключения системного диалога.
     */
    private fun describe(error: Throwable): String {
        val kind = error.javaClass.simpleName
        val message = error.message?.takeIf { it.isNotBlank() }
        return if (message == null) "биометрия недоступна: $kind" else "биометрия недоступна: $kind: $message"
    }
}
