/**
 * `PlatformCapabilities` для Android — единственное место, где эта платформа
 * отличается от Windows и веба.
 *
 * Что есть и чего нет:
 *
 *   biometrics    — Android Keystore + BiometricPrompt (см. biometrics.ts);
 *   haptics       — есть, единственная из трёх платформ (BEHAVIOR §0);
 *   globalHotkey  — `null`. Глобального хоткея на Android не существует:
 *                   у платформы нет ни системных акселераторов для приложений,
 *                   ни фонового слушателя клавиатуры. Эквивалент быстрой
 *                   заметки — плитка Quick Settings и виджет 1×1 (§8);
 *   shareTarget   — есть, `intent-filter` ACTION_SEND;
 *   updater       — есть, свой (встроенный апдейтер Tauri на Android не
 *                   работает — см. updater.ts);
 *   vaultFolders  — есть, и только здесь: на Android выбор папки идёт с
 *                   оговоркой про атомарность записи (см. ниже).
 *
 * `null` означает «UI **скроет** элемент», а не «покажет выключенным»
 * (BEHAVIOR §5.1). Поэтому подделывать возможности нельзя ни при каких
 * обстоятельствах: скрытый тумблер честен, выключенный — обманывает.
 */
import { LOCAL_OWNER } from '@zapiski/core';
import type { PlatformCapabilities, VaultLocation, VaultLocationInfo } from '@zapiski/core';
import type { PreferencesStore } from '@zapiski/app';

import { createBiometrics } from './biometrics';
import { createHaptics } from './haptics';
import { COMMANDS, call } from './ipc';
import {
  createSafStorage,
  persistedSafTrees,
  pickSafTree,
  probeSafTree,
  releaseSafTrees,
  writeModeOf,
  type SafTree,
} from './saf';
import { createShareOut, createShareTarget } from './share';
import { createUpdater } from './updater';
import { defaultVaultRoot, openVault } from './vault';

/**
 * Дерево SAF, выбранное пользователем. Лежит в настройках рядом с остальным:
 * это не секрет, а адрес папки, и он обязан пережить перезапуск — иначе
 * заметки «пропадут» вместе с выбором.
 */
export const PREF_SAF_TREE = 'storage.androidTree';
/**
 * Кто занял папку, выбранную до появления учёток.
 *
 * Заявка делается один раз и не переигрывается — решение заказчика «оставить
 * хозяину, кто вошёл первым». Ни один файл при этом не двигается: чужая
 * учётка получает своё место, а прежние заметки остаются там, где лежали.
 */
export const PREF_SAF_CLAIM = 'storage.androidTree.legacyOwner';

/** Ключ выбранной папки для владельца. */
export function safTreeKeyOf(owner: string): string {
  return `${PREF_SAF_TREE}.${owner}`;
}

/**
 * Корень владельца внутри каталога приложения.
 *
 * Первому спросившему достаётся сам каталог — его заметки уже там, и двигать
 * их нельзя. Остальным заводится подпапка по ключу владельца; имя
 * обеззараживается, потому что почта содержит `@` и точки, а имя каталога —
 * это имя каталога.
 */
export async function ownedRoot(
  prefs: PreferencesStore,
  base: string,
  owner: string,
): Promise<string> {
  const claimed = await prefs.get<string | null>(PREF_SAF_CLAIM, null);
  if (claimed === null) {
    await prefs.set(PREF_SAF_CLAIM, owner);
    return base;
  }
  if (claimed === owner) return base;
  return `${base}/.owners/${owner.replace(/[^a-z0-9._-]+/gi, '_')}`;
}

/** Имя каталога приложения в интерфейсе — не путь: путь пользователю не нужен. */
const APP_FOLDER_LABEL = 'Записки';

/**
 * Дерево, которое приложение считает выбранным. `null` — выбора нет, заметки
 * лежат в каталоге приложения.
 *
 * ── Почему одной настройки мало ─────────────────────────────────────────────
 *
 * Настройка пишется в самом конце: система вернула адрес папки → Rust отдал
 * его в JS → JS записал. Пока открыт системный выбор, приложение в фоне, и
 * Android вправе убить его процесс. Тогда результат приходит уже в новый
 * процесс: разрешение на папку забирается, а тот, кто ждал ответа, не
 * существует — и до настройки адрес не доезжает. Человек выбрал папку,
 * вернулся, а список прежний и пустой: «папка не выбирается».
 *
 * Разрешение при этом осталось в системе и переживает перезапуск. Значит,
 * надёжный след выбора — оно, а настройка лишь его копия. Копии нет —
 * восстанавливаем по следу и чиним копию.
 *
 * Обратная сторона обязательна: «вернуться в каталог приложения» ОТПУСКАЕТ
 * разрешения (`useAppFolder`), иначе восстановление молча утащило бы человека
 * назад в папку, из которой он ушёл.
 */
export async function chosenSafTree(
  prefs: PreferencesStore,
  owner: string = LOCAL_OWNER,
): Promise<string | null> {
  const own = await prefs.get<string | null>(safTreeKeyOf(owner), null);
  if (own !== null) return own;

  /* Папка, выбранная до появления учёток, достаётся первому спросившему. */
  const legacy = await prefs.get<string | null>(PREF_SAF_TREE, null);
  const claimed = await prefs.get<string | null>(PREF_SAF_CLAIM, null);
  if (legacy !== null) {
    if (claimed === null) {
      await prefs.set(PREF_SAF_CLAIM, owner);
      return legacy;
    }
    if (claimed === owner) return legacy;
    /* Папка занята другим владельцем — своей у этого пока нет. */
    return null;
  }
  /* Владелец, за которым старая папка не числится, чужую не подхватывает. */
  if (claimed !== null && claimed !== owner) return null;

  /* Мост не ответил — это «сейчас не знаю», а не «выбора нет». Настройку не
     трогаем и ничего не выдумываем. */
  const persisted = await persistedSafTrees().catch(() => [] as string[]);
  const adopted = persisted[0];
  if (adopted === undefined) return null;
  await prefs.set(safTreeKeyOf(owner), adopted);
  await prefs.set(PREF_SAF_TREE, adopted);
  if (claimed === null) await prefs.set(PREF_SAF_CLAIM, owner);
  return adopted;
}

/**
 * Разрешение на папку действительно отозвано — или папка просто молчит?
 *
 * `probeSafTree` отвечает `null` в обоих случаях: и когда человек отозвал
 * доступ в настройках Android, и когда провайдер папки сейчас не отвечает —
 * карта памяти не примонтирована, клиент облачного диска не запущен, система
 * ещё не подняла его после ночи. Различить их можно только по одному признаку:
 * держит ли система за нами разрешение на это дерево. Разрешение на месте —
 * значит доступ не отзывали, и стирать выбор человека не за что.
 *
 * Система не ответила и на этот вопрос — считаем, что не отозвано: сомнение
 * толкуется в пользу сохранности чужих данных.
 */
export async function safAccessRevoked(tree: string): Promise<boolean> {
  const held = await persistedSafTrees().catch(() => null);
  if (held === null) return false;
  return !held.includes(tree);
}

function safLocation(tree: SafTree): VaultLocation {
  return {
    kind: 'user',
    writeMode: writeModeOf(tree),
    label: tree.label,
    storage: createSafStorage(tree.uri),
  };
}

export function createPlatform(prefs: PreferencesStore): PlatformCapabilities {
  /**
   * Каталог приложения: настоящие `.md`, запись атомарна (ТЗ §4.3).
   *
   * У каждого владельца — своя подпапка внутри каталога приложения; у первого
   * спросившего остаётся корень, где его заметки уже лежат. Иначе вход второй
   * учёткой цеплял бы облако к чужим файлам, и первая же синхронизация
   * отправила бы их в чужое облако.
   */
  const openAppFolder = async (owner: string = LOCAL_OWNER): Promise<VaultLocation | null> => {
    const base = await defaultVaultRoot();
    const root = await ownedRoot(prefs, base, owner);
    const storage = await openVault(root);
    if (!storage) return null;
    return { kind: 'app', writeMode: 'atomic', label: APP_FOLDER_LABEL, storage };
  };

  return {
    kind: 'android',
    version: __ZAPISKI_VERSION__,
    biometrics: createBiometrics(),
    haptics: createHaptics(),
    globalHotkey: null,
    shareTarget: createShareTarget(),
    /* Отдать заметку системе — кнопка «Поделиться» в шапке (только Android). */
    shareOut: createShareOut(),
    updater: createUpdater(),

    secureFlag(on: boolean): void {
      // Настоящий FLAG_SECURE окна (BEHAVIOR §5.3, приёмочный критерий №7):
      // содержимое не попадает ни в превью задач, ни в скриншот.
      // Порт синхронный, вызов — нет; ошибку глотаем, потому что показывать
      // её некуда и незачем: пользователь в этот момент сворачивает окно.
      void call<void>(COMMANDS.secureFlag, { on }).catch(() => undefined);
    },

    async pickVaultDirectory(owner: string = LOCAL_OWNER) {
      // Умолчание и надёжный путь: каталог приложения во внешней памяти —
      // настоящие файлы `.md` на настоящей ФС с атомарной записью. Выбор
      // произвольной папки живёт в `vaultFolders` и идёт с предупреждением:
      // смешивать их в одну кнопку значило бы обещать §4.3 там, где его нет.
      const location = await openAppFolder(owner);
      return location?.storage ?? null;
    },

    /**
     * Выбор произвольной папки (ТЗ §4.1 п. 1: «LocalFolder — в т.ч. папка,
     * которую синкает сторонний клиент»).
     *
     * Раньше этого выбора не было вовсе: SAF не даёт атомарной записи, и мы
     * решали за пользователя. Цена оказалась выше пользы — на Android
     * закрывался весь бесплатный сценарий синхронизации через чужой клиент.
     * Теперь решает пользователь, а мы честно говорим, чем он платит.
     */
    vaultFolders: {
      async chooseFolder() {
        const tree = await pickSafTree();
        if (!tree) return null;
        await prefs.set(PREF_SAF_TREE, tree.uri);
        return safLocation(tree);
      },

      async useAppFolder() {
        /* Разрешение отпускается вместе с настройкой. Оставить его значило бы
           оставить след выбора, по которому приложение при следующем запуске
           вернёт человека в ту самую папку, из которой он только что ушёл. */
        await releaseSafTrees().catch(() => undefined);
        await prefs.set(PREF_SAF_TREE, null);
        return openAppFolder();
      },

      /**
       * Где лежат заметки прямо сейчас.
       *
       * ── Почему проверка разбирает два случая, а не один ──────────────────
       *
       * Здесь стояло `probeSafTree(uri).catch(() => null)`, и любой
       * отрицательный исход — хоть отозванное разрешение, хоть не ответивший
       * IPC — стирал `PREF_SAF_TREE`. То есть ОДНА случайная неудача навсегда
       * забывала папку пользователя и молча переводила его в каталог
       * приложения, который пуст.
       *
       * Ровно это заказчик описал как «при переключении тем папка просто
       * теряется»: смена темы перерисовывает экран, экран заново спрашивает
       * `current()`, и достаточно одного неответившего вызова. Тот же дефект
       * жил в `restoreVault` и там уже был исправлен — здесь он остался вторым
       * экземпляром, потому что чинилось место, а не правило.
       *
       * Правило: забывать выбор пользователя можно ТОЛЬКО по явному ответу
       * «доступа нет». Молчание — это «не знаю сейчас», и оно не даёт права
       * распоряжаться чужими данными.
       */
      async current(): Promise<VaultLocationInfo | null> {
        const uri = await chosenSafTree(prefs);
        if (uri === null) {
          return { kind: 'app', writeMode: 'atomic', label: APP_FOLDER_LABEL };
        }

        let tree;
        try {
          tree = await probeSafTree(uri);
        } catch {
          /* Не ответило. Выбор не трогаем и не выдаём каталог приложения за
             папку пользователя: `null` — честное «сейчас не знаю». */
          return null;
        }

        if (!tree) {
          /* Проверка сказала «нет» — но и это ещё не приговор выбору. Так же
             выглядит непроснувшийся провайдер папки: карта не примонтирована,
             клиент диска не запущен. Забываем адрес, только если система
             больше не держит за нами разрешение. */
          if (!(await safAccessRevoked(uri))) return null;
          // Разрешение на папку отозвано или папка удалена: возвращаемся в
          // каталог приложения, а не делаем вид, что всё на месте.
          await prefs.set(PREF_SAF_TREE, null);
          return { kind: 'app', writeMode: 'atomic', label: APP_FOLDER_LABEL };
        }
        return { kind: 'user', writeMode: writeModeOf(tree), label: tree.label };
      },
    },
  };
}
