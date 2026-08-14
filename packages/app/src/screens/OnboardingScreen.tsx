/**
 * Онбординг — SCREENS §1 (`2a` → `2b` → `2c`).
 *
 * Метрика флоу: от запуска до курсора в тексте <60 секунд и НОЛЬ обязательных
 * полей ввода. Поэтому шаг 2 всегда имеет выбор «На этом устройстве», который
 * не требует ничего, а шаг 3 — это уже редактор: отдельного экрана «успех» нет.
 */
import { useState, type ReactNode } from 'react';
import { Badge, Button, IconLock, IconPen, IconRefresh, ServiceMark } from '@zapiski/ui';
import { useApp, useStrings } from '../state/context.js';

export interface OnboardingScreenProps {
  step: 1 | 2 | 3;
}

type StorageChoice = 'local' | 'own' | 'cloud';

export function OnboardingScreen({ step }: OnboardingScreenProps): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const [choice, setChoice] = useState<StorageChoice>('local');
  const [busy, setBusy] = useState(false);

  const bulletIcons = [<IconPen size={18} key="pen" />, <IconLock size={18} key="lock" />, <IconRefresh size={18} key="sync" />];

  if (step === 1) {
    return (
      <div className="za-screen">
        <div className="za-page za-stack">
          <Steps current={1} />
          {/* Брендовый экран онбординга — второе из четырёх мест терракоты
              (DS-ALIGNMENT §9). Дальше по флоу знака больше нет. */}
          <span className="za-brand za-brand--hero">
            {/* REBUILD §1.1: терракота допустима только как знак сервиса
                ≤24 px. Крупная заливка ею читается как ошибка или кнопка —
                глаз идёт к ней первой, хотя это декорация. */}
            <ServiceMark size={24} />
            <span className="za-wordmark">{strings.app.wordmark}</span>
          </span>
          <h1 className="za-h1">{strings.onboarding.step1.title}</h1>
          <p className="za-muted">{strings.onboarding.step1.subtitle}</p>

          <div className="za-stack">
            {strings.onboarding.step1.bullets.map((bullet, index) => (
              <div className="za-bullet" key={bullet.title}>
                <span className="za-bullet__tile">{bulletIcons[index]}</span>
                <span>
                  <span className="za-card__title">{bullet.title}</span>
                  <span className="za-card__text">{bullet.text}</span>
                </span>
              </div>
            ))}
          </div>

          <Button fullWidth onClick={() => app.navigate({ name: 'onboarding', step: 2 })}>
            {strings.onboarding.step1.start}
          </Button>
          <Button variant="text" onClick={() => app.navigate({ name: 'import' })}>
            {strings.onboarding.step1.importLink}
          </Button>
        </div>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="za-screen">
        <div className="za-page za-stack">
          <Steps current={2} />
          <h1 className="za-h1">{strings.onboarding.step2.title}</h1>

          {(['local', 'own', 'cloud'] as StorageChoice[]).map((option) => {
            const copy = strings.onboarding.step2.options[option];
            return (
              <button
                key={option}
                type="button"
                className={`za-card${choice === option ? ' za-card--selected' : ''}`}
                aria-pressed={choice === option}
                onClick={() => setChoice(option)}
              >
                <span className="za-row-between">
                  <span className="za-card__title">{copy.title}</span>
                  <Badge tone={option === 'cloud' ? 'warning' : 'success'}>{copy.badge}</Badge>
                </span>
                <span className="za-card__text">{copy.text}</span>
              </button>
            );
          })}

          <p className="za-muted">{strings.onboarding.step2.footnote}</p>
          {/* В браузере кнопка всегда «Дальше»: папку сайт не спрашивает, и
              обещать выбор папки, которого не будет, нельзя. */}
          <Button fullWidth loading={busy} onClick={() => void proceed()}>
            {choice === 'local' || app.host.platform.kind === 'web'
              ? strings.onboarding.step2.next
              : strings.onboarding.step2.pickFolder}
          </Button>
        </div>
      </div>
    );
  }

  /* Шаг 3 отрисовывается редактором: сюда попадаем только как в заглушку. */
  return (
    <div className="za-screen">
      <div className="za-page za-stack">
        <span className="za-chip za-chip--success">{strings.onboarding.step3.chip}</span>
        <p className="za-muted">{strings.onboarding.step3.placeholder}</p>
      </div>
    </div>
  );

  async function proceed(): Promise<void> {
    setBusy(true);
    try {
      /* Выбор папки — платформенный порт. Различаем два исхода, и это не
         формальность: раньше они сливались в один, и на Samsung Internet
         получалось так — тап по «Дальше», системный выбор папки,
         «Использовать эту папку», и снова тот же вопрос, без единого слова.

         `null` — человек закрыл диалог. Это его право: молча уходим в память,
         писать можно сразу (local-first).
         Исключение — платформа отказала. Тогда говорим текстом реестра §11 и
         всё равно пускаем внутрь: ошибка не должна блокировать ввод (C5). */
      let storage = null;
      let refused = false;
      /*
       * В браузере папки не спрашиваем ВООБЩЕ.
       *
       * Человек с Android открыл zapiski.cmpas.ru, выбрал «На этом
       * устройстве» — и получил системный выбор папки, а после выбора экран
       * замер на «Дальше» насовсем. Дважды неправильно. Во-первых, сайту
       * папка не нужна: его хранилище — хранилище браузера, и человек про
       * «выберите папку» не просил. Во-вторых, проверка выбранной папки на
       * запись идёт через провайдер Android, который умеет не ответить
       * никогда, — а спиннер в кнопке ждёт его вечно.
       *
       * Выбор папки в вебе остаётся, но там, где он и уместен: в настройках
       * хранилища, по явной просьбе, на десктопе. Первый экран обязан
       * заканчиваться заметкой, а не диалогом файловой системы.
       */
      const inBrowser = app.host.platform.kind === 'web';
      if (inBrowser) {
        storage = await app.host.restoreVault().catch(() => null);
        if (!storage) app.toast({ message: strings.errors.browserStorageUnavailable });
      }
      try {
        /* Сначала — настоящий системный выбор, если платформа его объявила.
           На Android это существенно: там `pickVaultDirectory` молча отдаёт
           каталог приложения, диалога человек не видит вовсе, и получается
           ровно то, на что жаловался заказчик, — «не выбирается папка, где
           хранить заметки». Системный выбор живёт в отдельном порте
           (`vaultFolders`), потому что на Android за него платят атомарностью
           записи, и об этой цене приложение говорит вслух.

           На Windows порта нет, а `pickVaultDirectory` и так открывает
           нативный диалог — там ветка ниже отрабатывает как прежде. */
        const picker = inBrowser ? null : app.host.platform.vaultFolders;
        if (picker) {
          const chosen = await picker.chooseFolder();
          storage = chosen?.storage ?? null;
        }
        /* Отмена — не отказ: человек вправе не выбирать, и тогда заметки
           ложатся в каталог приложения, надёжный путь с атомарной записью. */
        if (!inBrowser) storage ??= await app.host.platform.pickVaultDirectory();
      } catch {
        refused = true;
      }

      if (storage) {
        try {
          await app.openVault(storage);
        } catch {
          refused = true;
          storage = null;
        }
      }

      if (!storage) {
        if (refused) app.toast({ message: strings.errors.folderUnavailable });
        await app.openMemoryVault();
      }

      if (choice === 'cloud') {
        /* Вошли — и сразу к заметкам: экран входа не самоцель, а шаг к тому,
           ради чего входили (SCREENS §1, шаг 2). */
        app.beginSignIn({ name: 'list' });
        return;
      }
      if (choice === 'own') {
        app.navigate({ name: 'settings', section: 'sync' });
        return;
      }
      /* Шаг 3 = первая заметка с курсором в тексте, без экрана «успех»:
         чип «Локальный режим включён» рисует уже сам редактор. */
      app.startFirstNote();
      await app.createNote();
    } finally {
      setBusy(false);
    }
  }
}

/** Индикатор прогресса — три полоски 22×5 (SCREENS §1). */
function Steps({ current }: { current: 1 | 2 | 3 }): ReactNode {
  const strings = useStrings();
  return (
    <div className="za-progress-steps" role="img" aria-label={`${strings.onboarding.progressLabel} ${current}`}>
      {[1, 2, 3].map((index) => (
        <span
          key={index}
          className={`za-progress-steps__bar${index <= current ? ' za-progress-steps__bar--active' : ''}`}
        />
      ))}
    </div>
  );
}
