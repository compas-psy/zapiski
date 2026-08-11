# `@zapiski/core` — ядро

Вся логика продукта, не зависящая от платформы: работа с файлами, разбор
markdown, индекс и поиск, шифрование, CRDT, синхронизация, импорт/экспорт,
каталоги строк.

Пакет исполняется **одним и тем же кодом** в вебе, в Tauri desktop и в Tauri
Android ([ADR-0001](../../adr/0001-yadro-na-typescript-vmesto-rust.md)).
Ни одного обращения к DOM, к файловой системе напрямую или к `window` здесь
нет — платформа подключается через порты.

Публичный API — только `packages/core/src/index.ts`. Глубокие импорты
запрещены (`ARCHITECTURE.md` §5).

## Состав

| Каталог | Ответственность |
| --- | --- |
| `contract.ts` | Типы домена и платформенные порты. Единственный источник правды |
| `util/` | Пути внутри vault'а, текст и токенизация, байты и хеши |
| `markdown/` | Разбор заметки: заголовок, теги, ссылки, frontmatter, AST для экспорта |
| `vault/` | Файловый слой: чтение/запись, имена, атомарность, транзакционное переименование |
| `index/` | Инвертированный индекс, FTS, разбор строки поиска |
| `crypto/` | Контейнер `.md.enc`, Argon2id + AES-256-GCM, шифрование файла заметки |
| `crdt/` | Документ заметки на Yjs, компактные логи в `.zapiski/crdt` |
| `sync/` | Движок синка, очередь, версии, diff3, четыре бэкенда, протокол облака |
| `import/` | Obsidian/папка, Bear, Notion, Evernote + общая запись в vault |
| `export/` | md-архив, HTML, DOCX, порт печати PDF |
| `i18n/` | Каталоги `ru` и `en`; раздел `errors` — дословно из `BEHAVIOR.md` §11 |
| `memory-storage.ts` | Реализация `VaultStorage` в памяти для тестов и демо |

Зависимости пакета — три: `yjs` (CRDT), `hash-wasm` (Argon2id), `fflate`
(zip для импорта и экспорта). Больше ничего в ядро не тянем: каждый килобайт
едет на все три платформы.

---

## Порт `VaultStorage` — и зачем он

```ts
interface VaultStorage {
  read(path: VaultPath): Promise<Uint8Array | null>;
  /** Обязана быть атомарной: запись во временный файл + rename (ТЗ §4.3). */
  write(path: VaultPath, data: Uint8Array): Promise<void>;
  remove(path: VaultPath): Promise<void>;
  rename(from: VaultPath, to: VaultPath): Promise<void>;
  list(dir: VaultPath): Promise<VaultEntry[]>;
  stat(path: VaultPath): Promise<VaultStat | null>;
  mkdir(dir: VaultPath): Promise<void>;
}
```

Это **единственное место, где платформы вообще различаются**. Требование
заказчика — идентичный функционал на Android, Windows и в вебе — выполняется не
дисциплиной, а тем, что расходиться просто негде: всё, что выше `VaultStorage`,
физически один код.

Планируемые реализации порта (ADR-0001):

| Платформа | Реализация |
| --- | --- |
| Web (Chromium) | File System Access API |
| Web (прочие) | OPFS |
| Tauri desktop / Android | `@tauri-apps/plugin-fs` поверх нативной ФС |

Все три написаны: `apps/web/src/vault-storage.ts` (FSA с фолбэком на OPFS),
`apps/desktop/src/platform/vault.ts` и `apps/mobile/src/platform/vault.ts`
(plugin-fs, а `write` — атомарная команда Rust `vault_write_atomic`).
Подробности и оговорки — [platforms.md](platforms.md).

Плюс `MemoryVaultStorage` (`memory-storage.ts`) для тестов: всё в памяти, с
управляемыми часами и инъекцией сбоев записи (`failWriteAt`, `failWriteAfter`,
`failWriteOnce`) — на ней держатся тесты транзакционности.

`VaultPath` — всегда прямые слэши, без ведущего слэша, нормализуется
`normalizePath()`. Служебный каталог — `.zapiski/`:

```
Мои заметки/
  Заметка о встрече.md
  Проекты/Идея продукта.md
  attachments/2026-08-08_1a2b3c.png
  .zapiski/
    index.json            снапшот индекса и служебных метаданных
    config.json           настройки vault'а
    sync-queue.json       очередь изменений, переживает перезапуск
    sync-state.json       etag'и и базы для diff3
    rename.journal.json   журнал незавершённого переименования
    crdt/<noteId>.bin     компактные CRDT-логи
    versions/<noteId>.json локальная история (последние 50 снапшотов)
    trash/                корзина, 30 дней
    tmp/                  стейджинг атомарной записи
```

Имена констант — `META_DIR`, `TRASH_DIR`, `CRDT_DIR`, `VERSIONS_DIR`,
`INDEX_FILE`, `CONFIG_FILE`, `QUEUE_FILE`, `ATTACHMENTS_DIR` — экспортируются
из пакета.

> ТЗ §3.1 называет файл индекса `index.sqlite`. Фактически это `index.json`:
> прямое следствие [ADR-0002](../../adr/0002-indeks-i-fts-bez-sqlite.md).
> Инвариант «индекс — производная» соблюдён: удаление `.zapiski/` не теряет ни
> одной заметки, всё пересобирается из `.md`.

## Другие платформенные порты

```ts
interface PlatformCapabilities {
  readonly kind: 'web' | 'windows' | 'android';
  readonly biometrics: BiometricProvider | null;
  readonly haptics: HapticProvider | null;
  readonly globalHotkey: GlobalHotkeyProvider | null;
  readonly shareTarget: ShareTargetProvider | null;
  readonly updater: UpdaterProvider | null;
  secureFlag(on: boolean): void;
  pickVaultDirectory(): Promise<VaultStorage | null>;
}
```

Возможность, которой на платформе нет, равна `null`, и UI обязан **скрыть**
соответствующий элемент, а не показать его выключенным (`BEHAVIOR.md` §5.1).

Реализации живут в оболочках. Кратко, кто что умеет:

| Порт | web | windows | android |
| --- | --- | --- | --- |
| `biometrics` | WebAuthn-PRF | Windows Hello | Keystore + BiometricPrompt |
| `haptics` | `null` | `null` | ✓ |
| `globalHotkey` | `null` | ✓ `Ctrl+Alt+N` | `null` |
| `shareTarget` | `null` | `null` | ✓ `ACTION_SEND` |
| `updater` | `null` | Tauri updater | свой: фид → APK |
| `secureFlag` | no-op | no-op | ✓ `FLAG_SECURE` |
| `PdfRenderer` | печать iframe | WebView2 `PrintToPdf` | `PrintDocumentAdapter` |

Почему каждый `null` — это природа платформы, а не недоделка, разобрано в
[platforms.md](platforms.md#почему-null--это-не-недоделка).

---

## Модель заметки

```ts
interface NoteMeta {
  id: NoteId;              // стабильный: из frontmatter, иначе из индекса
  path: VaultPath;         // 'Проекты/Идея.md'
  title: string;           // первая строка файла (BEHAVIOR §2.2)
  snippet: string;         // ~200 знаков тела без разметки
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  tags: string[];          // вложенные целиком: 'практика/супервизия'
  encrypted: boolean;      // .md.enc — тело и заголовок НЕ индексируются
  hasImage: boolean;
  hasFile: boolean;
  hasTodo: boolean;
  hasLink: boolean;
  wordCount: number;
  pinOrder?: number;
}

interface Note extends NoteMeta {
  body: string;            // полный markdown; у зашифрованной — '' до разблокировки
}
```

Правила, которые стоят за этими полями:

* **Заголовок — первая строка файла.** Отдельного поля нет. `# ` в начале —
  это H1 и заголовок; без решётки первая непустая строка всё равно становится
  заголовком в списке, но в тексте остаётся обычным абзацем (`extractTitle`).
* **Frontmatter опционален.** Ядро его сохраняет, но не требует и **не
  добавляет** — иначе чужой Obsidian-vault перестанет быть своим для Obsidian.
  Служебные поля пишутся во frontmatter только если он в файле уже есть и уже
  содержит `id`/`created`/`updated` (`Vault.stampFrontmatter`); иначе всё живёт
  в `.zapiski/index.json`.
* **Frontmatter сохраняется построчно.** `Frontmatter.parse` держит исходные
  строки записей, включая непонятые (вложенные маппинги, комментарии), — при
  перезаписи не теряется ни одна.
* **Вложения — всегда относительный путь** `attachments/ГГГГ-ММ-ДД_хеш.ext`.
  Единая конвенция на всех платформах: это фикс главной боли Obsidian.

### Vault — основной класс

```ts
const vault = await Vault.open(storage, { locale: 'ru', renameDelayMs: 2000 });

await vault.create({ title: 'Идея', folder: 'Проекты' });   // → Note
await vault.write('Проекты/Идея.md', '# Идея\n\nтекст');    // автосохранение
const note = await vault.read('Проекты/Идея.md');
vault.notes();                       // NoteMeta[] из индекса
vault.metaOf('Проекты/Идея.md');
await vault.folders();               // FolderNode[] со счётчиками
await vault.rebuild();               // полная перестройка индекса из .md
await vault.persist();               // снапшот в .zapiski/index.json

await vault.setPinned(path, true);
await vault.setArchived(path, true);
const toast = await vault.archiveWithUndo(path);   // UndoableToast, 6 секунд

const trashToast = await vault.trash(path);        // в .zapiski/trash
vault.listTrash();
await vault.restore(entryId);
await vault.purgeTrash();                          // старше 30 дней
await vault.purgeTrash(true);                      // всё (диалог «Очистить»)

const { path, markdown } = await vault.addAttachment(bytes, '.png');
await vault.orphanAttachments();                   // неиспользуемые вложения

const off = vault.onChange((paths) => { /* перерисовать список */ });
await vault.refresh(path);                         // файл изменился извне
```

Открытие vault'а (`Vault.open`) делает три вещи по порядку: доигрывает журнал
незавершённого переименования, читает журнал корзины, пробует загрузить снапшот
индекса. Снапшот принимается только если сходятся версия, состав путей и
`mtime` каждого файла — иначе полная перестройка. Индекс всегда производная.

### Переименование по заголовку — транзакция

`BEHAVIOR.md` §2.2 и приёмочный критерий C6: переименование заметки с 20
входящими ссылками обновляет **все 20 или ни одной**.

```ts
vault.scheduleRename(path);       // ставит в очередь: +2 с после правки
await vault.flushRenames();       // выполняет назревшие
await vault.renameToTitle(path);  // немедленно
await vault.renameTo(from, to);
await vault.move(path, 'Личное'); // drag-and-drop
```

Механика (`vault/rename.ts`):

1. **Стейджинг.** Для каждого файла-источника ссылок в `.zapiski/tmp/rename-<id>/`
   пишутся две копии: прежнее содержимое (`*.prev`) и новое (`*.next`).
   Ни один файл vault'а на этом шаге не тронут.
2. **Журнал.** `.zapiski/rename.journal.json` фиксирует план целиком.
3. **Коммит.** Переименование самого файла, затем построчная запись из `*.next`.
4. **Откат при сбое.** Восстанавливаются *все* шаги, а не только применённые:
   запись файла его же прежним содержимым идемпотентна, зато откат перестаёт
   зависеть от счётчика в памяти и работает после падения процесса.
5. **Доигрывание.** `recoverRename()` при следующем `Vault.open()` откатывает
   незакрытый журнал.

`rewriteWikiLinks(body, oldTarget, newTarget)` сохраняет алиасы и якоря
(`[[Идея#Раздел|подпись]]`) и не трогает ссылки внутри кода.

---

## Индекс и поиск

Собственный инвертированный индекс на TypeScript
([ADR-0002](../../adr/0002-indeks-i-fts-bez-sqlite.md)). Класс
`InvertedIndex implements NoteIndex`.

### Что внутри

| Структура | Для чего |
| --- | --- |
| `titlePostings: Map<term, Set<NoteId>>` | Совпадение в заголовке — ранг выше |
| `bodyPostings: Map<term, Map<NoteId, count>>` | Частота терма в теле |
| `tagPostings: Map<tag, Set<NoteId>>` | Оператор `tag:`, дерево тегов |
| `refIndex: Map<refKey, Set<NoteId>>` | Backlinks: кто ссылается на заметку |
| `sortedTerms: string[]` | Ленивый кеш для префиксного поиска по мере ввода |

Плюс на каждую заметку хранятся `plain` (текст без разметки) и `normalized` —
нормализация **с сохранением длины строки**, иначе смещения подсветки
разъедутся с исходником. Нормализация: нижний регистр + `ё → е`. Стемминга нет
осознанно: для заметок точное совпадение предсказуемее «умного» поиска.

**Зашифрованные заметки в индекс не попадают вовсе** — ни тело, ни заголовок.
В выдаче они появляются только при совпадении с именем файла-плейсхолдера,
идут в конце, без фрагментов, с флагом `encryptedPlaceholder: true`.

### Операторы поиска

`parseQuery(input, now?)` разбирает строку в `SearchQuery` **до** обращения к
индексу: `tag`/`folder`/`before`/`after`/`has` — фильтры по метаданным, не по
тексту.

| Оператор | Синоним | Значение |
| --- | --- | --- |
| `tag:практика` | `тег:` | Тег и все вложенные (`практика/супервизия`) |
| `folder:Личное` | `папка:` | Заметки внутри папки |
| `before:2026-08-01` | `до:` | `updatedAt` строго раньше |
| `after:вчера` | `после:` | `updatedAt` не раньше |
| `has:image\|file\|todo\|link` | `есть:` | Признаки из `NoteMeta` |
| `"точная фраза"` | — | Подстрока в заголовке или теле |
| `-слово` | — | Исключить |

Даты понимают ISO (`2026-08-01`, `2026-08`, `2026`) и русские относительные
слова: `сегодня`, `вчера`, `неделя`, `месяц`, `год` (и английские аналоги).

`formatQuery(query)` собирает строку обратно — это то, чем строка поиска и
чипы-фильтры держатся синхронными (`BEHAVIOR.md` §4).

```ts
const query = parseQuery('супервизия tag:практика after:вчера -черновик');
const hits = index.search(query, 200);
// hits[i].fragments — до 3 фрагментов с контекстом ±40 символов
// hits[i].fragments[j].ranges — диапазоны для подсветки внутри фрагмента
```

### Ранжирование

`BEHAVIOR.md` §4: совпадение в заголовке важнее совпадения в тексте, при
равенстве выигрывает свежесть.

```
фраза в заголовке   +20        терм в заголовке   +10
фраза в теле        +6         терм в теле        +2 + min(count,10)×0.2
префиксное совпадение терма — половинный вес вхождений
при равном счёте — по updatedAt по убыванию
```

Кандидаты — пересечение постингов по всем термам запроса (AND). Префиксное
совпадение включено, чтобы поиск работал по мере ввода (debounce 120 мс на
стороне UI).

### Backlinks

`index.backlinks(noteId)` возвращает заметки, ссылающиеся на данную через
`[[wiki]]` **или** обычную markdown-ссылку на `.md`-файл. Ключи, по которым
заметку можно найти (`referenceKeys`): заголовок, имя файла, путь без
расширения. Исходящие ссылки (`outgoingRefs`) разрешаются относительно папки
самой заметки.

### Персистентность

`index.toJSON()` / `index.loadSnapshot(raw)`. Снапшот версионирован
(`INDEX_VERSION`); повреждённый или чужой версии отвергается возвратом `false`,
и вызывающий обязан сделать полную перестройку. Известное ограничение
(ADR-0002): индекс держится в памяти целиком — при 10 000 заметок это единицы
десятков МБ, при 100 000+ понадобится сегментация.

---

## Шифрование

### Формат контейнера `.md.enc`

Магия `ZPSK`, little-endian:

```
 0  4  magic      'ZPSK'
 4  1  version    1  (= CONTAINER_VERSION)
 5  1  flags      бит 0 — есть подсказка к паролю
 6  1  saltLen    16 (SALT_LENGTH)
 7  1  nonceLen   12 (NONCE_LENGTH)
 8  2  hintLen
10  .. salt
   .. nonce
   .. hint (UTF-8, ОТКРЫТЫМ ТЕКСТОМ — намеренно)
   .. ciphertext + 16-байтовый тег GCM
```

`decodeContainer` на любую порчу возвращает `null`, а не бросает: повреждённый
файл не должен ронять приложение (`BEHAVIOR.md` §11, «Не удалось прочитать
файл»). `looksEncrypted(bytes)` — быстрая проверка по магии.

### Провайдер

```ts
const provider = new WebCryptoProvider();          // ARGON2_PARAMS по умолчанию
const salt = provider.randomSalt();
const key = await provider.deriveMasterKey(пароль, salt);
const container = await provider.encrypt(текст, key, 'подсказка');
const plain = await provider.decrypt(container, key);   // null — пароль не подошёл
provider.parseHeader(container);                        // version, salt, hint без ключа
```

* KDF — **Argon2id** из `hash-wasm`, второй рекомендованный набор RFC 9106 §4:
  `t=3, m=64 МиБ, p=4, tag=32`. Смена параметров = поднять `CONTAINER_VERSION`.
* Шифр — **AES-256-GCM** из WebCrypto, то есть нативная реализация ОС/браузера.
* Ключ импортируется с `extractable: false` и **никогда не покидает `CryptoKey`**.
  Соль привязана к ключу через `WeakMap`, чтобы не таскать сырые байты.
* `deriveNoteKey(password, salt, noteId)` — иерархия ключей ТЗ §3.3: per-note
  ключ выводится HKDF из того же материала.
* `decrypt` возвращает `null` вместо исключения — прямое требование
  `BEHAVIOR.md` §5.2.
* `unlockDelayMs(failedAttempts)`: 0 до пятой попытки, 30 с после пятой, 5 мин
  после восьмой. Данные не удаляются никогда.

### Файловые операции

```ts
await encryptNoteFile(storage, provider, 'Дневник.md', key, 'подсказка');
// → 'Дневник.md.enc'; исходный .md сначала затирается нулями, потом удаляется

await decryptNoteFile(storage, provider, path, key);    // строка только в памяти
await decryptNoteToDisk(storage, provider, path, key);  // снятие шифрования
await passwordHint(storage, provider, path);            // подсказка без ключа
```

Порядок важен и зафиксирован: сначала атомарно пишется `.md.enc`, только потом
исчезает `.md`. Открытый текст на диск не пишется никогда.

> **Честное ограничение (ADR-0001).** JS не даёт гарантированного затирания
> буферов: `String` в managed-памяти живёт до сборки мусора. Митигация —
> неэкспортируемый `CryptoKey`, отсутствие plaintext на диске и автозамок по
> таймеру.
>
> Сам **автозамок в ядре не живёт** — это работа слоя экранов: таймер
> бездействия и настройка «1 / 5 / 10 / 30 минут / до выхода» реализованы в
> `packages/app` (`state/store.ts`, `autoLockMinutes`). `FLAG_SECURE` требует
> платформенной оболочки: настоящий флаг есть только на Android, на Windows и в
> вебе `secureFlag` — осознанный no-op, потому что эквивалента у этих платформ
> нет ([platforms.md](platforms.md#почему-null--это-не-недоделка)).

---

## CRDT

Текст заметки — `Y.Text` в документе Yjs; `.md` на диске — его материализация.
Логические часы Yjs (clientID + clock) означают, что часы устройства на
корректность слияния не влияют (ТЗ §4.3).

> ТЗ §2.2 предлагал Automerge или Yrs. Взят **Yjs**: Yrs — это Rust-порт Yjs,
> протокол обновлений совместим (ADR-0001).

```ts
const doc = NoteDoc.fromMarkdown(текст, 'windows-марины');
doc.setText(новыйТекст);        // минимальная правка, а не «удалить всё»
doc.toMarkdown();
doc.encodeState();              // полный апдейт
doc.encodeStateVector();
doc.diffUpdate(чужойВектор);    // дельта — это и есть delta-синк
doc.applyUpdate(апдейт);

mergeUpdates([a, b]);                      // компактный объединённый лог
mergeTexts(base, mine, theirs, device);    // three-way через CRDT
diffText(было, стало);                     // общий префикс/суффикс → TextEdit
clientIdFor('имя-устройства');             // стабильный clientID (fnv1a)
```

`CrdtStore` хранит логи в `.zapiski/crdt/<noteId>.bin` **всегда сжатыми в один
merged-update**: журнал операций целиком держать незачем, история версий живёт
отдельно.

```ts
const store = new CrdtStore(storage, deviceName);
await store.loadDoc(noteId, текстИзФайла);  // из лога, иначе из .md
await store.save(noteId, doc);
await store.append(noteId, чужойАпдейт);    // добавить и сразу компактнуть
```

`loadDoc` подтягивает `.md` как правку, если файл разошёлся с логом, — это
случай «правили чужим редактором».

---

## Синхронизация

### Бэкенды

Общий интерфейс `SyncBackend` (`id`, `title`, `list`, `get`, `put`, `remove`,
опциональный `subscribe`):

| Класс | `id` | Что делает |
| --- | --- | --- |
| `LocalFolderBackend` | `local` | Просто папка, в т.ч. синкаемая чужим клиентом (Яндекс.Диск, Syncthing). Никакой сети. ETag = `mtime-size` |
| `WebDAVBackend` | `webdav` | Универсальный WebDAV: PROPFIND `Depth: infinity`, ETag либо `getlastmodified`, MKCOL для недостающих каталогов, `If-Match` на PUT |
| `YandexDiskBackend` | `yandex` | Нативный REST поверх OAuth (`cloud-api.yandex.net`) с автоматическим падением обратно на WebDAV |
| `ZapiskiCloudBackend` | `zapiski` | Облако Записок: HTTP + websocket-подписка |

Сетевого клиента в ядре нет — используется `fetch`, одинаковый на всех трёх
целях; в тестах подменяется опцией `fetch`.

Ошибки бэкендов — `SyncError` с `kind: 'auth' | 'unreachable' | 'conflict' |
'server'` и текстом **дословно из реестра** `BEHAVIOR.md` §11, а конфликт
версий — отдельный `PreconditionFailed`.

### Движок

```ts
const engine = new SyncEngine(vault, backend, {
  deviceName: 'Windows Марины',
  mode: 'peer' | 'hybrid',   // hybrid: облачная версия главная (ТЗ §4.2)
  syncCrdt: true,            // синкать ли .zapiski/crdt — нужно для three-way
});

await engine.load();
await engine.recordLocalEdit(path, body);  // из автосохранения редактора
const outcome = await engine.sync();       // один проход
engine.status();                           // SyncStatus для точки в шапке
```

Один проход `sync()`:

1. `backend.list()`. Сетевая ошибка → `state: 'offline' | 'error'`, текст из
   реестра, **работа не блокируется**.
2. Объединяются пути: локальные заметки + удалённые + очередь изменений.
3. Порядок обхода — `byNotesFirst`: **сначала заметки, потом CRDT-логи**. Иначе
   при слиянии локальный лог уже содержал бы чужие правки, и материализация
   `.md` затёрла бы их.
4. Для каждого пути решение по паре «изменилось локально / изменилось удалённо»
   (локально — по `fnv1a` содержимого против `baseHash`, удалённо — по etag):
   выложить, забрать, ничего, слить.

### Разрешение конфликтов

Когда изменились обе стороны — три пути, в этом порядке:

1. **Зашифрованная заметка (`.md.enc`)** — автослияние невозможно.
   Сохраняются обе версии: чужая падает рядом как
   `Дневник (конфликт, устройство Windows).md.enc`, тост
   «Заметка менялась на двух устройствах. Обе версии сохранены».
   Это **единственный случай, когда пользователь видит две версии**.
2. **У контрагента есть CRDT-лог** — three-way merge через Yjs. Результат
   материализуется в `.md`, лог сохраняется.
3. **Лога нет** (правили чужим редактором) — построчный `diff3(base, mine,
   theirs)` по наибольшей общей подпоследовательности. Ограничение — 5000 строк
   на сторону, дальше O(n·m) не оправдан.

Если diff3 неразрешим, **маркеры `<<<<<<<` в текст не пишутся никогда**:
функция честно возвращает `ok: false`, локальная версия остаётся в файле, чужая
уходит в историю версий, пользователь получает тост «Версии объединены ·
История». Экрана «выберите файл» в продукте не существует.

В режиме `hybrid` снапшот локальной версии уходит в историю до слияния —
облачная версия считается главной.

### Устойчивость

* **Атомарная запись.** `writeAtomic` пишет во временный файл в `.zapiski/tmp`
  и завершает `rename`. Прерывание на любом байте не портит файл.
* **Очередь переживает перезапуск.** `ChangeQueue` — множество путей в
  `.zapiski/sync-queue.json`, а не журнал операций: повторная правка одного
  файла не раздувает очередь.
* **История версий.** `VersionHistory`: последние `MAX_SNAPSHOTS = 50`
  снапшотов на заметку в `.zapiski/versions/<noteId>.json`. Подряд идущий
  дубликат не пишется — иначе автосохранение раз в 500 мс забьёт историю.

### Протокол облака

`sync/protocol.ts` объявляет `API_PREFIX = '/api/v1'`, `VAULT_ENDPOINTS` и DTO
(`CloudEntryDto`, `CloudListResponse`, `CloudPushRequest/Response`,
`CloudPullRequest/Response`, `CloudErrorDto`, `CloudSubscribeEvent`).

> ⚠️ **Расхождение клиента и сервера.** ADR-0003 обещает «типы протокола
> объявлены один раз в `@zapiski/core/sync` и импортируются и клиентом, и
> сервером». Фактически сервер объявил собственный `server/src/protocol.ts`
> (причина — в шапке того файла), а **пути эндпоинтов разошлись**:
>
> | Ядро (`VAULT_ENDPOINTS`) | Сервер |
> | --- | --- |
> | `GET /api/v1/vault/list` | `GET /api/v1/vault/manifest` |
> | `GET/PUT/DELETE /api/v1/vault/blob?path=` | `.../vault/blob/*` (путь в URL) |
> | `POST /api/v1/vault/push` | `POST /api/v1/vault/crdt/:noteId` |
> | `POST /api/v1/vault/pull` | `GET /api/v1/vault/crdt/:noteId?since=` |
> | `WS /api/v1/vault/subscribe` | `WS /api/v1/vault/live` |
> | `GET /api/v1/vault/versions` | `GET /api/v1/vault/versions/:noteId` |
>
> В таком виде `ZapiskiCloudBackend` к работающему серверу не подключится. До
> сведе́ния протокола к одному источнику синк с облаком КОМПАС считать
> нерабочим. Актуальный список эндпоинтов — [modules/server.md](server.md).
>
> Дополнительно: `ZapiskiCloudBackend.pushUpdates` / `pullUpdates`
> (delta-синк по CRDT-векторам, ТЗ §4.1) написаны, но `SyncEngine` их не
> вызывает — он синкает CRDT-логи как обычные файлы.
>
> Следствие в интерфейсе: `packages/app` этот бэкенд не создаёт вовсе. В
> настройках синка подключаются только «локальная папка» и WebDAV; кнопка
> «Облако Записок» ведёт на paywall, «Яндекс.Диск» — на экран входа, потому что
> `YandexDiskBackend` нужен OAuth-токен, а приём токена в оболочках ещё не
> написан ([app.md](app.md#чего-в-пакете-нет)).

---

## Импорт

Общая модель: импортёр превращает вход в `ImportBundle` (`notes`, `assets`,
`warnings`, `folders`), а запись в vault одна на всех — `applyImport`.

```ts
importFolder(files: Map<string, Uint8Array>, { stripRoot })  // Obsidian-vault как есть
importFolderZip(zip)
importBear(zip) / importBearFiles(files)      // .bear2bk → textbundle
importNotion(zip) / importNotionFiles(files)  // md + csv → md, csv → таблица
importEvernote(enex)                          // ENEX/ENML → md, ресурсы → attachments

const report = await applyImport(vault, bundle, {
  targetFolder: 'Импорт',
  onProgress: (done, total) => {},
  signal: { aborted: false },      // отменяемый прогресс из мастера
});
```

Жёсткое правило, которое держится в `applyImport`, а не в каждом импортёре:
**импорт никогда не перезаписывает существующие заметки**. Коллизия — суффикс
` 2`, ` 3`. Одинаковое по байтам вложение не копируется повторно, разное едет
под новым именем.

Особенности источников:

* **Obsidian/папка** — тела переносятся байт-в-байт, структура папок
  сохраняется, поэтому wiki-ссылки остаются рабочими. Пропускаются `.obsidian/`,
  `.trash/`, `.zapiski/`, `__MACOSX/`, `.DS_Store`.
* **Bear** — ссылки `assets/…` переписываются в `attachments/…`.
* **Notion** — из имён срезается 32-символьный хеш; CSV (то есть база Notion)
  конвертируется в markdown-таблицу и попадает в отчёт предупреждением.
  Красная линия «никаких баз данных» соблюдена: на выходе обычная таблица.
* **Evernote** — ENEX разбирается регулярками, без XML-парсера (лишний вес на
  всех трёх платформах); ресурсы из base64 едут в `attachments/`.

Текст отчёта — из реестра: «Импортировано N · Пропущено M — показать».

Мастер импорта (четыре шага из `BEHAVIOR.md` §9) живёт в `packages/app` —
`ImportScreen`. Ядро отдаёт всё необходимое: предпросмотр собирается из
`ImportBundle`, прогресс и отмена — из опций `applyImport`.

## Экспорт

```ts
exportNote(note, 'md' | 'html' | 'docx');     // { name, data }
await exportArchive(vault, paths, { format: 'md', attachments: true });  // zip
markdownToHtml(body);
renderPrintableHtml(note, { meta: true });
exportDocx(note);                              // .docx как zip OOXML, без библиотек
await exportPdf(note, renderer);               // renderer — платформенный порт
```

Экспорт бесплатен и без paywall — прямой ответ на боль Bear. Печатный документ
всегда светлый («Бумага»), колонка 640, без интерфейсных элементов
(`PDF_PAGE_SETUP`).

`exportPdf` требует внешний `PdfRenderer`: растеризация — дело платформы.
Реализации есть в вебе (печать скрытого iframe) и на Windows (WebView2
`PrintToPdf`); на Android код порта написан, но в `AppHost` не подставлен —
[platforms.md](platforms.md#android-что-осталось).

> Веб байтов PDF не отдаёт: файл сохраняет сам браузер через системный диалог
> печати, поэтому `render` возвращает пустой массив, и `exportNoteAs` в этом
> случае не «скачивает» ничего повторно.
>
> Зашифрованная заметка в архив не попадает: `exportArchive` пропускает
> `note.encrypted` — экспорт возможен только после разблокировки.

## i18n

```ts
catalog('ru').errors.offline;   // 'Оффлайн · всё сохранено локально'
resolveLocale(navigator.languages);
DEFAULT_LOCALE;                 // 'ru'
```

Каталоги `ru` и `en`. Раздел `errors` в `ru` скопирован **дословно** из реестра
`BEHAVIOR.md` §11 — менять тексты здесь нельзя, приёмка требует посимвольного
совпадения. Разделы: `errors`, `actions`, `notes`, `empty`, `sync`.

## Что в ядре реализовано, а что нет

| Область | Состояние |
| --- | --- |
| Vault, корзина, архив, закрепление, вложения | ✅ |
| Переименование с транзакционным обновлением ссылок | ✅ |
| Индекс, FTS, все операторы, фрагменты, backlinks | ✅ |
| Крипто: контейнер, Argon2id, AES-GCM, шифрование файла | ✅ |
| CRDT, компактные логи, three-way merge, diff3 | ✅ |
| Синк: LocalFolder, WebDAV, Яндекс.Диск | ✅ |
| Синк: KompasCloud | ⚠️ клиент написан, пути протокола расходятся с сервером |
| Импорт: папка/Obsidian, Bear, Notion, Evernote | ✅ |
| Экспорт: md, HTML, DOCX | ✅ |
| Экспорт: PDF | ✅ в вебе и на Windows; на Android порт написан, но не подставлен в `AppHost` |
| Реализации `VaultStorage` (FSA, OPFS, Tauri FS) | ✅ во всех трёх оболочках |
| `PlatformCapabilities`: биометрия, хэптика, хоткей, share, updater | ✅ там, где платформа это умеет — [platforms.md](platforms.md) |
| `FLAG_SECURE` | ✅ на Android; на Windows и в вебе — осознанный no-op |
