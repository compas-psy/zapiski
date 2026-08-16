/**
 * `AppHost` — всё, что приложение получает от Android. Больше ему ничего не
 * нужно (`packages/app/src/contract.ts`).
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import type { AppHost } from '@zapiski/app';

import { onAuthCallback, takeInitialAuthCallback } from './platform/auth';
import { onSystemBack } from './platform/back';
import { chosenSafTree, createPlatform, PREF_SAF_TREE, safAccessRevoked } from './platform/capabilities';
import { saveFile } from './platform/files';
import { createPdfRenderer } from './platform/pdf';
import { createPreferences } from './platform/prefs';
import { createSafStorage, openSafFile, probeSafTree } from './platform/saf';
import { currentVaultRoot, defaultVaultRoot, openVault } from './platform/vault';

/**
 * Дев-сборка ходит в облако по другому адресу — например, на ноутбук
 * разработчика в той же сети. Прод-значение зашито: адрес Облака Записок не
 * настраивается пользователем.
 */
// База ОБЯЗАНА включать префикс версии: приложение дописывает только путь
// ручки (см. AppHost.cloudBaseUrl). Без `/api/v1` вход уходил в 404.
const CLOUD_BASE_URL =
  (import.meta.env['VITE_CLOUD_BASE_URL'] as string | undefined) ??
  'https://zapiski.cmpas.ru/api/v1';

/**
 * Паузы перед повторной проверкой папки (мс). Ноль — первая попытка сразу.
 *
 * Заказчик третье утро подряд: «снова утро, снова пустота». Утро — холодный
 * старт: телефон ночью перезагрузился или Android убил процесс. Провайдер
 * папки в этот момент может быть ещё не поднят, и первая же проверка отвечает
 * «не подтверждаю». Ему нужна не тревога, а секунда времени.
 *
 * Дольше ждать нельзя: пауза перед списком заметок — это то, что человек видит
 * при каждом запуске, и платить ею за редкий случай было бы неправильно.
 */
const PROBE_DELAYS_MS = [0, 250, 750];

/**
 * Проверить дерево, дав провайдеру время проснуться.
 *
 * Три исхода, и путать их нельзя: `alive` — папка на месте; `answered: false` —
 * мост вообще не ответил (это «сейчас не знаю», выбор человека неприкосновенен);
 * `answered: true` при пустом `alive` — мост ответил «не подтверждаю», и вот
 * тогда есть смысл спрашивать систему, не отозвано ли разрешение.
 */
async function probePatiently(
  tree: string,
): Promise<{ alive: { uri: string } | null; answered: boolean }> {
  let answered = false;
  for (const delay of PROBE_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const alive = await probeSafTree(tree);
      answered = true;
      if (alive) return { alive, answered };
    } catch {
      /* Мост промолчал — пробуем ещё раз; повод забыть папку это не даёт. */
    }
  }
  return { alive: null, answered };
}

export function createHost(): AppHost {
  /* Настройки нужны и платформе: в них лежит выбранная папка (ТЗ §4.1 п. 1). */
  const prefs = createPreferences();

  return {
    platform: createPlatform(prefs),
    prefs,
    cloudBaseUrl: CLOUD_BASE_URL,

    // Печать есть: её делает системный конвейер Android (platform/pdf.ts),
    // поэтому пункт «PDF» в экспорте виден, а не скрыт.
    pdf: createPdfRenderer(),

    saveFile,

    /** Возврат после входа: `zapiski://` и App Links (см. `platform/auth.ts`). */
    takeInitialAuthCallback,
    onAuthCallback,

    /** Системная кнопка и жест «назад» (см. `platform/back.ts`). */
    onSystemBack,

    /**
     * Где лежат заметки. Порядок такой:
     *
     *  1. папка, выбранная пользователем через SAF (ТЗ §4.1 п. 1) — если
     *     разрешение на неё ещё действует;
     *  2. каталог приложения — умолчание и надёжный путь с атомарной
     *     записью (ТЗ §4.3).
     *
     * `null` означает «сейчас не знаю где» — приложение об этом СКАЖЕТ
     * (BEHAVIOR §11 «Папка недоступна…»), а не покажет пустой список.
     *
     * ── Почему проверка разбирает два случая, а не один ────────────────────
     *
     * Раньше здесь стояло `probeSafTree(tree).catch(() => null)`, и любой
     * отрицательный исход — хоть отозванное разрешение, хоть не ответивший
     * IPC — приводил к `prefs.set(PREF_SAF_TREE, null)`. То есть ОДНА
     * случайная неудача навсегда стирала адрес папки пользователя, после чего
     * открывался пустой каталог приложения. Со стороны это «заметки
     * сбросились и новую создать нельзя»: заметки на месте, просто мы больше
     * не знаем, где они, и дороги назад нет.
     *
     * Теперь:
     *   · проверка ответила `null` — доступа действительно нет (разрешение
     *     отозвали, папку удалили). Тогда и только тогда адрес забывается;
     *   · проверка не ответила вовсе — это НЕ отказ. Возвращаем `null`, не
     *     трогая сохранённый выбор: пусть человек увидит «папка недоступна» и
     *     попробует снова, чем мы молча подменим ему хранилище.
     */
    async restoreVault() {
      /* `chosenSafTree`, а не голая настройка: выбор мог не доехать до неё,
         если система убила процесс, пока был открыт системный выбор папки.
         Тогда след выбора — разрешение, выданное системой. */
      const tree = await chosenSafTree(prefs);
      if (tree !== null) {
        const { alive, answered } = await probePatiently(tree);
        if (alive) return createSafStorage(alive.uri);
        /* Мост не ответил вовсе — «сейчас не знаю», и точка. */
        if (!answered) return null;
        /* «Не подтвердилось» и «отозвано» — разные вещи, и второе доказывается
           только тем, что система больше не держит за нами разрешение. Утро
           после перезагрузки телефона выглядит как первое: провайдер папки не
           поднят, а выбор человека при этом в полном порядке. */
        if (!(await safAccessRevoked(tree))) return null;
        await prefs.set(PREF_SAF_TREE, null);
      }
      const known = await currentVaultRoot().catch(() => null);
      const root = known ?? (await defaultVaultRoot().catch(() => null));
      if (root === null) return null;
      return openVault(root);
    },

    /**
     * Открыть вложение системным приложением (замечание 16).
     *
     * Работает только для папки, выбранной через SAF: у каталога приложения
     * своего `content://` нет, и отдать файл чужому приложению оттуда нельзя.
     * `false` — приложение попробует прежний путь через `blob:`.
     */
    async openAttachment(path: string): Promise<boolean> {
      const tree = await chosenSafTree(prefs);
      if (tree === null) return false;
      return openSafFile(tree, path).catch(() => false);
    },

    async openExternal(url: string) {
      // Через системный обработчик: если у ссылки есть своё приложение,
      // открыть надо его, а не браузер.
      await openUrl(url);
    },
  };
}
