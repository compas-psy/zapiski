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
import { LEGAL_URLS } from '@zapiski/core';
import {
  Button,
  IconArrowLeft,
  IconButton,
  IconCheck,
  InfoNote,
  TextField,
  YANDEX_ID_LOGO,
} from '@zapiski/ui';
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
  /**
   * Экран стоит воротами: в вебе без аккаунта дальше нельзя (решение
   * заказчика — иначе заметки на разных устройствах выглядят потерянными).
   *
   * В этом режиме нет кнопки «назад»: возвращаться некуда, а неработающая
   * стрелка хуже её отсутствия. Вместо неё — строка о том, ЗАЧЕМ аккаунт,
   * потому что вход без объяснения причины читается как сбор адресов.
   */
  gate?: boolean;
}

export function SignInScreen({ initialStage = 'form', gate = false }: SignInScreenProps): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const [email, setEmail] = useState('');
  const [stage, setStage] = useState<Stage>(initialStage);
  const [cooldown, setCooldown] = useState(0);
  /**
   * Единственная галочка на экране — рекламная, и она добровольная.
   *
   * Соглашение принимается действием (нажатием кнопки входа), поэтому галочки
   * у него нет вовсе. Политика не принимается никогда: это документ
   * информационный, и превращать его в флажок запрещено пакетом прямо
   * (CMPAS Legal Implementation §3.2, §3.3, §21).
   *
   * Рекламная снята изначально и ничего не держит: преднажатая галочка
   * согласием не является ни по закону, ни по совести (§3.1).
   */
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * Умеет ли сервер вход через Яндекс. `null` — ещё не спросили.
   *
   * Кнопка показывалась всегда и по нажатию уводила в системный браузер, где
   * без настроенного client_id лежал голый JSON `404 yandex_not_configured`.
   * Человек возвращался ни с чем и без единого слова о причине — ровно то, на
   * что жаловался пользователь.
   *
   * До ответа кнопка рисуется: сервер отвечает за миллисекунды, и мигание
   * кнопкой на каждом открытии экрана хуже, чем краткая её жизнь в редком
   * случае, когда Яндекс не настроен.
   */
  const [yandexReady, setYandexReady] = useState<boolean | null>(null);

  useEffect(() => {
    void app.yandexAvailable().then(setYandexReady);
  }, [app]);

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
    const sent = await app.sendMagicLink(email, { marketing });
    setBusy(false);
    if (!sent) return;
    setStage('sent');
    setCooldown(RESEND_COOLDOWN_S);
  };

  return (
    <div className="za-screen">
      <div className="za-header">
        {gate ? null : (
          <IconButton
            icon={<IconArrowLeft size={20} />}
            label={strings.app.back}
            tone="ghost"
            onClick={() => app.back()}
          />
        )}
      </div>

      <div className="za-page za-stack">
        <h1 className="za-h1">{gate ? strings.signIn.gateTitle : strings.signIn.title}</h1>
        <p className="za-muted">{gate ? strings.signIn.gateReason : strings.signIn.subtitle}</p>

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
            {/*
              Соглашение принимается ДЕЙСТВИЕМ — нажатием кнопки входа, — а не
              отдельной галочкой (CMPAS Legal Implementation §3.3, §5).

              Что здесь было и почему это неверно. Стояла одна обязательная
              галочка «принимаю пользовательское соглашение И политику
              обработки персональных данных». Так нельзя по двум причинам
              сразу: политика — документ информационный, её не принимают
              (§3.2), а сводить два документа в один флажок запрещено прямо
              (§21). Плюс галочка ради галочки — лишний шаг там, где хватает
              однозначного действия.

              Текст стоит ВЫШЕ кнопок и ссылки открываются до нажатия: человек
              обязан иметь возможность прочитать то, что принимает, заранее.
            */}
            <p className="za-muted za-hint">
              {strings.signIn.consentByAction}{' '}
              <a href={LEGAL_URLS.terms} target="_blank" rel="noreferrer">
                {strings.signIn.termsLink}
              </a>
              {' '}
              {strings.signIn.andNotesTerms}{' '}
              {/* Особые условия ЗАПИСОК — отдельный документ пакета
                  (ДОКУМЕНТ 5, §7.1): принимаются при первом подключении
                  сервиса тем же однозначным действием. */}
              <a href={LEGAL_URLS.notes} target="_blank" rel="noreferrer">
                {strings.signIn.notesTermsLink}
              </a>
              {'. '}
              {strings.signIn.privacyNotice}{' '}
              <a href={LEGAL_URLS.privacy} target="_blank" rel="noreferrer">
                {strings.signIn.privacyLink}
              </a>
              {'.'}
            </p>

            <label className="za-consent">
              <input
                type="checkbox"
                checked={marketing}
                onChange={(event) => setMarketing(event.target.checked)}
              />
              <span>{strings.signIn.consentMarketing}</span>
            </label>
            <p className="za-muted za-hint">{strings.signIn.consentMarketingHint}</p>

            {yandexReady !== false ? (
              <>
                <Button
                  variant="outline"
                  fullWidth
                  iconStart={
                    <img
                      className="za-yandex-logo"
                      src={YANDEX_ID_LOGO}
                      alt=""
                      width={20}
                      height={20}
                    />
                  }
                  onClick={() => void app.startYandexSignIn({ marketing })}
                >
                  {strings.signIn.yandex}
                </Button>

                <div className="za-divider-text">{strings.signIn.divider}</div>
              </>
            ) : null}

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

            {/*
              Подсказка, а не «успех».

              Стояла зелёной плашкой с галочкой — до того, как что-либо
              произошло. Заказчик прочитал её как тост о результате: «внизу
              зелёный тост, где упоминается смс, который мы не отправляем».
              Зелёное с галочкой обязано означать случившееся; обещание — это
              обычная строка под кнопкой.
            */}
            <p className="za-muted">{strings.signIn.promise}</p>
            {state.authError !== null ? <p className="za-muted">{state.authError}</p> : null}
          </>
        )}

        <p className="za-tertiary-mono">{strings.signIn.privacy}</p>
      </div>
    </div>
  );
}
