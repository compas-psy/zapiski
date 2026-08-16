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

/**
 * Владельцы, за которыми что-то записано.
 *
 * `PreferencesStore` перечислять ключи не умеет, а знать это надо: снимать
 * SAF-разрешения можно только тогда, когда папки нет ни у кого другого.
 */
export const PREF_SAF_OWNERS = 'storage.androidTree.owners';

/**
 * Ключ выбранной папки для владельца.
 *
 * Три состояния, и путать их нельзя:
 *   · строка с `content://` — папка этого владельца;
 *   · `APP_FOLDER_CHOICE` (пустая строка) — он ЯВНО выбрал каталог приложения;
 *   · `null` — выбора не было, и его ещё можно восстановить по разрешению.
 *
 * Второе состояние появилось не для красоты. Без него «вернуться в каталог
 * приложения» приходилось подкреплять снятием всех SAF-разрешений — то есть
 * отбирать папку и у других владельцев. Теперь отказ записан у того, кто
 * отказался, и чужие папки при этом целы.
 */
export function safTreeKeyOf(owner: string): string {
  return `${PREF_SAF_TREE}.${owner}`;
}

/** «Этот владелец выбрал каталог приложения» — не то же самое, что «не знаю». */
export const APP_FOLDER_CHOICE = '';

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
    await claim(prefs, owner);
    return base;
  }
  if (claimed === owner) return base;
  return `${base}/.owners/${owner.replace(/[^a-z0-9._-]+/gi, '_')}`;
}

/**
 * Записать заявку — и не дать неудачной записи отнять папку.
 *
 * `prefs.set` бросает: файл настроек мог не открыться, диск мог быть занят.
 * Раньше это исключение летело сквозь `ownedRoot` наружу, а вызывающий —
 * онбординг — трактовал ЛЮБОЕ исключение как «папка недоступна», показывал
 * тост и уводил человека в память. То есть настройка, которая не записалась,
 * выдавалась за пропавшую папку.
 *
 * Заявка — вещь полезная, но не критическая: не записалась сейчас — запишется
 * при следующем открытии. Папка от этого никуда не девается.
 */
async function claim(prefs: PreferencesStore, owner: string): Promise<void> {
  await prefs.set(PREF_SAF_CLAIM, owner).catch(() => undefined);
}

/** Запомнить папку за владельцем. По той же причине — не роняя вызывающего. */
async function remember(prefs: PreferencesStore, owner: string, tree: string): Promise<void> {
  await prefs.set(safTreeKeyOf(owner), tree).catch(() => undefined);
  const known = await prefs.get<string[]>(PREF_SAF_OWNERS, []);
  if (!known.includes(owner)) {
    await prefs.set(PREF_SAF_OWNERS, [...known, owner]).catch(() => undefined);
  }
}

/**
 * Забыть папку владельца — доступа к ней действительно нет.
 *
 * Общая ячейка `PREF_SAF_TREE` чистится, только если её держит этот же
 * владелец. Иначе отзыв доступа у одного стирал бы папку у другого — а тот про
 * отзыв ничего не знает и обнаружил бы пустой список.
 */
export async function forgetTree(prefs: PreferencesStore, owner: string): Promise<void> {
  await prefs.set(safTreeKeyOf(owner), null).catch(() => undefined);
  const claimed = await prefs.get<string | null>(PREF_SAF_CLAIM, null);
  if (claimed === null || claimed === owner) {
    await prefs.set(PREF_SAF_TREE, null).catch(() => undefined);
  }
}

/**
 * Держит ли папку кто-то, кроме этого владельца.
 *
 * Нужно ровно в одном месте: «вернуться в каталог приложения» снимает
 * SAF-разрешения, а они общие на приложение. Снять их, когда папка есть у
 * другой учётки, — значит отобрать её у человека, который ничего не нажимал.
 *
 * Список владельцев ведётся отдельной настройкой: `PreferencesStore` умеет
 * читать и писать по ключу, но не перечислять ключи, а гадать по именам —
 * это тот самый код, который однажды не найдёт настоящего владельца и молча
 * решит, что папку можно отнять.
 */
async function anyOwnerHoldsTree(prefs: PreferencesStore, except: string): Promise<boolean> {
  const claimed = await prefs.get<string | null>(PREF_SAF_CLAIM, null);
  const legacy = await prefs.get<string | null>(PREF_SAF_TREE, null);
  if (legacy !== null && claimed !== null && claimed !== except) return true;

  const known = await prefs.get<string[]>(PREF_SAF_OWNERS, []);
  for (const owner of known) {
    if (owner === except) continue;
    const tree = await prefs.get<string | null>(safTreeKeyOf(owner), null);
    if (tree !== null && tree !== APP_FOLDER_CHOICE) return true;
  }
  return false;
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
  if (own !== null) return own === APP_FOLDER_CHOICE ? null : own;

  /* Папка, выбранная до появления учёток, достаётся первому, кто её ОТКРОЕТ.
     Здесь только смотрим: заявку делает `adoptSafTree`, и делает её ровно
     тогда, когда хранилище действительно открывается. */
  const legacy = await prefs.get<string | null>(PREF_SAF_TREE, null);
  if (legacy === null) return null;
  const claimed = await prefs.get<string | null>(PREF_SAF_CLAIM, null);
  return claimed === null || claimed === owner ? legacy : null;
}

/**
 * Занять папку за владельцем — и вернуть её.
 *
 * ── Почему это отдельно от `chosenSafTree` ──────────────────────────────────
 *
 * Заявка необратима по решению заказчика («оставить хозяину, кто вошёл
 * первым»), а `chosenSafTree` зовётся из `vaultFolders.current()` — то есть с
 * каждой перерисовки настроек и один раз на старте. Пока заявка стояла внутри
 * него, порядок в `boot()` решал судьбу папки: `current()` спрашивали ДО
 * восстановления сессии, владельцем в тот момент был `local`, и старая папка
 * доставалась ему. Учётка после входа получала пустую подпапку, синхронизация
 * уносила в облако пустоту, а на экране это выглядело как «заметки пропали,
 * облако не работает».
 *
 * Правило: вопрос не меняет мира. Заявку делает тот, кто открывает хранилище.
 */
export async function adoptSafTree(
  prefs: PreferencesStore,
  owner: string = LOCAL_OWNER,
): Promise<string | null> {
  const own = await prefs.get<string | null>(safTreeKeyOf(owner), null);
  if (own !== null) return own === APP_FOLDER_CHOICE ? null : own;

  const claimed = await prefs.get<string | null>(PREF_SAF_CLAIM, null);
  /* Владелец, за которым старая папка не числится, чужую не подхватывает. */
  if (claimed !== null && claimed !== owner) return null;

  const legacy = await prefs.get<string | null>(PREF_SAF_TREE, null);
  if (legacy !== null) {
    await remember(prefs, owner, legacy);
    await claim(prefs, owner);
    return legacy;
  }

  /* Мост не ответил — это «сейчас не знаю», а не «выбора нет». Настройку не
     трогаем и ничего не выдумываем. */
  const persisted = await persistedSafTrees().catch(() => [] as string[]);
  const adopted = persisted[0];
  if (adopted === undefined) return null;
  await remember(prefs, owner, adopted);
  await claim(prefs, owner);
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
      async chooseFolder(owner: string = LOCAL_OWNER) {
        const tree = await pickSafTree();
        if (!tree) return null;
        /* Папка пишется ВЛАДЕЛЬЦУ, а не в общую ячейку. Пока писали в общую,
           выбор, сделанный под учёткой, при следующем запуске ей не
           доставался: `chosenSafTree` смотрел ключ владельца, там было пусто,
           а общую ячейку держал `local`. Человек выбирал папку заново каждый
           запуск и каждый раз видел пустой список. */
        await remember(prefs, owner, tree.uri);
        await claim(prefs, owner);
        return safLocation(tree);
      },

      async useAppFolder(owner: string = LOCAL_OWNER) {
        /* Отказ записывается ЯВНО — за тем, кто отказался. Раньше здесь
           снимались разрешения на ВСЕ деревья: возврат одного владельца в
           каталог приложения отбирал папку у остальных. Теперь чужие
           разрешения не трогаются, а восстановление по разрешению не утащит
           этого владельца назад: у него записано «каталог приложения». */
        await remember(prefs, owner, APP_FOLDER_CHOICE);
        /* Разрешения снимаются, только если больше ни за кем папок нет: без
           этого след выбора вернул бы человека в покинутую папку. */
        if (!(await anyOwnerHoldsTree(prefs, owner))) {
          await releaseSafTrees().catch(() => undefined);
          await prefs.set(PREF_SAF_TREE, null).catch(() => undefined);
        }
        return openAppFolder(owner);
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
      async current(owner: string = LOCAL_OWNER): Promise<VaultLocationInfo | null> {
        const uri = await chosenSafTree(prefs, owner);
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
          // каталог приложения, а не делаем вид, что всё на месте. Забывается
          // папка ЭТОГО владельца — общая ячейка чужая, и трогать её значило
          // бы отобрать папку у того, кто про отзыв не знает.
          await forgetTree(prefs, owner);
          return { kind: 'app', writeMode: 'atomic', label: APP_FOLDER_LABEL };
        }
        return { kind: 'user', writeMode: writeModeOf(tree), label: tree.label };
      },
    },
  };
}
