/**
 * `PlatformCapabilities` для Windows: что эта платформа умеет и — главное —
 * чего она не умеет.
 *
 * ARCHITECTURE §2: возможность, которой на платформе нет, равна `null`, и UI
 * **скрывает** соответствующий элемент, а не показывает его выключенным.
 * Поэтому ниже нет ни одной заглушки, которая делает вид, что работает.
 */
import { open } from '@tauri-apps/plugin-dialog';
import { LOCAL_OWNER } from '@zapiski/core';
import type {
  BiometricProvider,
  GlobalHotkeyProvider,
  PlatformCapabilities,
  UpdaterProvider,
  VaultStorage,
} from '@zapiski/core';

import { SHELL_PREF, type NativePreferences } from './prefs';
import { rememberVaultPath } from './vault-owner';
import type { PlatformStrings } from './strings';
import { openVaultAt } from './vault';
import { createWindowControls } from './window';

export interface CapabilitiesDeps {
  prefs: NativePreferences;
  strings: PlatformStrings;
  biometrics: BiometricProvider | null;
  globalHotkey: GlobalHotkeyProvider;
  updater: UpdaterProvider;
}

export function createCapabilities(deps: CapabilitiesDeps): PlatformCapabilities {
  return {
    kind: 'windows',
    version: __ZAPISKI_VERSION__,

    biometrics: deps.biometrics,

    /**
     * Хэптики на Windows нет. Это не упущение реализации: тактильный отклик в
     * ТЗ §5.4 значится только за Android, а у настольной машины нет ни
     * вибромотора, ни системного API, которым его можно было бы попросить.
     * Проигрывать вместо этого звук или мигать окном — не «деликатная
     * хэптика», а её пародия.
     */
    haptics: null,

    globalHotkey: deps.globalHotkey,

    /**
     * Share-target на Windows нет. Системный «Поделиться» умеет отдавать
     * данные только приложениям, установленным как MSIX-пакет с манифестом
     * `windows.shareTarget`; установщики NSIS/MSI, которыми собирается
     * ЗАПИСКИ, в этот механизм не попадают. ТЗ §5.4 и не требует его
     * на Windows — там share-target записан за Android.
     */
    shareTarget: null,

    updater: deps.updater,

    /**
     * FLAG_SECURE на Windows нет — это no-op, и вот почему.
     *
     * У Android есть ровно то, что просит BEHAVIOR §5.3: флаг окна, из-за
     * которого система не кладёт снимок экрана в превью списка задач. У
     * Windows такого списка задач нет вовсе: то, что показывает Alt+Tab и
     * панель задач, — живая миниатюра окна средствами DWM, и отдельного
     * флага «не показывать содержимое в превью» для неё не существует.
     *
     * Ближайший родственник — `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`
     * (в Tauri он же `Window::set_content_protected`). Он решает другую
     * задачу: делает окно невидимым для любого захвата экрана целиком —
     * включая демонстрацию экрана в конференции, запись обучающего видео и
     * обычный скриншот, который пользователь делает сам. Молча отбирать у
     * человека возможность показать свою заметку коллеге — не то, что просит
     * §5.3, поэтому здесь не вызывается ни он, ни что-либо ещё.
     *
     * Содержимое зашифрованной заметки на Windows защищает автозамок из того
     * же §5.3: по таймеру расшифрованное тело уходит из памяти и из окна.
     * Функция оставлена пустой, а не выброшена, потому что она есть в
     * контракте: ядро зовёт её на каждой разблокировке и не должно знать,
     * на какой платформе исполняется.
     */
    secureFlag(_on: boolean): void {
      /* см. комментарий выше — на Windows делать нечего */
    },

    async pickVaultDirectory(owner: string = LOCAL_OWNER): Promise<VaultStorage | null> {
      const picked = await open({
        directory: true,
        multiple: false,
        title: deps.strings.dialog.pickVault,
      });
      if (typeof picked !== 'string') return null;

      const storage = await openVaultAt(picked);
      /* Запоминаем выбор ВЛАДЕЛЬЦА, чтобы следующий запуск открыл именно его
         vault (`restoreVault`), а не показал онбординг заново — и чтобы вход
         другой учёткой не цеплял облако к чужой папке. */
      await rememberVaultPath(deps.prefs, owner, picked);
      return storage;
    },

    /* Своя строка заголовка (ITERATION-1 §6): окно безрамочное, кнопки наши. */
    window: createWindowControls(),
  };
}
