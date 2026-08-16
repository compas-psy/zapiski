/**
 * Где лежит папка заметок КАЖДОГО владельца.
 *
 * ── Зачем ───────────────────────────────────────────────────────────────────
 *
 * Путь к папке был один на приложение (`desktop.vaultPath`). Вход второй
 * учёткой цеплял облако к той же папке — и первая же синхронизация отправляла
 * заметки первого человека в чужое облако, а на экране два человека
 * оказывались перемешаны.
 *
 * Модель теперь та же, что у Obsidian: хранилище — это папка, которую выбрал
 * человек, и смена личности означает смену папки, а не подмешивание чужих
 * файлов в открытую.
 *
 * ── Почему старый ключ не переписывается ────────────────────────────────────
 *
 * Решение заказчика: «оставить хозяину, кто вошёл первым». Папка, уже
 * выбранная до появления учёток, достаётся первому спросившему владельцу, и
 * ни один файл при этом не двигается. Заявка делается один раз и не
 * переигрывается: иначе после выхода из аккаунта старая папка досталась бы
 * локальному владельцу, и человек увидел бы чужие заметки.
 */
import type { PreferencesStore } from '@zapiski/app';
import { SHELL_PREF } from './prefs';

/** Кто занял папку, выбранную до появления учёток. */
const CLAIM = 'shell.vaultPath.legacyOwner';

function keyOf(owner: string): string {
  return `${SHELL_PREF.vaultPath}.${owner}`;
}

/** Путь владельца: свой, а если он занял старый — старый. `null` — места нет. */
export async function vaultPathOf(
  prefs: PreferencesStore,
  owner: string,
): Promise<string | null> {
  const own = await prefs.get<string | null>(keyOf(owner), null);
  if (own !== null) return own;

  const legacy = await prefs.get<string | null>(SHELL_PREF.vaultPath, null);
  if (legacy === null) return null;
  const claimed = await prefs.get<string | null>(CLAIM, null);
  if (claimed === null) {
    await prefs.set(CLAIM, owner);
    return legacy;
  }
  return claimed === owner ? legacy : null;
}

/** Запомнить выбор владельца. Старый ключ трогаем только за его хозяином. */
export async function rememberVaultPath(
  prefs: PreferencesStore,
  owner: string,
  path: string,
): Promise<void> {
  await prefs.set(keyOf(owner), path);
  const claimed = await prefs.get<string | null>(CLAIM, null);
  if (claimed === null) await prefs.set(CLAIM, owner);
  if (claimed === owner || claimed === null) await prefs.set(SHELL_PREF.vaultPath, path);
}
