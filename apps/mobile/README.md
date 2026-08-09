# `@zapiski/mobile` — оболочка Android

Тонкая оболочка Tauri 2 Mobile. По `docs/ARCHITECTURE.md` §1 здесь **нет ни
одного экрана и ни одной единицы продуктовой логики**: только точка входа,
реализация платформенных портов и платформенный манифест. Все экраны — в
`packages/app`, и именно поэтому Android получает ровно тот же функционал, что
Windows и веб.

```
src/                 точка входа: собирает AppHost и монтирует <App host={…}/>
  platform/          реализации портов из packages/core/src/contract.ts
src-tauri/           Rust: атомарная запись, JNI-мост, команды
android/             ОВЕРЛЕЙ: Kotlin и ресурсы, которые кладутся в gen/android
scripts/             наложение оверлея и его самопроверка
```

## Сборка

Android SDK и NDK нужны обязательно; на машине без них собирается всё, кроме
самого APK.

```bash
pnpm -r --filter "./packages/**" build     # ядро, редактор, UI, приложение
pnpm --filter @zapiski/mobile typecheck    # типы оболочки
pnpm --filter @zapiski/mobile build:vite   # фронтенд → apps/mobile/dist

pnpm --filter @zapiski/mobile exec tauri android init   # ← генерирует gen/android
pnpm --filter @zapiski/mobile android:overlay           # ← накладывает наш Kotlin
pnpm --filter @zapiski/mobile exec tauri android build --apk
```

**Порядок обязателен.** `gen/android` — сгенерированный проект Gradle, он в
`.gitignore`; наш Kotlin, ресурсы и дополнения к `AndroidManifest.xml` живут в
`android/` и попадают в проект скриптом `scripts/apply-android-overlay.mjs`.
Скрипт идемпотентен и не переписывает то, что сгенерировал Tauri, — он
добавляет своё и патчит манифест по маркерам. Почему именно так, а не «положить
gen/android в git», подробно написано в шапке скрипта.

Проверить патч манифеста без SDK:

```bash
pnpm --filter @zapiski/mobile android:overlay:selftest
```

`cargo check` в `src-tauri` требует существующего `../dist` (кодогенерация
Tauri читает `frontendDist`): сначала `build:vite`, потом `cargo check`.

Сборка релиза и выкладка — `.github/workflows/build-android.yml`.

## Что реализовано из портов

| Порт | Как |
| --- | --- |
| `VaultStorage` | plugin-fs на чтение, **атомарная запись tmp→fsync→rename в Rust** (`src-tauri/src/vault.rs`) |
| `BiometricProvider` | Android Keystore + BiometricPrompt (`android/…/Biometrics.kt`); нет стойкой биометрии → `isAvailable() = false`, тумблер скрыт |
| `HapticProvider` | лёгкий и средний импульс; где вибрировать — решает `packages/app`, не оболочка |
| `secureFlag` | настоящий `FLAG_SECURE` окна (BEHAVIOR §5.3) |
| `ShareTargetProvider` | `ACTION_SEND`/`SEND_MULTIPLE` для текста, ссылки и картинки |
| `UpdaterProvider` | фид `/api/v1/updates/android/{{current_version}}`, загрузка APK, установка через `FileProvider` |
| `PdfRenderer` | системный конвейер печати Android |
| `saveFile` | «Загрузки» через MediaStore |
| `globalHotkey` | `null` — на Android глобальных хоткеев не существует |

## Чего не хватает — и это не забыто, а упирается в контракт

В `AppHost` (`packages/app/src/contract.ts`) нет портов для трёх вещей, которые
оболочка уже умеет доставлять:

* **виджеты** — снимок данных и обратные команды (`src/platform/widgets.ts`,
  `src-tauri/src/widgets.rs`). Механизм готов целиком, звать его приложению
  нечем. Пока порта нет, виджеты честно показывают пустое состояние, а не
  выдуманные заметки;
* **быстрая заметка** — плитка Quick Settings и виджет 1×1 доставляют событие
  `zapiski://quick-note`, обработать его контрактом нельзя;
* **открыть заметку по id** из виджета «Последние».

Собирать это в оболочке нельзя: заголовок заметки, порядок «последних» и
разбор чекбоксов — продуктовая логика, её место в ядре. Нужен порт, а не экран
(ARCHITECTURE §1). Ровно так же поступила оболочка Windows с ассоциацией `.md`.
