/**
 * Онбординг — SCREENS §1 (`2a` → `2b` → `2c`).
 *
 * Метрика флоу: от запуска до курсора в тексте <60 секунд и НОЛЬ обязательных
 * полей ввода. Поэтому шаг 2 всегда имеет выбор «На этом устройстве», который
 * не требует ничего, а шаг 3 — это уже редактор: отдельного экрана «успех» нет.
 */
import { useState, type ReactNode } from 'react';
import { Badge, Button, IconLock, IconPen, IconRefresh } from '@zapiski/ui';
import { useApp, useStrings } from '../state/context.js';

export interface OnboardingScreenProps {
  step: 1 | 2 | 3;
}

type StorageChoice = 'local' | 'own' | 'kompas';

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
          <span className="za-wordmark">{strings.app.wordmark}</span>
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

          {(['local', 'own', 'kompas'] as StorageChoice[]).map((option) => {
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
                  <Badge tone={option === 'kompas' ? 'warning' : 'success'}>{copy.badge}</Badge>
                </span>
                <span className="za-card__text">{copy.text}</span>
              </button>
            );
          })}

          <p className="za-muted">{strings.onboarding.step2.footnote}</p>
          <Button fullWidth loading={busy} onClick={() => void proceed()}>
            {choice === 'local' ? strings.onboarding.step2.next : strings.onboarding.step2.pickFolder}
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
      /* Выбор папки — платформенный порт. Отказ пользователя не тупик:
         остаётся хранилище в памяти, писать можно сразу (local-first). */
      const storage = await app.host.platform.pickVaultDirectory().catch(() => null);
      if (storage) await app.openVault(storage);
      else await app.openMemoryVault();

      if (choice === 'kompas') {
        app.navigate({ name: 'signin' });
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
