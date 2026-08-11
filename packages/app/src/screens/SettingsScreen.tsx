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
  SegmentedControl,
  Switch,
  SyncDot,
  TextField,
  THEME_PREFERENCES,
  useTheme,
  type Accent,
  type EditorColumnWidth,
  type ThemePreference,
} from '@zapiski/ui';
import { LocalFolderBackend, WebDAVBackend, type SyncBackend } from '@zapiski/core';
import type { SettingsSection } from '../contract.js';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { Section } from '../components/ScreenStates.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { IconBug, IconMerge } from '../components/icons.js';
import { clockTime, formatBytes } from '../lib/format.js';

const SECTIONS: SettingsSection[] = [
  'appearance',
  'editor',
  'sync',
  'security',
  'transfer',
  'storage',
  'account',
  'plus',
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
            {section === 'sync' ? <SyncSection /> : null}
            {section === 'security' ? <SecuritySection /> : null}
            {section === 'transfer' ? <TransferSection /> : null}
            {section === 'storage' ? <StorageSection /> : null}
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

      <Button variant="text" iconStart={<IconBug size={16} />} onClick={() => app.toggleDebug(true)}>
        {strings.settings.debugMenu}
      </Button>
    </>
  );
}

function EditorSection(): ReactNode {
  const strings = useStrings();
  const [typewriter, setTypewriter] = useState(false);
  const [moveDone, setMoveDone] = useState(false);
  const [rawDefault, setRawDefault] = useState(false);
  const copy = strings.settings.editor;

  return (
    <>
      {/* Typewriter-скролл — опция, по умолчанию выключена (BEHAVIOR §2.8). */}
      <div className="za-field-row">
        <Switch
          label={copy.typewriter}
          checked={typewriter}
          onChange={(event) => setTypewriter(event.target.checked)}
        />
      </div>
      {/* «Переносить выполненные вниз» — выключено по умолчанию (BEHAVIOR §2.3). */}
      <div className="za-field-row">
        <Switch
          label={copy.moveDone}
          checked={moveDone}
          onChange={(event) => setMoveDone(event.target.checked)}
        />
      </div>
      <div className="za-field-row">
        <Switch
          label={copy.rawByDefault}
          checked={rawDefault}
          onChange={(event) => setRawDefault(event.target.checked)}
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
  const [webdav, setWebdav] = useState({ url: '', user: '', password: '' });
  const [yandexToken, setYandexToken] = useState('');

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
  const status =
    screenState === 'offline'
      ? strings.syncState.offline
      : screenState === 'error'
        ? strings.syncState.error
        : copy.statusSynced;

  const connect = (id: SyncBackend['id']): void => {
    const vault = app.vaultRef;
    if (!vault) return;
    if (id === 'local') {
      /* Вторая папка на устройстве (флешка, папка облачного клиента). */
      void app.host.platform.pickVaultDirectory().then((storage) => {
        if (storage) app.attachBackend(new LocalFolderBackend(storage, { title: copy.localFolder }));
      });
      return;
    }
    if (id === 'webdav') {
      app.attachBackend(
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
    app.navigate({ name: 'paywall' });
  };

  return (
    <>
      <div className="za-row-between">
        <span className="za-row-between" style={{ gap: 8 }}>
          <SyncDot status={screenState === 'offline' ? 'offline' : state.sync.state} label={status} />
          <span>{status}</span>
        </span>
        <span className="za-tertiary-mono">
          {copy.statusLine(
            state.sync.lastSyncAt ? clockTime(state.sync.lastSyncAt) : strings.sync.never,
            state.sync.noteCount,
            formatBytes(state.sync.bytes, strings),
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

      <Section>{copy.backends}</Section>

      <div className={`za-card${state.backendId === 'local' ? ' za-card--selected' : ''}`}>
        <span className="za-row-between">
          <span className="za-card__title">{copy.localFolder}</span>
          {state.backendId === 'local' ? <Badge tone="success">{copy.connected}</Badge> : null}
        </span>
        <Button variant="text" size="compact" onClick={() => connect('local')}>
          {copy.connect}
        </Button>
      </div>

      <div className={`za-card${state.backendId === 'yandex' ? ' za-card--selected' : ''}`}>
        <span className="za-row-between">
          <span className="za-card__title">{copy.yandex}</span>
          {state.backendId === 'yandex' ? <Badge tone="success">{copy.connected}</Badge> : null}
        </span>
        <div className="za-stack za-stack--tight" style={{ paddingBlockStart: 12 }}>
          <TextField
            type="password"
            mono
            label={copy.yandexToken}
            value={yandexToken}
            onChange={(event) => setYandexToken(event.target.value)}
          />
          <p className="za-muted">{copy.yandexHint}</p>
          <Button
            variant="text"
            size="compact"
            disabled={yandexToken.trim() === ''}
            onClick={() => connect('yandex')}
          >
            {copy.connect}
          </Button>
        </div>
      </div>

      <div className="za-card za-card--dashed za-card--static">
        <span className="za-card__title">{copy.webdavCard}</span>
        <div className="za-stack za-stack--tight" style={{ paddingBlockStart: 12 }}>
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
        </div>
      </div>

      <div className="za-card za-card--static">
        <span className="za-row-between">
          <span className="za-card__title">{copy.cloud}</span>
          <Badge tone="warning">{copy.cloudBadge}</Badge>
        </span>
        <Button variant="text" size="compact" onClick={() => connect('zapiski')}>
          {copy.connect}
        </Button>
      </div>

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

function SecuritySection(): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const copy = strings.settings.security;
  const [encryptDefault, setEncryptDefault] = useState(false);
  const [secureScreen, setSecureScreen] = useState(true);
  const [autoLock, setAutoLock] = useState<number | null>(app.getAutoLockMinutes());
  const biometrics = app.host.platform.biometrics;
  const [biometricsOn, setBiometricsOn] = useState(false);

  useEffect(() => {
    app.setAutoLockMinutes(autoLock);
  }, [app, autoLock]);

  return (
    <>
      <div className="za-field-row">
        <Switch
          label={copy.encryptDefault}
          checked={encryptDefault}
          onChange={(event) => setEncryptDefault(event.target.checked)}
        />
      </div>

      {/* Биометрии нет на платформе — тумблера тоже нет (BEHAVIOR §5.1). */}
      {biometrics ? (
        <div className="za-field-row">
          <Switch
            label={copy.biometrics}
            checked={biometricsOn}
            onChange={(event) => setBiometricsOn(event.target.checked)}
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

function StorageSection(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const copy = strings.settings.storage;
  const [orphans, setOrphans] = useState<number | null>(null);

  return (
    <>
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

      <VaultLocationChoice />

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
      <div className="za-info__row">
        <span>{copy.plan}</span>
        <span className="za-info__value">
          {state.account.plan === 'plus' ? copy.planPlus : copy.planFree}
        </span>
      </div>
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
