package ru.cmpas.zapiski

import android.app.Activity
import android.app.Application
import android.os.Bundle
import io.appmetrica.analytics.AppMetrica
import io.appmetrica.analytics.AppMetricaConfig

/** Ключ выдан на домен zapiski.cmpas.ru — привязан к пакету, менять нельзя. */
private const val APPMETRICA_API_KEY = "d15d5479-3420-4deb-b830-ab0b6b08d1c1"

/**
 * Класс приложения. Нужен ровно за одним: знать текущую активность, не трогая
 * `MainActivity`, которую генерирует `tauri android init`.
 *
 * Наследоваться от сгенерированной активности мы намеренно не стали: её
 * содержимое задаёт шаблон Tauri и меняет от версии к версии. Оверлей, который
 * переписывает чужой сгенерированный файл, ломается при первом же обновлении
 * CLI — а `ActivityLifecycleCallbacks` работает с любой активностью и не
 * зависит ни от одной строки шаблона.
 */
class ZapiskiApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        // AppMetrica — чистый Kotlin/Java SDK, в отличие от нативного моста
        // ниже она не ждёт загрузки библиотеки Tauri и активируется сразу.
        AppMetrica.activate(this, AppMetricaConfig.newConfigBuilder(APPMETRICA_API_KEY).build())
        AppMetrica.enableActivityAutoTracking(this)
        // Контекст нужен виджетам и плитке: они живут в этом же процессе, но
        // активности могут не увидеть вовсе.
        NativeBridge.rememberContext(this)
        // А вот звать нативный мост здесь нельзя: библиотеку загружает
        // активность Tauri, и до её создания символов ещё нет.
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityCreated(activity: Activity, state: Bundle?) {
                NativeBridge.attach(activity)
            }

            override fun onActivityStarted(activity: Activity) = Unit

            override fun onActivityResumed(activity: Activity) {
                // Приложение вернулось на экран: пока его не было, пользователь
                // мог отметить чекбокс в виджете или поделиться ссылкой.
                NativeBridge.attach(activity)
                NativeBridge.pokeShare()
                NativeBridge.pokeWidgetCommand()
                // …или вернулся из браузера после входа (ТЗ §5.5).
                NativeBridge.pokeAuthCallback()
            }

            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit

            override fun onActivityDestroyed(activity: Activity) {
                NativeBridge.detach(activity)
            }
        })
    }
}
