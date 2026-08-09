/**
 * Вход — SCREENS §2 (`2d`).
 *
 * Ровно два пути: Яндекс ID и magic-link по почте. SMS-путей нет и быть не
 * может (ARCHITECTURE §3, инвариант 6 — прямой запрет ТЗ §5.5).
 *
 * Ошибка сети здесь баннером не блокирует локальную работу: экран вообще
 * необязателен, вернуться к заметкам можно в любой момент.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button, IconArrowLeft, IconButton, IconCheck, InfoNote, TextField } from '@zapiski/ui';
import { useApp, useAppState, useStrings } from '../state/context.js';

type Stage = 'form' | 'sent' | 'expired';

/** Кнопка «Отправить снова» неактивна 60 с (SCREENS §2). */
const RESEND_COOLDOWN_S = 60;

export interface SignInScreenProps {
  /**
   * `expired` — оболочка увидела в адресе просроченную magic-ссылку.
   * Тон спокойный: текст из реестра §11 и кнопка «Прислать новую».
   */
  initialStage?: Stage;
}

export function SignInScreen({ initialStage = 'form' }: SignInScreenProps): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const [email, setEmail] = useState('');
  const [stage, setStage] = useState<Stage>(initialStage);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  /* Ссылка не сработала — экран переходит в «прислать новую». Модалки нет:
     ошибка входа не блокирует локальную работу (BEHAVIOR §0). */
  useEffect(() => {
    if (state.authError === strings.errors.magicLinkExpired) setStage('expired');
  }, [state.authError, strings]);

  const sendLink = async (): Promise<void> => {
    setBusy(true);
    const sent = await app.sendMagicLink(email);
    setBusy(false);
    if (!sent) return;
    setStage('sent');
    setCooldown(RESEND_COOLDOWN_S);
  };

  return (
    <div className="za-screen">
      <div className="za-header">
        <IconButton
          icon={<IconArrowLeft size={20} />}
          label={strings.app.back}
          tone="ghost"
          onClick={() => app.back()}
        />
      </div>

      <div className="za-page za-stack">
        <h1 className="za-h1">{strings.signIn.title}</h1>
        <p className="za-muted">{strings.signIn.subtitle}</p>

        {stage === 'sent' ? (
          <>
            <InfoNote tone="success" icon={<IconCheck size={15} />}>
              {strings.signIn.sentTitle(email)}
            </InfoNote>
            <p className="za-muted">{strings.errors.mailNotDelivered(email)}</p>
            <Button
              variant="secondary"
              disabled={cooldown > 0}
              onClick={() => void sendLink()}
            >
              {cooldown > 0 ? strings.signIn.resendIn(cooldown) : strings.signIn.resend}
            </Button>
          </>
        ) : stage === 'expired' ? (
          <>
            <p className="za-muted">{strings.errors.magicLinkExpired}</p>
            <Button variant="secondary" onClick={() => void sendLink()}>
              {strings.signIn.sendNew}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              fullWidth
              iconStart={
                <img
                  className="za-yandex-logo"
                  src="/assets/yandex-logo.png"
                  alt=""
                  width={20}
                  height={20}
                />
              }
              onClick={() => void app.startYandexSignIn()}
            >
              {strings.signIn.yandex}
            </Button>

            <div className="za-divider-text">{strings.signIn.divider}</div>

            <TextField
              type="email"
              mono
              label={strings.signIn.emailLabel}
              placeholder={strings.signIn.emailPlaceholder}
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button
              variant="secondary"
              fullWidth
              loading={busy || state.authBusy}
              disabled={!email.includes('@')}
              onClick={() => void sendLink()}
            >
              {strings.signIn.sendLink}
            </Button>

            <InfoNote tone="success" icon={<IconCheck size={15} />}>
              {strings.signIn.promise}
            </InfoNote>
            {state.authError !== null ? <p className="za-muted">{state.authError}</p> : null}
          </>
        )}

        <p className="za-tertiary-mono">{strings.signIn.privacy}</p>
      </div>
    </div>
  );
}
