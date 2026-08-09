/**
 * Порт `UpdaterProvider` поверх `tauri-plugin-updater`.
 *
 * Эндпоинт и публичный ключ подписи объявлены в `tauri.conf.json`. Приватный
 * ключ живёт только в секрете CI (`TAURI_SIGNING_PRIVATE_KEY`) — в
 * репозитории его нет и быть не должно: подпись проверяется на клиенте перед
 * установкой, и утечка ключа означала бы возможность подсунуть пользователю
 * чужой установщик.
 *
 * Сервер отвечает 204, когда обновления нет (`server/src/routes/updates.ts`),
 * поэтому «нет апдейта» — это `null`, а не ошибка.
 */
import { ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import type { UpdateInfo, UpdaterProvider } from '@zapiski/core';

import type { PlatformStrings } from './strings';

/** Проверка раз в сутки (требование задачи). */
const DAILY_MS = 24 * 60 * 60 * 1000;

/**
 * Пауза перед первой проверкой. Холодный старт Windows по ТЗ §6 — меньше 2 с,
 * и тратить их на сетевой запрос нельзя: обновление подождёт, пользователь —
 * нет.
 */
const FIRST_CHECK_DELAY_MS = 8_000;

export class NativeUpdater implements UpdaterProvider {
  /** Найденное обновление держим открытым: скачивать будем именно его. */
  private pending: Update | null = null;

  async check(): Promise<UpdateInfo | null> {
    await this.release();
    const update = await check();
    if (update === null) return null;

    this.pending = update;
    return {
      version: update.version,
      notes: update.body ?? '',
      pubDate: update.date ?? '',
      url: downloadUrl(update),
    };
  }

  /**
   * Скачать и установить. Согласие пользователя спрашивает вызывающий: порт
   * ничего не рисует, а `packages/app` — рисует.
   */
  async downloadAndInstall(onProgress?: (fraction: number) => void): Promise<void> {
    const update = this.pending ?? (await check());
    if (update === null) return;
    this.pending = update;

    let total = 0;
    let received = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0;
        onProgress?.(0);
      } else if (event.event === 'Progress') {
        received += event.data.chunkLength;
        /* Без Content-Length доля неизвестна — не выдумываем её, а молчим:
           индикатор без числа честнее, чем поехавший процент. */
        if (total > 0) onProgress?.(Math.min(received / total, 1));
      } else {
        onProgress?.(1);
      }
    });

    await this.release();
    /* На Windows установщик запускается отдельным процессом и требует, чтобы
       приложение закрылось. `relaunch` закрывает его и поднимает уже
       обновлённую версию. */
    await relaunch();
  }

  private async release(): Promise<void> {
    const update = this.pending;
    this.pending = null;
    if (update !== null) await update.close().catch(() => {});
  }
}

/**
 * Расписание проверок: одна при старте (с задержкой) и одна раз в сутки.
 *
 * Согласие спрашивается системным диалогом Windows, а не своим экраном:
 * экранов у оболочки нет (ARCHITECTURE §1), и рисовать их здесь нельзя.
 * Когда в `packages/app` появится собственный экран обновления, расписание
 * переезжает туда, а отсюда удаляется — порт для этого уже есть.
 */
export function scheduleUpdateChecks(
  updater: UpdaterProvider,
  strings: PlatformStrings,
): () => void {
  /* От какой версии пользователь уже отказался — не спрашиваем повторно до
     перезапуска. Ежедневное «обновить?» на одну и ту же версию — это
     навязчивость, а не забота. */
  let declined: string | null = null;
  let busy = false;

  const run = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const info = await updater.check();
      if (info === null || info.version === declined) return;

      const agreed = await ask(strings.update.question(info.version), {
        title: strings.update.title,
        kind: 'info',
        okLabel: strings.update.install,
        cancelLabel: strings.update.later,
      });
      if (!agreed) {
        declined = info.version;
        return;
      }
      await updater.downloadAndInstall();
    } catch {
      /* Нет сети, сервер отвечает мусором, подпись не сошлась — приложение
         продолжает работать на текущей версии. Обновление не тот случай,
         когда пользователя надо беспокоить сообщением об ошибке. */
    } finally {
      busy = false;
    }
  };

  const first = setTimeout(() => void run(), FIRST_CHECK_DELAY_MS);
  const daily = setInterval(() => void run(), DAILY_MS);

  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}

/**
 * Ссылка на установщик из сырого манифеста. Плагин её не публикует отдельно,
 * а контракту `UpdateInfo.url` она нужна.
 */
function downloadUrl(update: Update): string {
  const platforms = (update.rawJson as { platforms?: Record<string, { url?: string }> }).platforms;
  if (platforms === undefined) return '';
  for (const entry of Object.values(platforms)) {
    if (typeof entry.url === 'string') return entry.url;
  }
  return '';
}
