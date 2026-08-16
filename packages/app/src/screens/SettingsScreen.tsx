/**
 * Настройки — SCREENS §8, BEHAVIOR §10.
 *
 * Главное правило раздела: всё применяется МГНОВЕННО, кнопки «Применить» нет.
 * Смена темы и акцента идёт кроссфейдом 200 мс силами ThemeProvider — без
 * перезагрузки и без белой вспышки.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  ACCENTS,
  Badge,
  Button,
  EDITOR_COLUMN_WIDTHS,
  EDITOR_FONT_SIZES,
  EDITOR_LINE_HEIGHTS,
  IconArrowLeft,
  IconButton,
  IconInfo,
  InfoNote,
  Modal,
  SegmentedControl,
  Switch,
  SyncDot,
  TextField,
  THEME_PREFERENCES,
  useTheme,
  type Accent,
  type EditorColumnWidth,
  type PanelPlacement,
  type ThemePreference,
} from '@zapiski/ui';
import {
  BILLING_ENABLED,
  LocalFolderBackend,
  WebDAVBackend,
  type AttachmentNaming,
  type SyncBackend,
  LEGAL_URLS,
} from '@zapiski/core';
import type { AttachmentPlacement, SettingsSection } from '../contract.js';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { Section } from '../components/ScreenStates.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { IconBug, IconMerge } from '../components/icons.js';
import { clockTime, formatBytes } from '../lib/format.js';

/*
 * Раздел «ЗАПИСКИ+» появляется вместе с оплатой, а не раньше. Пока всё
 * бесплатно, рассказывать про тариф нечего: раздел с ценами у продукта,
 * который ничего не стоит, обещает ограничение, которого нет.
 *
 * Именно СПРЯТАН, а не удалён: `PlusSection`, экран тарифов и все тексты на
 * месте и вернутся одной строкой — `BILLING_ENABLED` в `@zapiski/core`.
 */
/** Минимум пароля хранилища — тот же, что в листе шифрования (BEHAVIOR §5.1). */
const MIN_PASSWORD = 8;

const SECTIONS: SettingsSection[] = [
  'appearance',
  'editor',
  'attachments',
  'sync',
  'security',
  'transfer',
  'account',
  ...(BILLING_ENABLED ? (['plus'] as SettingsSection[]) : []),
  'about',
];

export interface SettingsScreenProps {
  section: SettingsSection;
}

export function SettingsScreen({ section }: SettingsScreenProps): ReactNode {
  const app = useApp();
  const strings = useStrings();

  return (
    <div className="za-editor">
      <div className="za-header">
        <IconButton
          icon={<IconArrowLeft size={20} />}
          label={strings.app.back}
          tone="ghost"
          onClick={() => app.back()}
        />
        <h1 className="za-h1 za-h1--mobile za-header__title">{strings.settings.title}</h1>
      </div>

      <div className="za-settings">
        <nav className="za-settings__nav" aria-label={strings.settings.nav}>
          {SECTIONS.map((item) => (
            <button
              key={item}
              type="button"
              className={`za-settings__nav-item${item === section ? ' za-settings__nav-item--active' : ''}`}
              aria-current={item === section || undefined}
              onClick={() => app.navigate({ name: 'settings', section: item }, { replace: true })}
            >
              {strings.settings.sections[item]}
            </button>
          ))}
        </nav>

        <div className="za-scroll">
          <div className="za-page za-stack">
            {section === 'appearance' ? <AppearanceSection /> : null}
            {section === 'editor' ? <EditorSection /> : null}
            {section === 'attachments' ? <AttachmentsSection /> : null}
            {/* «Хранилище» и «Синхронизация» — один раздел: место у заметок
                одно, и разносить его по двум пунктам значило обещать, что их
                можно набрать себе несколько. Старый адрес продолжает работать
                и ведёт сюда же. */}
            {section === 'sync' || section === 'storage' ? <SyncSection /> : null}
            {section === 'security' ? <SecuritySection /> : null}
            {section === 'transfer' ? <TransferSection /> : null}
            {section === 'account' ? <AccountSection /> : null}
            {section === 'plus' ? <PlusSection /> : null}
            {section === 'about' ? <AboutSection /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Внешний вид — макет `4i`: живое превью сверху, всё применяется мгновенно. */
function AppearanceSection(): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const theme = useTheme();
  const copy = strings.settings.appearance;

  return (
    <>
      {/* Превью-заметка обновляется вживую (SCREENS §8, BEHAVIOR §10). */}
      <div className="za-preview">
        <p className="za-caption">{copy.previewTitle}</p>
        <h2 className="za-h2">{strings.list.title}</h2>
        <p className="z-body">{copy.previewBody}</p>
        <p className="za-tertiary-mono">{strings.note.statusAutosave}</p>
      </div>

      <Section>{copy.theme}</Section>
      <SegmentedControl<ThemePreference>
        label={copy.theme}
        value={theme.preference}
        onChange={theme.setTheme}
        options={THEME_PREFERENCES.map((value) => ({ value, label: copy.themes[value] }))}
      />

      <Section>{copy.accent}</Section>
      <div className="za-swatches" role="radiogroup" aria-label={copy.accent}>
        {ACCENTS.map((accent: Accent) => (
          <button
            key={accent}
            type="button"
            role="radio"
            aria-checked={theme.accent === accent}
            aria-label={copy.accents[accent]}
            title={copy.accents[accent]}
            className={`za-swatch${theme.accent === accent ? ' za-swatch--active' : ''}`}
            /* data-accent переопределяет --accent каскадом — hex тут не нужен. */
            data-accent={accent}
            onClick={() => theme.setAccent(accent)}
          />
        ))}
      </div>

      <Section>{copy.fontSize}</Section>
      <div className="za-row-between">
        <span className="za-muted">{copy.fontSizeSmall}</span>
        <input
          className="za-slider"
          type="range"
          min={0}
          max={EDITOR_FONT_SIZES.length - 1}
          step={1}
          aria-label={copy.fontSize}
          value={EDITOR_FONT_SIZES.indexOf(theme.editor.fontSize)}
          onChange={(event) => {
            const next = EDITOR_FONT_SIZES[Number(event.target.value)];
            if (next) theme.setEditor({ fontSize: next });
          }}
        />
        <span style={{ fontSize: 20 }}>{copy.fontSizeLarge}</span>
      </div>

      <Section>{copy.lineHeight}</Section>
      <SegmentedControl<string>
        label={copy.lineHeight}
        value={String(theme.editor.lineHeight)}
        onChange={(value) => {
          const next = EDITOR_LINE_HEIGHTS.find((item) => String(item) === value);
          if (next) theme.setEditor({ lineHeight: next });
        }}
        options={EDITOR_LINE_HEIGHTS.map((value) => ({
          value: String(value),
          label: copy.lineHeightValues[value],
        }))}
      />

      <Section>{copy.columnWidth}</Section>
      <SegmentedControl<string>
        label={copy.columnWidth}
        value={String(theme.editor.columnWidth)}
        onChange={(value) => {
          const next = EDITOR_COLUMN_WIDTHS.find((item) => String(item) === value);
          if (next !== undefined) theme.setEditor({ columnWidth: next as EditorColumnWidth });
        }}
        options={EDITOR_COLUMN_WIDTHS.map((value) => ({
          value: String(value),
          label: copy.columnWidthValues[value],
        }))}
      />

      <Section>{copy.typeface}</Section>
      <SegmentedControl<'sans' | 'serif'>
        label={copy.typeface}
        value={theme.editor.typeface}
        onChange={(value) => theme.setEditor({ typeface: value })}
        options={[
          { value: 'sans', label: copy.typefaceValues.sans },
          { value: 'serif', label: copy.typefaceValues.serif },
        ]}
      />

      <div className="za-field-row">
        <Switch
          label={copy.compact}
          checked={theme.editor.compact}
          onChange={(event) => theme.setEditor({ compact: event.target.checked })}
        />
      </div>

      {/*
        Что показывает открытая папка. Живёт во «Внешнем виде», потому что это
        про вид списка, а не про место хранения: файлы на диске от переключателя
        не двигаются.
      */}
      <Section>{copy.subfolderNotes}</Section>
      <SegmentedControl<'own' | 'nested'>
        label={copy.subfolderNotes}
        value={app.subfolderNotesValue() ? 'nested' : 'own'}
        onChange={(value) => void app.setSubfolderNotes(value === 'nested')}
        options={[
          { value: 'own', label: copy.subfolderNotesValues.own },
          { value: 'nested', label: copy.subfolderNotesValues.nested },
        ]}
      />
      <p className="za-muted">{copy.subfolderNotesHint}</p>

      <Button variant="text" iconStart={<IconBug size={16} />} onClick={() => app.toggleDebug(true)}>
        {strings.settings.debugMenu}
      </Button>
    </>
  );
}


/**
 * Вложения (ITERATION-1 §5).
 *
 * «Картинки не вставляются в редактор и непонятно, где хранятся; это не
 * настраивается никак» — из письма пользователя. Вставка на самом деле
 * работала, а вот куда именно ложится файл, узнать было неоткуда: правило было
 * зашито в ядро и нигде не показано.
 *
 * Поэтому внизу раздела — фактический путь моноширинным. Настройка без
 * показанного результата остаётся обещанием: человек выбирает «своя папка» и
 * не видит, что получилось.
 */
function AttachmentsSection(): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const copy = strings.attachments;
  const [folder, setFolder] = useState(app.attachmentFolderValue());
  const [orphans, setOrphans] = useState<number | null>(null);
  const placement = app.attachmentPlacementValue();

  return (
    <>
      <Section>{copy.folder}</Section>
      <SegmentedControl<AttachmentPlacement>
        label={copy.folder}
        value={placement}
        onChange={(value) => void app.setAttachmentPlacement(value)}
        options={[
          { value: 'shared', label: copy.placement.shared },
          { value: 'beside', label: copy.placement.beside },
          { value: 'custom', label: copy.placement.custom },
        ]}
      />

      {/* Поле пути появляется только у «своей папки»: в остальных случаях
          вводить нечего, а отключённое поле — тот же неработающий контрол. */}
      {placement === 'custom' ? (
        <TextField
          label={copy.customLabel}
          placeholder={copy.customHint}
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          onBlur={() => void app.setAttachmentFolder(folder)}
        />
      ) : null}

      <Section>{copy.naming}</Section>
      <SegmentedControl<AttachmentNaming>
        label={copy.naming}
        value={app.attachmentNamingValue()}
        onChange={(value) => void app.setAttachmentNaming(value)}
        options={[
          { value: 'hash', label: copy.namingValues.hash },
          { value: 'original', label: copy.namingValues.original },
          { value: 'date-original', label: copy.namingValues['date-original'] },
        ]}
      />

      {/* Ужимание — выбор из двух, а не тумблер: «Оставлять оригинал» это
          полноценный вариант, а не выключенное состояние (§5). */}
      <Section>{copy.largeImages}</Section>
      <SegmentedControl<'downscale' | 'original'>
        label={copy.largeImages}
        value={app.attachmentDownscaleValue() ? 'downscale' : 'original'}
        onChange={(value) => void app.setAttachmentDownscale(value === 'downscale')}
        options={[
          { value: 'downscale', label: copy.largeImageValues.downscale },
          { value: 'original', label: copy.largeImageValues.original },
        ]}
      />
      <p className="za-muted">{copy.largeImagesHint}</p>

      <Section>{copy.actualPath}</Section>
      <p className="za-tertiary-mono">{app.attachmentPathHint()}</p>

      {/*
        Служебные папки в библиотеке (замечание заказчика: «так как это
        "системные" папки — они должны быть серыми и в настройках и должно
        быть можно скрыть»).

        Показывать по умолчанию: спрятанная папка означала бы, что человек не
        найдёт в приложении свои же файлы. Серый вид в дереве отделяет их от
        папок, которые он завёл сам, а выключатель — для тех, кому и этого
        много. Скрытие ничего не удаляет, и это сказано прямо под выбором.
      */}
      <Section>{copy.systemFolders}</Section>
      <SegmentedControl<'show' | 'hide'>
        label={copy.systemFolders}
        value={app.attachmentFoldersShownValue() ? 'show' : 'hide'}
        onChange={(value) => void app.setAttachmentFoldersShown(value === 'show')}
        options={[
          { value: 'show', label: copy.systemFolderValues.show },
          { value: 'hide', label: copy.systemFolderValues.hide },
        ]}
      />
      <p className="za-muted">{copy.systemFoldersHint}</p>

      <Button
        variant="secondary"
        onClick={() => void app.vaultRef?.orphanAttachments().then((list) => setOrphans(list.length))}
      >
        {copy.findOrphans}
      </Button>
      {orphans !== null ? (
        <p className="za-muted">{strings.settings.storage.orphansFound(orphans)}</p>
      ) : null}
    </>
  );
}

/**
 * Настройки редактора.
 *
 * Все три тумблера держали состояние в `useState` и не доходили ни до
 * настроек, ни до редактора: щелчок двигал переключатель и не делал больше
 * ничего (ITERATION-1 §3). Теперь они живут в предпочтениях редактора рядом с
 * кеглем и шириной колонки — там же, где переживают перезапуск, и оттуда же
 * попадают в CodeMirror мгновенно, без «Применить».
 *
 * Четвёртый тумблер, «Показывать разметку по умолчанию», убран. В списке §3
 * его нет, а §8 отдаёт разметку режиму редактора: в простом её не видно
 * никогда, в профессиональном она проявляется у курсора. Отдельная настройка
 * поверх режима означала бы два переключателя об одном и том же.
 */
function EditorSection(): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const theme = useTheme();
  const copy = strings.settings.editor;

  return (
    <>
      {/* Режим редактора (ITERATION-1 §8). Первым в разделе: он определяет,
          что человек вообще видит в тексте, а остальные настройки — детали
          поверх этого выбора. */}
      <Section>{copy.mode}</Section>
      <SegmentedControl<'simple' | 'pro'>
        label={copy.mode}
        value={theme.editor.mode}
        onChange={(value) => theme.setEditor({ mode: value })}
        options={[
          { value: 'simple', label: copy.modeValues.simple },
          { value: 'pro', label: copy.modeValues.pro },
        ]}
      />
      <p className="za-muted">{copy.modeHint}</p>

      {/*
        Оформление списков (замечание 10 из отзыва). Маркер меняет ТЕКСТ файла —
        все три символа канонический markdown; цвет и сдвиг — только показ.
        Дефис первым: он единственный не спорит с курсивом при чтении сырого
        файла, где `*пункт*` читается как выделение.
      */}
      <Section>{copy.listMarker}</Section>
      <SegmentedControl<'-' | '*' | '+'>
        label={copy.listMarker}
        value={theme.editor.listMarker}
        onChange={(value) => theme.setEditor({ listMarker: value })}
        options={[
          { value: '-', label: '—' },
          { value: '*', label: '∗' },
          { value: '+', label: '+' },
        ]}
      />

      <Section>{copy.listMarkColor}</Section>
      <SegmentedControl<'muted' | 'text' | 'accent'>
        label={copy.listMarkColor}
        value={theme.editor.listMarkColor}
        onChange={(value) => theme.setEditor({ listMarkColor: value })}
        options={[
          { value: 'muted', label: copy.listMarkColors.muted },
          { value: 'text', label: copy.listMarkColors.text },
          { value: 'accent', label: copy.listMarkColors.accent },
        ]}
      />

      <Section>{copy.listIndent}</Section>
      <SegmentedControl<'none' | 'normal' | 'wide'>
        label={copy.listIndent}
        value={theme.editor.listIndent}
        onChange={(value) => theme.setEditor({ listIndent: value })}
        options={[
          { value: 'none', label: copy.listIndents.none },
          { value: 'normal', label: copy.listIndents.normal },
          { value: 'wide', label: copy.listIndents.wide },
        ]}
      />

      {/*
        Где стоит панель форматирования (§4).

        Умолчание — внизу по центру: там она не отнимает полосу у текста и не
        встаёт между хлебными крошками и названием заметки. «Плавающая» есть
        только там, где ею можно распорядиться — в оболочках Windows и Android;
        в браузере окно принадлежит вкладке, и плавающая панель поверх чужого
        хрома обещала бы больше, чем даёт. Отсутствующая возможность СКРЫТА, а
        не выключена (BEHAVIOR §5.1).
      */}
      <Section>{copy.panelPlacement}</Section>
      <SegmentedControl<PanelPlacement>
        label={copy.panelPlacement}
        value={theme.editor.panelPlacement}
        onChange={(value) => theme.setEditor({ panelPlacement: value })}
        options={[
          { value: 'bottom', label: copy.panelPlacements.bottom },
          { value: 'top', label: copy.panelPlacements.top },
          ...(app.host.platform.kind === 'web'
            ? []
            : [{ value: 'floating' as const, label: copy.panelPlacements.floating }]),
        ]}
      />
      {app.host.platform.kind === 'web' ? null : (
        <p className="za-muted">{copy.panelPlacementHint}</p>
      )}

      {/* Typewriter-скролл — опция, по умолчанию выключена (BEHAVIOR §2.8). */}
      <div className="za-field-row">
        <Switch
          label={copy.typewriter}
          checked={theme.editor.typewriter}
          onChange={(event) => theme.setEditor({ typewriter: event.target.checked })}
        />
      </div>
      {/* «Переносить выполненные вниз» — выключено по умолчанию (BEHAVIOR §2.3). */}
      <div className="za-field-row">
        <Switch
          label={copy.moveDone}
          checked={theme.editor.moveDone}
          onChange={(event) => theme.setEditor({ moveDone: event.target.checked })}
        />
      </div>
      <div className="za-field-row">
        <Switch
          label={copy.spellcheck}
          checked={theme.editor.spellcheck}
          onChange={(event) => theme.setEditor({ spellcheck: event.target.checked })}
        />
      </div>
    </>
  );
}

/** Синхронизация — SCREENS §8 (`1t`) и BEHAVIOR §6. */
function SyncSection(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const copy = strings.settings.sync;
  const copyAccount = strings.settings.account;
  /**
   * Что показывать выбранным: решение человека, а не итог подключения.
   *
   * Подключиться может не выйти — сессия истекла, сервер не ответил, папка
   * недоступна. Ни один из этих случаев не отменяет выбора, и подсвечивать
   * в такую минуту «Только на этом устройстве» — значит сообщать человеку
   * неправду о его же настройках.
   */
  const choiceOrBackend = state.backendId ?? state.backendChoice;
  const [webdav, setWebdav] = useState({ url: '', user: '', password: '' });
  const [yandexToken, setYandexToken] = useState('');
  /* Какой режим человек раскрыл, чтобы ввести данные. Раскрытый — ещё не
     выбранный: выбор случается по кнопке «Подключить», когда есть что
     подключать. */
  const [openMode, setOpenMode] = useState<SyncBackend['id'] | null>(null);

  /**
   * Заметки-копии, которые синк оставил при расхождении версий.
   *
   * Признак — суффикс из реестра (`notes.conflictSuffix`), тот же, которым
   * копию называет `SyncEngine`. Берём его из строк, а не из литерала: иначе
   * при смене формулировки счётчик тихо станет нулевым и никто не заметит.
   *
   * Сверяем ПУТЬ, а не заголовок: заголовок берётся из первой строки текста и
   * суффикса не содержит — у копии он тот же, что у оригинала.
   */
  const conflictMark = strings.notes.conflictSuffix('').replace(/\s*\)?$/, '');
  const conflicted = state.notes.filter((note) => note.path.includes(conflictMark));

  const screenState = app.screenState('settingsSync', false);
  /*
   * Что здесь написано — то и есть правда о синхронизации.
   *
   * Случаев четыре, и раньше различались два: «оффлайн» и «ошибка». Всё
   * остальное объявлялось «Синхронизировано», включая главный случай — места
   * нет вовсе. Заказчик именно в этом состоянии и оказался: вход в облако
   * истёк за ночь, синхронизации не было ни одной, а экран сообщал, что всё
   * синхронизировано.
   *
   * Порядок проверок — от самого сильного утверждения к самому слабому: сеть,
   * отказ, отсутствие места, накопленное, и только потом «синхронизировано».
   */
  const pending = state.sync.pending ?? 0;
  const connected = state.backendId !== null;
  const status =
    screenState === 'offline'
      ? strings.syncState.offline
      : screenState === 'error'
        ? strings.syncState.error
        : !connected
          ? copy.statusLocalOnly
          : pending > 0
            ? copy.statusPending(pending)
            : copy.statusSynced;
  /* Точка рядом со строкой: серая, пока обмена нет, — «оффлайн» здесь значит
     «не синхронизируется», и это ровно то, что происходит. */
  const dot = screenState === 'offline' || !connected ? 'offline' : state.sync.state;

  const connect = (id: SyncBackend['id']): void => {
    const vault = app.vaultRef;
    if (!vault) return;
    if (id === 'local') {
      /* Вторая папка на устройстве (флешка, папка облачного клиента). */
      void app.host.platform.pickVaultDirectory().then((storage) => {
        if (storage) {
          void app.switchBackend(new LocalFolderBackend(storage, { title: copy.localFolder }));
        }
      });
      return;
    }
    if (id === 'webdav') {
      void app.switchBackend(
        new WebDAVBackend({ baseUrl: webdav.url, username: webdav.user, password: webdav.password }),
      );
      return;
    }
    if (id === 'zapiski') {
      /* Облако Записок: вошли — подключаем, не вошли — отправляем входить и
         возвращаемся сюда же (ТЗ §5.5, аккаунт нужен только для облака). */
      void app.connectCloud().then((connected) => {
        if (!connected) app.beginSignIn({ name: 'settings', section: 'sync' });
      });
      return;
    }
    if (id === 'yandex') {
      /* Токен Диска — отдельное разрешение, вход в аккаунт его не даёт
         (наш OAuth просит только `login:*`, см. server/services/yandex.ts). */
      void app.connectYandexDisk(yandexToken);
      return;
    }
    /* Неизвестный режим хранилища. Раньше это вело на экран тарифов; пока
       он спрятан, молчим — открывать спрятанное «на всякий случай» нельзя. */
    if (BILLING_ENABLED) app.navigate({ name: 'paywall' });
  };

  return (
    <>
      <div className="za-row-between">
        <span className="za-row-between" style={{ gap: 8 }}>
          <SyncDot status={dot} label={status} />
          <span>{status}</span>
        </span>
        <span className="za-tertiary-mono">
          {copy.statusLine(
            state.sync.lastSyncAt ? clockTime(state.sync.lastSyncAt) : strings.sync.never,
            state.sync.noteCount,
            /* Размер известен только по прошлым обменам: пока их не было,
               про объём молчим, а не пишем «0 Б» над полной папкой. */
            state.sync.bytes > 0 ? formatBytes(state.sync.bytes, strings) : null,
          )}
        </span>
      </div>

      {/* Ошибка — текст из реестра §11 и «Повторить». Модалок нет. */}
      {screenState === 'error' && state.syncError ? (
        <div className="za-row-between">
          <span className="za-muted">{state.syncError}</span>
          <Button variant="text" size="compact" onClick={() => void app.syncNow()}>
            {strings.actions.retry}
          </Button>
        </div>
      ) : null}

      <Button variant="secondary" onClick={() => void app.syncNow()}>
        {copy.syncNow}
      </Button>

      {/*
        ОДНА развилка вместо двух разделов.

        Заказчик: «отдельные настройки синхронизации (WebDav и Облако) и
        отдельно есть пункт про Хранилище. Такое разнесение фрустрирует, так
        как непонятно, могу я хранить всё в папке и одновременно в
        WebDav/Облаке. По факту, это должны быть взаимоисключающие вещи, но с
        бережностью при переключении».

        Взаимоисключающими они и были: движок синхронизации ровно один, и
        подключение нового заменяет прежний. Но два независимых раздела
        обещали обратное — что можно набрать себе и то, и другое. Теперь это
        один список с отметкой «сейчас», а поля появляются только у
        выбранного режима: четыре одновременно открытые формы и создавали
        ощущение, что всё это складывается.

        Бережность — в `switchBackend`: перед уходом с хранилища досылается
        то, что не успело уйти (автосинк идёт с задержкой 5 с).
      */}
      <Section>{copy.backends}</Section>
      <p className="za-muted">{copy.whereHint}</p>

      {/*
        Отмечено то, что ВЫБРАЛ человек, даже если подключиться сейчас не
        вышло. Иначе экран выглядит так, будто приложение само сменило место
        хранения, — ровно это заказчик и увидел утром после того, как вечером
        подключил облако.
      */}
      {state.cloudNeedsSignIn ? (
        <InfoNote icon={<IconInfo size={15} />}>
          <span className="za-row-between">
            {strings.errors.cloudSignInAgain}
            <Button
              variant="text"
              size="compact"
              onClick={() => app.beginSignIn({ name: 'settings', section: 'sync' })}
            >
              {copyAccount.signIn}
            </Button>
          </span>
        </InfoNote>
      ) : null}

      <ModeCard
        id={null}
        title={copy.modeLocalOnly}
        hint={copy.modeLocalOnlyHint}
        current={choiceOrBackend}
        onChoose={() => void app.switchBackend(null)}
      />

      {/* Копия в другой папке есть там, где платформа умеет её выбрать. */}
      <ModeCard
        id="local"
        title={copy.modeCopy}
        hint={copy.modeCopyHint}
        current={choiceOrBackend}
        onChoose={() => connect('local')}
      />

      <ModeCard
        id="yandex"
        title={copy.yandex}
        current={choiceOrBackend}
        onChoose={() => setOpenMode('yandex')}
        open={openMode === 'yandex'}
      >
        <TextField
          type="password"
          mono
          label={copy.yandexToken}
          value={yandexToken}
          onChange={(event) => setYandexToken(event.target.value)}
        />
        <p className="za-muted">{copy.yandexHint}</p>
        <Button
          variant="secondary"
          disabled={yandexToken.trim() === ''}
          onClick={() => connect('yandex')}
        >
          {copy.connect}
        </Button>
      </ModeCard>

      <ModeCard
        id="webdav"
        title={copy.webdavCard}
        hint={copy.webdavHint}
        current={choiceOrBackend}
        onChoose={() => setOpenMode('webdav')}
        open={openMode === 'webdav'}
      >
        <TextField
          mono
          label={copy.webdavUrl}
          value={webdav.url}
          onChange={(event) => setWebdav({ ...webdav, url: event.target.value })}
        />
        <TextField
          label={copy.webdavUser}
          value={webdav.user}
          onChange={(event) => setWebdav({ ...webdav, user: event.target.value })}
        />
        <TextField
          type="password"
          label={copy.webdavPassword}
          value={webdav.password}
          onChange={(event) => setWebdav({ ...webdav, password: event.target.value })}
        />
        <Button variant="secondary" disabled={webdav.url === ''} onClick={() => connect('webdav')}>
          {copy.connect}
        </Button>
      </ModeCard>

      <ModeCard
        id="zapiski"
        title={copy.cloud}
        badge={copy.cloudBadge}
        current={choiceOrBackend}
        onChoose={() => connect('zapiski')}
      />

      {/* Где лежит сама папка — часть того же вопроса, а не отдельный раздел. */}
      <VaultLocationChoice />
      <StorageHousekeeping />

      {/*
        Конфликты (SCREENS §8). Экрана «выберите файл» не существует — ссылка
        ведёт прямо в историю версий той заметки, где конфликт и случился.

        Счётчик был литеральным нулём, а кнопка — пустым обработчиком: плашка
        стояла всегда и не значила ничего. Теперь считаются настоящие копии,
        которые синк оставляет рядом с заметкой при расхождении, и без них
        плашки нет вовсе: сообщение «конфликтов: 0» занимает место и не несёт
        сведений.
      */}
      {conflicted.length > 0 ? (
        <InfoNote icon={<IconMerge size={15} />}>
          <span className="za-row-between">
            {copy.conflictsMonth(conflicted.length)}
            <Button
              variant="text"
              size="compact"
              /* ПУТЬ, а не идентификатор: `VersionsScreen` объявляет
                 `noteId: VaultPath` и зовёт `vault.read(noteId)`. С `.id`
                 ссылка вела на пустой экран — заметка по такому «пути» не
                 читается. Рядом, в `InfoPanel.tsx`, сделано верно. */
              onClick={() => app.navigate({ name: 'versions', noteId: conflicted[0]!.path })}
            >
              {copy.historyLink}
            </Button>
          </span>
        </InfoNote>
      ) : null}
    </>
  );
}

/**
 * «Безопасность».
 *
 * Два тумблера здесь были мёртвыми: «Шифровать новые заметки» и
 * «Разблокировать биометрией» держали своё состояние в `useState` и не
 * доходили ни до настроек, ни до keystore. Тумблер, который переключается и
 * ничего не делает, врёт дважды — обещает поведение и заставляет думать, что
 * оно уже включено. Оба ожили вместе с иерархией ключей: без общего пароля
 * хранилища ни тому, ни другому не на чем было работать (ТЗ §3.3).
 */
function SecuritySection(): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const copy = strings.settings.security;
  const [encryptDefault, setEncryptDefault] = useState(app.getEncryptNewNotes());
  const [secureScreen, setSecureScreen] = useState(true);
  const [autoLock, setAutoLock] = useState<number | null>(app.getAutoLockMinutes());
  const biometrics = app.host.platform.biometrics;
  const [biometricsOn, setBiometricsOn] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  /* Включение биометрии требует пароля: в keystore уезжает ключевой материал,
     а вывести его без пароля неоткуда. */
  const [biometricsPassword, setBiometricsPassword] = useState('');
  const [biometricsError, setBiometricsError] = useState<string | null>(null);
  const [changeOpen, setChangeOpen] = useState(false);

  useEffect(() => {
    app.setAutoLockMinutes(autoLock);
  }, [app, autoLock]);

  useEffect(() => {
    void app.hasVaultPassword().then(setHasPassword);
    void app.biometricsEnabled().then(setBiometricsOn);
  }, [app]);

  return (
    <>
      <div className="za-field-row">
        <Switch
          label={copy.encryptDefault}
          checked={encryptDefault}
          disabled={!hasPassword}
          onChange={(event) => {
            setEncryptDefault(event.target.checked);
            void app.setEncryptNewNotes(event.target.checked);
          }}
        />
      </div>
      <p className="za-muted za-hint">
        {hasPassword ? copy.encryptDefaultHint : copy.encryptDefaultNoPassword}
      </p>

      {/*
        Биометрии нет на платформе — тумблера тоже нет (BEHAVIOR §5.1).

        Порядок здесь важнее вида: поле пароля стоит ВЫШЕ тумблера. Прежде оно
        было ниже, и естественный жест — сначала переключить — приводил к
        `setBiometricsEnabled(true, '')`: ключ выводился из пустой строки и
        уезжал в Keystore. Тумблер вставал в «включено», а палец не открывал
        ничего. Теперь пароль спрашивается первым, тумблер до его ввода
        выключен и объясняет, чего ждёт, а неверный пароль получает ответ
        словами, а не молчаливым откатом.
      */}
      {biometrics && hasPassword && !biometricsOn ? (
        <TextField
          type="password"
          label={copy.biometricsPassword}
          value={biometricsPassword}
          autoComplete="current-password"
          error={biometricsError ?? undefined}
          showError={biometricsError !== null}
          hint={copy.biometricsPasswordHint}
          onChange={(event) => {
            setBiometricsPassword(event.target.value);
            setBiometricsError(null);
          }}
        />
      ) : null}
      {biometrics && hasPassword ? (
        <div className="za-field-row">
          <Switch
            label={copy.biometrics}
            checked={biometricsOn}
            disabled={!biometricsOn && biometricsPassword.length === 0}
            onChange={(event) => {
              const on = event.target.checked;
              setBiometricsError(null);
              if (!on) {
                setBiometricsOn(false);
                void app.setBiometricsEnabled(false);
                return;
              }
              void app.setBiometricsEnabled(true, biometricsPassword).then((outcome) => {
                setBiometricsOn(outcome === 'on');
                if (outcome === 'on') {
                  setBiometricsPassword('');
                  return;
                }
                /* Каждый отказ называется своим именем: «не подошёл»,
                   «проверить нечем» и «система отказала» — три разные новости
                   и три разных следующих шага. */
                setBiometricsError(
                  outcome === 'wrong'
                    ? strings.errors.wrongPassword
                    : outcome === 'unknown'
                      ? copy.biometricsUnverifiable
                      : copy.biometricsFailed,
                );
              });
            }}
          />
        </div>
      ) : null}

      <div className="za-field-row">
        <Switch
          label={copy.secureScreen}
          checked={secureScreen}
          onChange={(event) => {
            setSecureScreen(event.target.checked);
            app.host.platform.secureFlag(event.target.checked);
          }}
        />
      </div>

      {hasPassword ? (
        <>
          <Button variant="secondary" onClick={() => setChangeOpen(true)}>
            {copy.changePassword}
          </Button>
          <ChangePasswordDialog open={changeOpen} onClose={() => setChangeOpen(false)} />
        </>
      ) : null}

      <Section>{strings.crypto.autoLockLabel}</Section>
      <SegmentedControl<string>
        label={strings.crypto.autoLockLabel}
        value={autoLock === null ? 'never' : String(autoLock)}
        onChange={(value) => setAutoLock(value === 'never' ? null : Number(value))}
        options={[
          { value: '1', label: strings.crypto.autoLockValues[1] },
          { value: '5', label: strings.crypto.autoLockValues[5] },
          { value: '10', label: strings.crypto.autoLockValues[10] },
          { value: '30', label: strings.crypto.autoLockValues[30] },
          { value: 'never', label: strings.crypto.autoLockValues.never },
        ]}
      />
    </>
  );
}

function TransferSection(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const copy = strings.settings.transfer;
  const [busy, setBusy] = useState(false);

  /* Экспортируем ту заметку, что открыта; иначе — последнюю открытую. */
  const notePath = state.route.name === 'note' ? state.route.id : (state.lastOpened[0] ?? null);

  return (
    <>
      <Section>{copy.importTitle}</Section>
      <Button variant="secondary" onClick={() => app.navigate({ name: 'import' })}>
        {copy.importButton}
      </Button>
      <p className="za-muted">{strings.importer.neverOverwrites}</p>

      <Section>{copy.exportTitle}</Section>
      {notePath !== null ? (
        <div className="za-field-row">
          {(['md', 'html', 'docx', 'pdf'] as const).map((format) =>
            /* PDF печатает платформа. Порта нет — пункта тоже нет, не «серый». */
            format === 'pdf' && !app.host.pdf ? null : (
              <Button
                key={format}
                variant="secondary"
                size="compact"
                disabled={busy}
                onClick={() => void run(() => app.exportNoteAs(notePath, format))}
              >
                {copy.formats[format]}
              </Button>
            ),
          )}
        </div>
      ) : null}

      <Button variant="secondary" loading={busy} onClick={() => void run(() => app.exportAll())}>
        {copy.exportAll}
      </Button>
    </>
  );

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }
}

function StorageHousekeeping(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const copy = strings.settings.storage;
  const [orphans, setOrphans] = useState<number | null>(null);

  return (
    <>
      {/* Сама папка и уборка в ней — продолжение того же вопроса «где живут
          заметки», поэтому и раздел общий, а не соседний пункт навигации. */}
      <Section>{copy.pathLabel}</Section>
      <div className="za-info__row">
        <span>{copy.filesLabel}</span>
        <span className="za-info__value">{state.notes.length}</span>
      </div>
      <div className="za-info__row">
        <span>{copy.sizeLabel}</span>
        <span className="za-info__value">{formatBytes(state.sync.bytes, strings)}</span>
      </div>

      <Button
        variant="secondary"
        onClick={() => {
          /* Та же немота, что была в онбординге: папку выбрали, открыть не
             вышло — и человек не узнавал об этом ничего. Заметки при этом
             остаются там, где лежали: сменить папку не удалось, но старая
             никуда не делась. */
          void (async () => {
            const storage = await app.host.platform.pickVaultDirectory().catch(() => null);
            if (!storage) return;
            try {
              await app.openVault(storage);
            } catch {
              app.toast({ message: strings.errors.folderUnavailable });
            }
          })();
        }}
      >
        {copy.changeFolder}
      </Button>
      <p className="za-muted">{copy.changeFolderHint}</p>

      <Button
        variant="secondary"
        onClick={() => {
          void app.vaultRef?.orphanAttachments().then((list) => setOrphans(list.length));
        }}
      >
        {copy.findOrphans}
      </Button>
      {orphans !== null ? <p className="za-muted">{copy.orphansFound(orphans)}</p> : null}

      {/* Перестроить индекс безопасно: индекс — производная (ARCHITECTURE §3.1). */}
      <Button variant="secondary" onClick={() => void app.vaultRef?.rebuild().then(() => app.refresh())}>
        {copy.rebuild}
      </Button>
      <p className="za-muted">{copy.rebuildHint}</p>
    </>
  );
}

/**
 * Один режим хранения в общем списке.
 *
 * Режимы взаимоисключающие, поэтому и выглядят как выбор из списка, а не как
 * набор независимых карточек с кнопками «Подключить» у каждой. Отметка
 * «сейчас» стоит ровно у одного.
 *
 * Режим с полями (WebDAV, Яндекс.Диск) сперва раскрывается, и только кнопка
 * внутри него переключает: подключить хранилище, не зная адреса и пароля,
 * всё равно нельзя, а четыре одновременно открытые формы и создавали то самое
 * ощущение, что всё это складывается друг с другом.
 */
function ModeCard({
  id,
  title,
  hint,
  badge,
  current,
  open = false,
  onChoose,
  children,
}: {
  id: SyncBackend['id'] | null;
  title: string;
  hint?: string;
  badge?: string;
  current: SyncBackend['id'] | null;
  open?: boolean;
  onChoose: () => void;
  children?: ReactNode;
}): ReactNode {
  const strings = useStrings();
  const copy = strings.settings.sync;
  const chosen = current === id;

  return (
    <div className={`za-card${chosen ? ' za-card--selected' : ''}`}>
      {/*
        Нажимается ВСЯ карточка, а не строка заголовка.

        Заказчик: «кнопка Облако Записок не нажимается». Кнопка работала —
        только занимала одну верхнюю строку, а описание под ней («E2E-шифрование,
        история версий…») к нажатию отношения не имело. На телефоне карточка
        высотой в треть экрана, и попасть мимо цели проще, чем в неё.
      */}
      <button
        type="button"
        className="za-card__choose"
        role="radio"
        aria-checked={chosen}
        onClick={onChoose}
      >
        <span className="za-row-between">
          <span className="za-card__title">{title}</span>
          {chosen ? <Badge tone="success">{copy.current}</Badge> : null}
          {!chosen && badge ? <Badge tone="warning">{badge}</Badge> : null}
        </span>
        {hint ? <span className="za-muted za-card__text">{hint}</span> : null}
      </button>
      {open && children ? (
        <div className="za-stack za-stack--tight" style={{ paddingBlockStart: 12 }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Выбор папки для заметок там, где он вообще существует (сейчас — Android).
 *
 * Экран показывается только если платформа объявила порт `vaultFolders`:
 * отсутствующая возможность **скрыта, а не выключена** (ARCHITECTURE §1,
 * ТЗ §8 D3). На вебе и Windows выбранная пользователем папка ничем не хуже
 * умолчания, и разделять их незачем — там работает «Сменить папку» выше.
 *
 * Почему предупреждение показывается ДО выбора, а не после. В папке
 * приложения запись атомарна: сбой питания не портит заметку. В папке,
 * которую отдаёт системный провайдер, атомарности нет — и человек имеет
 * право узнать цену до того, как заплатит, а не в тосте после. Взамен
 * названа и польза: такую папку синхронизирует, например, клиент
 * Яндекс.Диска — бесплатно и мимо нашего облака (ТЗ §4.1 п. 1).
 */
function VaultLocationChoice(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const copy = app.storageStrings;

  if (!app.canChooseVaultFolder) return null;

  const location = state.vaultLocation;
  const warning = app.vaultLocationWarning;
  const inAppFolder = location === null || location.kind === 'app';

  return (
    <>
      <div className="za-info__row">
        <span>{copy.title}</span>
        <span className="za-info__value">{location?.label ?? copy.appFolder}</span>
      </div>

      {/* Оговорка про выбранную папку — постоянно на виду, а не одним тостом. */}
      {warning !== null ? (
        <InfoNote icon={<IconInfo size={15} />}>
          <strong>{copy.warningTitle}</strong>
          <br />
          {warning}
        </InfoNote>
      ) : (
        <p className="za-muted">{copy.appFolderNote}</p>
      )}

      <p className="za-muted">{copy.why}</p>

      {inAppFolder ? (
        <Button variant="secondary" onClick={() => void app.chooseVaultFolder()}>
          {copy.chooseFolder}
        </Button>
      ) : (
        <>
          <Button variant="secondary" onClick={() => void app.chooseVaultFolder()}>
            {copy.chooseFolder}
          </Button>
          <Button variant="secondary" onClick={() => void app.useAppVaultFolder()}>
            {copy.useAppFolder}
          </Button>
        </>
      )}
    </>
  );
}

function AccountSection(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const copy = strings.settings.account;
  const [confirm, setConfirm] = useState(false);

  if (!state.account) {
    return (
      <>
        <InfoNote icon={<IconInfo size={15} />}>{copy.noAccount}</InfoNote>
        <Button onClick={() => app.beginSignIn({ name: 'settings', section: 'account' })}>
          {copy.signIn}
        </Button>
      </>
    );
  }

  return (
    <>
      <div className="za-info__row">
        <span>{strings.signIn.emailLabel}</span>
        <span className="za-info__value">{state.account.email}</span>
      </div>
      {/* Строка про тариф — только когда тарифы существуют. Иначе это ответ
          на вопрос, которого человек не задавал, и намёк на ограничение. */}
      {BILLING_ENABLED ? (
        <div className="za-info__row">
          <span>{copy.plan}</span>
          <span className="za-info__value">
            {state.account.plan === 'plus' ? copy.planPlus : copy.planFree}
          </span>
        </div>
      ) : null}
      {/*
        Отзыв рекламного согласия — здесь, и это не вежливость, а обязанность:
        согласие, которое нельзя снять, согласием не является. Тумблер
        показывает то, что записано на СЕРВЕРЕ (ответ ручки), а не то, что
        нажали: иначе неудачный запрос оставил бы человека в уверенности, что
        он отписался.
      */}
      <div className="za-field-row">
        <Switch
          label={strings.signIn.consentMarketing}
          checked={state.account.marketingOptIn === true}
          onChange={(event) => void app.setMarketingConsent(event.target.checked)}
        />
      </div>
      <p className="za-muted za-hint">{strings.signIn.consentMarketingHint}</p>

      <Button variant="secondary" onClick={() => setConfirm(true)}>
        {copy.signOut}
      </Button>

      {/* Отвязка аккаунта — одно из ТРЁХ разрешённых мест с диалогом. */}
      <ConfirmDialog
        reason="unlink-account"
        open={confirm}
        title={copy.signOut}
        question={copy.signOutQuestion}
        confirmLabel={copy.signOutConfirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void app.signOutCloud()}
      />
    </>
  );
}

/**
 * Смена пароля хранилища — единственное место, где он меняется (ТЗ §3.3).
 *
 * Отчёт после операции обязателен и не сводится к «готово»: ключ выводится из
 * пароля, поэтому смена перешифровывает заметки, и если часть не переписалась,
 * человек обязан узнать, какие именно, — они продолжают открываться прежним
 * паролем, и это не поломка, а половина сделанной работы.
 */
function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const copy = strings.settings.security;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Условия те же, что были, но теперь каждое умеет сказать о себе.
   *
   * Заказчик: «кнопка сменить пароль после ввода старого и 2 раза нового не
   * активируется». Так и было: правило «не меньше 8 символов» и «повтор
   * совпал» держали кнопку выключенной и не показывали ни слова — ни
   * подписи под полем, ни подсказки. Выключенная кнопка без объяснения
   * неотличима от сломанной, и это ровно то, что человек увидел.
   */
  const tooShort = next.length > 0 && next.length < MIN_PASSWORD;
  const mismatch = repeat.length > 0 && repeat !== next;
  const ready = current.length > 0 && next.length >= MIN_PASSWORD && next === repeat;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await app.changeVaultPassword(current, next);
    setBusy(false);
    if (!result.ok) {
      /* Текст — из реестра BEHAVIOR §11, а не свой: «Пароль не подошёл»
         человек уже видел на замке, и вторая формулировка того же означала бы
         две разные ошибки в его голове вместо одной. Отдельно — случай
         «проверить нечем»: это не «не подошёл», и путать их нельзя. */
      setError(result.reason === 'unknown' ? copy.changeUnverifiable : strings.errors.wrongPassword);
      return;
    }
    app.toast({ message: copy.changeDone(result.changed) });
    if (result.failed.length > 0) app.toast({ message: copy.changePartial(result.failed) });
    setCurrent('');
    setNext('');
    setRepeat('');
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={copy.changeTitle}
      closeLabel={strings.app.close}
      footer={
        <>
          <Button variant="text" onClick={onClose}>
            {strings.app.cancel}
          </Button>
          <Button disabled={!ready} loading={busy} onClick={() => void submit()}>
            {copy.changePassword}
          </Button>
        </>
      }
    >
      <div className="za-stack za-stack--tight">
        <TextField
          type="password"
          label={copy.currentPassword}
          value={current}
          autoComplete="current-password"
          error={error ?? undefined}
          onChange={(event) => setCurrent(event.target.value)}
        />
        <TextField
          type="password"
          label={copy.newPassword}
          value={next}
          autoComplete="new-password"
          hint={strings.crypto.tooShort}
          error={tooShort ? strings.crypto.tooShort : undefined}
          showError={tooShort}
          onChange={(event) => setNext(event.target.value)}
        />
        <TextField
          type="password"
          label={strings.crypto.passwordRepeat}
          value={repeat}
          autoComplete="new-password"
          error={mismatch ? strings.crypto.mismatch : undefined}
          showError={mismatch}
          onChange={(event) => setRepeat(event.target.value)}
        />
        <InfoNote icon={<IconInfo size={15} />}>{copy.changeNote}</InfoNote>
      </div>
    </Modal>
  );
}

function PlusSection(): ReactNode {
  const app = useApp();
  const strings = useStrings();
  return (
    <>
      <p className="za-muted">{strings.paywall.subtitle}</p>
      <Button onClick={() => app.navigate({ name: 'paywall' })}>{strings.paywall.trial}</Button>
    </>
  );
}

/**
 * «О приложении» — единственное место интерфейса, где по Р1 законно стоит имя
 * издателя: «ЗАПИСКИ» — продукт, «СИМПАС» — юрлицо в сторе, счетах и юр.
 * текстах. Раздел требует `1_Design.md` §3.2 (И6): «о приложении (с указанием
 * издателя СИМПАС и лицензий)».
 *
 * Версия приходит от оболочки, а не из package.json приложения: у веба,
 * установщика Windows и apk свои номера, и человек в письме поддержке назовёт
 * тот, что стоит у него.
 */
function AboutSection(): ReactNode {
  const app = useApp();
  const copy = useStrings().settings.about;

  return (
    <>
      <div className="za-info__row">
        <span>{copy.product}</span>
        <span className="za-info__value">{copy.productName}</span>
      </div>
      <div className="za-info__row">
        <span>{copy.publisher}</span>
        <span className="za-info__value">{copy.publisherName}</span>
      </div>
      <div className="za-info__row">
        <span>{copy.version}</span>
        {/* Моноширинным, как все технические значения: номер сборки читают
            и переписывают в письмо, а не просматривают. */}
        <span className="za-info__value za-info__value--mono">{app.host.platform.version}</span>
      </div>

      {/*
        Юридические документы — постоянный доступ из настроек.

        Требование пакета (§2 таблицы размещения): Политика ПДн обязана быть
        доступна не только в момент регистрации, но и всегда. Раз уж список
        есть, в нём и остальные три документа: соглашение, особые условия
        ЗАПИСОК и текст рекламного согласия — того самого, которое человек
        включает и выключает тумблером в разделе «Аккаунт».
      */}
      <Section>{copy.legal}</Section>
      <ul className="za-list-plain">
        {(
          [
            ['terms', copy.legalTerms],
            ['notes', copy.legalNotes],
            ['privacy', copy.legalPrivacy],
            ['marketing', copy.legalMarketing],
          ] as Array<[keyof typeof LEGAL_URLS, string]>
        ).map(([key, label]) => (
          <li key={key}>
            <Button
              variant="text"
              size="compact"
              onClick={() => void app.host.openExternal(LEGAL_URLS[key])}
            >
              {label}
            </Button>
          </li>
        ))}
      </ul>

      <p className="za-muted">{copy.licenses}</p>
      <ul className="za-list-plain">
        {copy.licenseItems.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <Button variant="text" size="compact" onClick={() => void app.host.openExternal(copy.siteUrl)}>
        {copy.site}
      </Button>
    </>
  );
}
