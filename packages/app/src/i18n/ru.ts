/**
 * Каталог строк экранов — русский (основной язык, ТЗ §6).
 *
 * ARCHITECTURE §3, инвариант 5: «ни одной строки, зашитой в компонент».
 * Всё, что видит пользователь, лежит здесь.
 *
 * Тексты ошибок сюда НЕ копируются: реестр BEHAVIOR §11 живёт в
 * `@zapiski/core/i18n` и берётся оттуда как есть (`useStrings().errors`).
 * Дублирование реестра — прямой путь к расхождению с приёмочным критерием C11.
 */

export const ru = {
  app: {
    wordmark: 'ЗАПИСКИ',
    wordmarkPlus: 'ЗАПИСКИ+',
    back: 'Назад',
    close: 'Закрыть',
    cancel: 'Отмена',
    more: 'Ещё',
    menu: 'Меню',
    done: 'Готово',
    continue: 'Продолжить',
    skip: 'Пропустить',
    loading: 'Загружаем',
    untitled: 'Без названия',
  },

  // ── Онбординг (SCREENS §1) ────────────────────────────────────────────────
  onboarding: {
    progressLabel: 'Шаг онбординга',
    step1: {
      title: 'Тихая комната для мыслей',
      subtitle:
        'Заметки лежат обычными файлами на вашем устройстве. Без облака по умолчанию, без аккаунта, без чужих глаз.',
      bullets: [
        {
          title: 'Обычные файлы .md',
          text: 'Открываются любым редактором. Приложение можно удалить — заметки останутся.',
        },
        {
          title: 'Шифрование бесплатно',
          text: 'AES-256 на устройстве. Ключ знаете только вы.',
        },
        {
          title: 'Синхронизация через своё хранилище',
          text: 'WebDAV, Яндекс.Диск или папка — на ваш выбор.',
        },
      ],
      start: 'Начать',
      importLink: 'Перенести из Bear, Obsidian или Notion',
    },
    step2: {
      title: 'Где будут жить ваши заметки?',
      options: {
        local: {
          title: 'На этом устройстве',
          text: 'полный оффлайн, без регистрации и аккаунта',
          badge: 'бесплатно',
        },
        own: {
          title: 'Своё облако',
          text: 'WebDAV или Яндекс.Диск',
          badge: 'бесплатно',
        },
        kompas: {
          title: 'Облако СИМПАС',
          text: 'E2E-шифрование, история версий, мгновенный синк',
          badge: 'подписка',
        },
      },
      footnote: 'Можно поменять в любой момент в настройках',
      pickFolder: 'Выбрать папку',
      next: 'Дальше',
    },
    step3: {
      chip: 'Локальный режим включён — можно писать',
      placeholder:
        'Просто пишите. Первая строка станет заголовком, #тег — тегом, а сохранится всё само',
    },
  },

  // ── Вход (SCREENS §2) — только Яндекс ID и magic-link, ни одного SMS-пути ──
  signIn: {
    title: 'Аккаунт нужен только для облака',
    subtitle: 'Локальные заметки работают без него',
    yandex: 'Войти с Яндекс ID',
    yandexLogoAlt: 'Яндекс',
    divider: 'или по почте',
    emailLabel: 'Почта',
    emailPlaceholder: 'marina@ya.ru',
    sendLink: 'Получить ссылку для входа',
    promise: 'Без паролей и СМС: пришлём письмо со ссылкой — один тап, и вы в аккаунте',
    privacy: 'Заметки мы не читаем — технически не можем',
    sentTitle: (email: string): string => `Письмо ушло на ${email} · проверьте почту`,
    resend: 'Отправить снова',
    resendIn: (seconds: number): string => `Отправить снова через ${seconds} с`,
    expiredTitle: 'Ссылка больше не действует',
    sendNew: 'Прислать новую',
  },

  // ── Список заметок (SCREENS §3) ───────────────────────────────────────────
  list: {
    title: 'Все заметки',
    openLibrary: 'Открыть библиотеку',
    pinnedSection: 'ЗАКРЕПЛЁННЫЕ',
    newNote: 'Новая заметка',
    searchPlaceholder: 'Поиск по заметкам',
    listLabel: 'Заметки',
    encrypted: 'Зашифровано',
    pin: 'Закрепить',
    unpin: 'Открепить',
    archive: 'В архив',
    unarchive: 'Вернуть из архива',
    duplicate: 'Дублировать',
    move: 'Переместить',
    encrypt: 'Зашифровать',
    exportNote: 'Экспорт',
    delete: 'Удалить',
    emptyTitle: 'Здесь пока тихо',
    emptyText: 'Первая мысль появится за две секунды',
    emptyFolderTitle: 'В этой папке пусто',
    sortMenu: 'Сортировка',
    sort: {
      updated: 'По дате изменения',
      created: 'По дате создания',
      title: 'По заголовку А-Я',
      manual: 'Вручную',
    },
    words: (count: number): string => `${count} ${plural(count, 'слово', 'слова', 'слов')}`,
    markPinned: 'закреплена',
    markAttachment: 'есть вложение',
    markEncrypted: 'зашифрована',
    lockedPlaceholder: 'Заметка заперта',
  },

  // ── Редактор (SCREENS §4) ─────────────────────────────────────────────────
  note: {
    info: 'Инфо',
    raw: 'Показать разметку',
    focus: 'Фокус',
    focusHint: 'фокус · Esc — выйти',
    lockNow: 'Запереть сейчас',
    backlinksTitle: (count: number): string => `↩ ССЫЛАЮТСЯ НА ЭТУ ЗАМЕТКУ · ${count}`,
    statusChanged: 'изменено только что',
    statusAutosave: 'автосохранение — всегда',
    statusWords: (count: number): string => `${count} ${plural(count, 'слово', 'слова', 'слов')}`,
    placeholder: 'Просто пишите. Первая строка станет заголовком',
    toolbar: {
      label: 'Форматирование',
      heading: 'Заголовок',
      bold: 'Жирный',
      italic: 'Курсив',
      list: 'Список',
      checkbox: 'Чекбокс',
      image: 'Фото',
      voice: 'Голос',
      more: 'Ещё',
      quote: 'Цитата',
      code: 'Код',
      table: 'Таблица',
      divider: 'Разделитель',
      link: 'Ссылка',
      footnote: 'Сноска',
      wikiLink: 'Wiki-ссылка',
    },
    infoPanel: {
      title: 'Инфо',
      created: 'Создана',
      updated: 'Изменена',
      stats: 'Статистика',
      chars: (count: number): string => `${count} ${plural(count, 'знак', 'знака', 'знаков')}`,
      readingTime: (minutes: number): string => `${minutes} мин чтения`,
      attachments: 'Вложения',
      backlinks: 'Обратные ссылки',
      actions: 'Действия',
      path: 'Путь к файлу',
      pathCopied: 'Путь скопирован',
    },
    diaryLink: 'ДНЕВНИК',
  },

  // ── Библиотека (SCREENS §5) ───────────────────────────────────────────────
  library: {
    label: 'Библиотека',
    all: 'Все заметки',
    pinned: 'Закреплённые',
    folders: 'ПАПКИ',
    tags: 'ТЕГИ',
    archive: 'Архив',
    trash: 'Корзина',
    emptyFolders: 'Пока нет папок',
    newSubfolder: 'Новая подпапка',
    rename: 'Переименовать',
    deleteFolder: 'Удалить папку',
    deleteFolderQuestion: (name: string, count: number): string =>
      `Удалить папку «${name}» и ${count} ${plural(count, 'заметку', 'заметки', 'заметок')}?`,
    deleteFolderOnly: 'Только папку (заметки — в родительскую)',
    deleteFolderWithNotes: 'Папку с заметками (в корзину)',
    renamedTags: (count: number): string =>
      `Переименовано в ${count} ${plural(count, 'заметке', 'заметках', 'заметках')}`,
  },

  // ── Поиск (SCREENS §6, BEHAVIOR §4) ───────────────────────────────────────
  search: {
    title: 'Поиск',
    placeholder: 'Найти заметку',
    recent: 'НЕДАВНИЕ',
    lastOpened: 'ПОСЛЕДНИЕ ОТКРЫТЫЕ',
    emptyTitle: 'Ничего не нашлось',
    emptyHintPrefix: 'Попробуйте снять фильтр:',
    filters: {
      tag: 'Тег',
      folder: 'Папка',
      period: 'Период',
      has: 'Содержит',
    },
    hasValues: {
      image: 'картинку',
      file: 'файл',
      todo: 'задачу',
      link: 'ссылку',
    },
    periodValues: {
      today: 'сегодня',
      week: 'неделя',
      month: 'месяц',
      year: 'год',
    },
    inNote: 'Поиск в заметке',
    counter: (index: number, total: number): string => `${index} из ${total}`,
    replace: 'Замена',
    replaceAll: 'Заменить всё',
    /** Подпись «Отменить» подставляет тост из реестра ядра — здесь только счёт. */
    replaced: (count: number): string => `Заменено: ${count}`,
  },

  // ── Архив и корзина ───────────────────────────────────────────────────────
  archive: {
    title: 'Архив',
    emptyTitle: 'В архиве пусто',
  },
  trash: {
    title: 'Корзина',
    emptyTitle: 'Корзина пуста',
    restore: 'Восстановить',
    purge: 'Очистить корзину',
    purgeQuestion: 'Очистить корзину? Заметки будут удалены навсегда.',
    purgeConfirm: 'Очистить',
    ttlHint: (days: number): string => `Заметки хранятся ${days} дней, потом удаляются сами`,
    deletedAt: (date: string): string => `удалена ${date}`,
  },

  // ── Шифрование (SCREENS §7, BEHAVIOR §5) ──────────────────────────────────
  crypto: {
    setupTitle: 'Зашифровать заметку',
    password: 'Пароль',
    passwordRepeat: 'Повторите пароль',
    hint: 'Подсказка (по желанию)',
    mismatch: 'Пароли не совпадают',
    tooShort: 'Не меньше 8 символов',
    biometricsToggle: 'Разблокировать отпечатком',
    warning: 'Пароль знаете только вы. Восстановить его мы не сможем — это и есть защита.',
    encrypt: 'Зашифровать',
    strengthLabel: 'Надёжность пароля',
    lockedTitle: 'Заметка зашифрована на этом устройстве. AES-256 · ключ только у вас',
    unlock: 'Разблокировать',
    useBiometrics: 'Использовать отпечаток',
    pinLabel: 'Пароль',
    biometricsTitle: 'Разблокировать отпечатком',
    biometricsSubtitle: 'ключ хранится в защищённом модуле',
    usePassword: 'Ввести пароль',
    decryptedChip: (minutes: number): string => `Расшифровано · закроется через ${minutes} мин`,
    closingSoon: 'Закроется через 30 секунд',
    fileNote: (name: string): string => `файл на диске: ${name} · всегда зашифрован`,
    tryLaterIn: (seconds: number): string => `Попробуйте через ${seconds} ${plural(seconds, 'секунду', 'секунды', 'секунд')}`,
    removeTitle: 'Снять шифрование',
    removeQuestion: 'Заметка станет обычным файлом на диске. Продолжить?',
    removeConfirm: 'Снять шифрование',
    autoLockLabel: 'Автозамок',
    autoLockValues: {
      1: 'через 1 минуту',
      5: 'через 5 минут',
      10: 'через 10 минут',
      30: 'через 30 минут',
      never: 'до выхода из приложения',
    },
  },

  // ── Настройки (SCREENS §8, BEHAVIOR §10) ──────────────────────────────────
  settings: {
    title: 'Настройки',
    nav: 'Разделы настроек',
    sections: {
      appearance: 'Внешний вид',
      editor: 'Редактор',
      sync: 'Синхронизация',
      security: 'Безопасность',
      transfer: 'Экспорт и импорт',
      storage: 'Хранилище',
      account: 'Аккаунт',
      plus: 'ЗАПИСКИ+',
    },
    appearance: {
      previewTitle: 'Как это выглядит',
      previewBody:
        'Спокойный текст без лишнего блеска. Здесь видно размер, интерлиньяж и ширину колонки — всё меняется сразу.',
      theme: 'Тема',
      themes: {
        system: 'Система',
        simpas: 'СИМПАС',
        graphite: 'Графит',
        ink: 'Чернила',
      },
      accent: 'Акцент',
      /* Шесть пресетов DS-ALIGNMENT §3; терракоты в наборе нет. */
      accents: {
        pine: 'Хвоя',
        forest: 'Лес',
        gold: 'Золото',
        dusk: 'Сумерки',
        granite: 'Гранит',
        clay: 'Глина',
      },
      fontSize: 'Размер текста',
      fontSizeSmall: 'А',
      fontSizeLarge: 'А',
      lineHeight: 'Интерлиньяж',
      lineHeightValues: { 1.45: 'Плотный', 1.65: 'Обычный', 1.85: 'Просторный' },
      columnWidth: 'Ширина колонки',
      columnWidthValues: { 640: '640', 720: '720', full: 'Вся ширина' },
      typeface: 'Шрифт',
      typefaceValues: { sans: 'Geist', serif: 'Serif' },
      compact: 'Компактный режим',
    },
    editor: {
      typewriter: 'Держать строку по центру (typewriter)',
      moveDone: 'Переносить выполненные вниз',
      rawByDefault: 'Показывать разметку по умолчанию',
      spellcheck: 'Проверять орфографию',
    },
    sync: {
      statusSynced: 'Синхронизировано',
      statusLine: (time: string, notes: number, size: string): string =>
        `${time} · ${notes} ${plural(notes, 'заметка', 'заметки', 'заметок')} · ${size}`,
      syncNow: 'Синхронизировать сейчас',
      backends: 'Хранилище',
      connected: 'подключено',
      connect: 'Подключить',
      disconnect: 'Отключить',
      webdavCard: 'Подключить WebDAV — любой сервер',
      webdavUrl: 'Адрес сервера',
      webdavUser: 'Логин',
      webdavPassword: 'Пароль',
      yandex: 'Яндекс.Диск',
      kompas: 'Облако СИМПАС',
      kompasBadge: 'ЗАПИСКИ+',
      localFolder: 'Папка на устройстве',
      conflictsMonth: (count: number): string =>
        `Конфликтов за месяц: ${count} — ${count === 1 ? 'объединён' : 'объединены'} автоматически, обе версии в истории`,
      historyLink: 'История',
    },
    security: {
      encryptDefault: 'Шифровать новые заметки',
      biometrics: 'Разблокировать биометрией',
      secureScreen: 'Скрывать содержимое в превью задач',
    },
    transfer: {
      importTitle: 'Импорт',
      importButton: 'Импортировать заметки',
      exportTitle: 'Экспорт',
      exportAll: 'Выгрузить всё в zip',
      exportNote: 'Экспорт заметки',
      formats: { md: 'Markdown', pdf: 'PDF', html: 'HTML', docx: 'DOCX', zip: 'ZIP-архив' },
    },
    storage: {
      pathLabel: 'Папка с заметками',
      sizeLabel: 'Размер',
      filesLabel: 'Файлов',
      openFolder: 'Открыть папку',
      changeFolder: 'Сменить папку',
      changeFolderHint: 'Заметки не переносятся автоматически — скопируйте их сами',
      findOrphans: 'Найти неиспользуемые вложения',
      orphansFound: (count: number): string =>
        `Неиспользуемых вложений: ${count}`,
      rebuild: 'Перестроить индекс',
      rebuildHint: 'Безопасно: индекс — производная от файлов',
    },
    account: {
      noAccount: 'Аккаунт не нужен для локальной работы',
      signIn: 'Войти',
      plan: 'Тариф',
      planFree: 'Бесплатный',
      planPlus: 'ЗАПИСКИ+',
      signOut: 'Выйти',
      signOutQuestion: 'Выйти из аккаунта? Локальные заметки останутся на устройстве.',
      signOutConfirm: 'Выйти',
    },
    reset: 'Сбросить настройки',
    resetQuestion: 'Сбросить настройки? Заметки не пострадают.',
    resetConfirm: 'Сбросить',
    debugMenu: 'Отладочное меню',
  },

  // ── Paywall (SCREENS §9) ──────────────────────────────────────────────────
  paywall: {
    subtitle: 'Платите за облако и серверы. Всё остальное — бесплатно навсегда',
    price: '199 ₽/мес или 149 ₽ при оплате за год',
    monthly: 'Помесячно · 199 ₽',
    yearly: 'За год · 149 ₽/мес',
    yearlyNote: 'выгоднее на 25%',
    tableLabel: 'Что входит',
    columns: { feature: 'Возможность', free: 'Бесплатно', plus: 'ЗАПИСКИ+' },
    rows: {
      editor: 'Редактор и живой предпросмотр',
      crypto: 'Шифрование AES-256',
      export: 'Экспорт в md, PDF, HTML, DOCX',
      ownStorage: 'Локально · WebDAV · Яндекс.Диск',
      cloud: 'Облако СИМПАС',
      cloudPlus: '10 ГБ',
      publish: 'Публикация страницы',
      voice: 'Транскрибация',
      voiceFree: '10 мин/мес',
    },
    yes: 'есть',
    no: 'нет',
    trial: 'Попробовать 14 дней',
    honest: 'Отмена в один тап. Без таймеров и «скидок только сегодня»',
    bundle: 'Вместе с ДНЕВНИКОМ — +100 ₽',
  },

  // ── Импорт (BEHAVIOR §9, мастер из 4 шагов) ───────────────────────────────
  importer: {
    title: 'Импорт заметок',
    steps: ['Источник', 'Файлы', 'Предпросмотр', 'Готово'],
    sources: {
      obsidian: 'Obsidian — папка vault',
      bear: 'Bear — экспорт в Markdown',
      notion: 'Notion — выгрузка zip',
      evernote: 'Evernote — файл .enex',
      folder: 'Просто папка с .md',
    },
    pick: 'Выбрать файлы',
    picked: (count: number): string => `Выбрано файлов: ${count}`,
    preview: (notes: number, assets: number, folders: number): string =>
      `Найдено: ${notes} ${plural(notes, 'заметка', 'заметки', 'заметок')}, ${assets} ${plural(assets, 'вложение', 'вложения', 'вложений')}, ${folders} ${plural(folders, 'папка', 'папки', 'папок')}`,
    target: 'Куда положить',
    targetRoot: 'В корень',
    start: 'Импортировать',
    running: 'Импортируем',
    cancel: 'Отменить импорт',
    neverOverwrites: 'Импорт никогда не перезаписывает существующие заметки',
    done: (imported: number): string =>
      `Импортировано ${imported} ${plural(imported, 'заметка', 'заметки', 'заметок')}`,
    showSkipped: 'Показать пропущенные',
  },

  // ── История версий (SCREENS §10b `4h`) ────────────────────────────────────
  versions: {
    title: 'История версий',
    listLabel: 'Версии',
    merged: 'объединено автоматически',
    original: 'Оригинал расшифровки',
    restore: 'Восстановить эту версию',
    restored: 'Версия восстановлена',
    counters: (added: number, removed: number): string => `+${added} · −${removed}`,
    empty: 'История пока пуста',
    source: (name: string): string => `источник: ${name}`,
  },

  // ── Палитра команд (SCREENS §10b `4g`) ────────────────────────────────────
  palette: {
    label: 'Палитра команд',
    placeholder: 'Команда, заметка, #тег или > настройка',
    groups: {
      commands: 'КОМАНДЫ',
      notes: 'ЗАМЕТКИ',
      folders: 'ПАПКИ',
      tags: 'ТЕГИ',
      settings: 'НАСТРОЙКИ',
    },
    footer: '↑↓ — выбор · ↵ — открыть · # — теги · > — настройки',
    empty: 'Ничего не нашлось',
  },

  // ── Команды (BEHAVIOR §7 — те же подписи в палитре и в меню) ──────────────
  commands: {
    newNote: 'Новая заметка',
    newNoteHere: 'Новая заметка в текущей папке',
    palette: 'Палитра команд',
    focusMode: 'Режим фокуса',
    findInNote: 'Поиск в заметке',
    replaceInNote: 'Замена в заметке',
    globalSearch: 'Глобальный поиск',
    toggleRaw: 'Показать разметку',
    toggleLibrary: 'Показать библиотеку',
    bold: 'Жирный',
    italic: 'Курсив',
    highlight: 'Подсветка',
    strike: 'Зачёркнутый',
    heading: (level: number): string => `Заголовок H${level}`,
    paragraph: 'Обычный абзац',
    bulletList: 'Маркированный список',
    orderedList: 'Нумерованный список',
    checkbox: 'Чекбокс',
    quote: 'Цитата',
    codeBlock: 'Код-блок',
    link: 'Вставить ссылку',
    wikiLink: 'Wiki-ссылка',
    duplicateLine: 'Дублировать строку',
    moveLine: 'Переместить строку',
    moveLineUp: 'Переместить строку выше',
    moveLineDown: 'Переместить строку ниже',
    pastePlain: 'Вставить без форматирования',
    toggleTask: 'Отметить чекбокс',
    settings: 'Настройки',
    exportNote: 'Экспорт заметки',
    togglePin: 'Закрепить/открепить',
    quickNote: 'Быстрая заметка поверх всех окон',
  },

  // ── Share-target (SCREENS §10b `4f`, BEHAVIOR §8) ─────────────────────────
  share: {
    title: 'Добавить в заметки',
    newNote: 'Новая заметка',
    existing: 'Найти заметку',
    folder: 'Папка',
    add: 'Добавить',
    added: (title: string): string => `Добавлено в «${title}»`,
    open: 'Открыть',
  },

  // ── Синхронизация в UI (BEHAVIOR §6) ──────────────────────────────────────
  sync: {
    indicator: 'Состояние синхронизации',
    panelTitle: 'Синхронизация',
    lastSync: 'Последняя синхронизация',
    never: 'ещё не было',
    notes: (count: number): string => `${count} ${plural(count, 'заметка', 'заметки', 'заметок')}`,
    syncNow: 'Синхронизировать сейчас',
  },

  // ── Отладочное меню (приёмочный критерий №10, BEHAVIOR §12) ───────────────
  debug: {
    title: 'Отладочное меню',
    subtitle: 'Матрица «экран × состояние» из BEHAVIOR §12 — каждая ячейка воспроизводима',
    screen: 'Экран',
    state: 'Состояние',
    backend: 'Бэкенд синка',
    apply: 'Показать',
    reset: 'Вернуть как есть',
    active: (screen: string, state: string): string => `Показывается: ${screen} · ${state}`,
    screens: {
      list: 'Список заметок',
      folder: 'Папка/тег',
      note: 'Редактор',
      search: 'Поиск',
      library: 'Библиотека',
      archive: 'Архив',
      trash: 'Корзина',
      settingsSync: 'Настройки · синк',
      backlinks: 'Backlinks',
    },
    states: {
      normal: 'Обычное',
      empty: 'Пустое',
      loading: 'Загрузка',
      offline: 'Оффлайн',
      error: 'Ошибка',
      locked: 'Заперто',
    },
    backends: {
      none: 'без бэкенда',
      local: 'Папка на устройстве',
      webdav: 'WebDAV',
      yandex: 'Яндекс.Диск',
      kompas: 'Облако СИМПАС',
    },
    notApplicable: 'В этой ячейке матрицы состояния нет — по BEHAVIOR §12 это прочерк',
  },

  // ── Даты и месяцы (BEHAVIOR §1.2) ─────────────────────────────────────────
  months: [
    'ЯНВАРЬ',
    'ФЕВРАЛЬ',
    'МАРТ',
    'АПРЕЛЬ',
    'МАЙ',
    'ИЮНЬ',
    'ИЮЛЬ',
    'АВГУСТ',
    'СЕНТЯБРЬ',
    'ОКТЯБРЬ',
    'НОЯБРЬ',
    'ДЕКАБРЬ',
  ],
  relative: {
    justNow: 'только что',
    minutesAgo: (n: number): string => `${n} ${plural(n, 'минуту', 'минуты', 'минут')} назад`,
    hoursAgo: (n: number): string => `${n} ${plural(n, 'час', 'часа', 'часов')} назад`,
    yesterday: 'вчера',
  },
  units: {
    bytes: (n: number): string => `${n} Б`,
    kilobytes: (n: number): string => `${n} КБ`,
    megabytes: (n: number): string => `${n} МБ`,
    gigabytes: (n: number): string => `${n} ГБ`,
  },
};

/** Русская форма множественного числа: 1 заметка, 2 заметки, 5 заметок. */
export function plural(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(count) % 100;
  const tail = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (tail > 1 && tail < 5) return few;
  if (tail === 1) return one;
  return many;
}

/** Форма каталога. `en` — перевод, а не копия: литеральных типов здесь нет. */
export type AppCatalog = typeof ru;
