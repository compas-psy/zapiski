/**
 * `UpdaterProvider` для Android.
 *
 * Встроенный апдейтер Tauri Android не поддерживает — там нет ни установщика,
 * ни проверки подписи пакета движком. Поэтому обновление собрано из штатных
 * средств платформы:
 *
 *   1. `updater_check` спрашивает фид
 *      `https://zapiski.cmpas.ru/api/v1/updates/android/{{current_version}}`.
 *      Сервер отвечает `204`, если новее нечего ставить (server/src/routes/
 *      updates.ts), и манифестом Tauri-формата, если есть.
 *   2. `updater_download_install` качает APK во внутренний кэш приложения и
 *      отдаёт его установщику пакетов через `FileProvider` +
 *      `ACTION_VIEW`/`ACTION_INSTALL_PACKAGE`.
 *
 * **Обновление ставится с согласия пользователя.** Системный установщик
 * показывает свой экран подтверждения, а решение начать скачивание принимает
 * `packages/app`, вызывая `downloadAndInstall()` после того, как пользователь
 * согласился. Оболочка ничего не устанавливает молча и не проверяет фид сама
 * по таймеру.
 *
 * Подпись APK проверяет сама Android: пакет с другой подписью установщик не
 * поставит поверх существующего. Отсюда требование к CI — keystore и алиас
 * не меняются между релизами (см. `.github/workflows/build-android.yml`).
 */
import type { UpdateInfo, UpdaterProvider } from '@zapiski/core';

import { COMMANDS, EVENTS, call, on } from './ipc';

export function createUpdater(): UpdaterProvider {
  let pending: UpdateInfo | null = null;

  return {
    async check() {
      // Сеть недоступна — это не ошибка приложения: BEHAVIOR §11 показывает
      // сетевые проблемы только в статусе синка, а не модалкой.
      const info = await call<UpdateInfo | null>(COMMANDS.updaterCheck).catch(() => null);
      pending = info;
      return info;
    },

    async downloadAndInstall(onProgress) {
      const update = pending ?? (await this.check());
      if (update === null) return;

      const stop =
        onProgress === undefined
          ? null
          : await on<number>(EVENTS.updateProgress, (fraction) => onProgress(fraction));

      try {
        await call<void>(COMMANDS.updaterInstall, { url: update.url });
      } finally {
        stop?.();
      }
    },
  };
}
