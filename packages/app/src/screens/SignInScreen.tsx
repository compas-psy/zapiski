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

/**
 * `recent` — сервер письма не отправлял: этому адресу оно ушло меньше минуты
 * назад. Отдельное состояние, потому что говорить надо разное: «проверьте
 * почту» и «письмо уже есть, но открывать его надо на другом устройстве».
 */
type Stage = 'form' | 'sent' | 'recent' | 'expired';

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
   * Какие способы входа умеет сервер. `null` — ещё не спросили.
   *
   * Спрашивается затем, чтобы не показывать кнопку, ведущую в тупик: без
   * ключей сервер отвечает 404, а человек к этому моменту уже в системном
   * браузере и видит голый JSON. Недоступность сети — не повод прятать
   * кнопку: за ней всё равно откроется браузер.
   */
  const [methods, setMethods] = useState<{ yandex: boolean; simpas: boolean } | null>(null);

  /**
   * Аварийная дверь почтового входа: без кнопки, но достижимая по адресу
   * `?door=email`.
   *
   * Просьба агента единого входа, и она обоснована его же опытом: «маршрут, до
   * которого человеку не добраться, аварийным путём не является». У ПРАКТИКИ
   * такая дверь уже пригодилась в день, когда сломался вход через Яндекс, —
   * кнопки на экране при этом не было.
   *
   * Раз СИМПАС становится единственной дверью, его недоступность = наша
   * недоступность для новых входов. Эта дверь — то, чем это лечится, пока
   * СИМПАС не поднимется.
   */
  const emailDoor =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('door') === 'email';

  /* Единый вход настроен и человек не пришёл за аварийной дверью — тогда на
     экране ровно одна кнопка. Решение учредителя: Яндекс и почта уходят. */
  const onlySimpas = methods?.simpas === true && !emailDoor;

  useEffect(() => {
    void app.loginMethods().then(setMethods);
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
    const result = await app.sendMagicLink(email, { marketing });
    setBusy(false);
    if (result === false) return;
    setStage(result);
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

        {stage === 'sent' || stage === 'recent' ? (
          <>
            <InfoNote
              tone={stage === 'sent' ? 'success' : 'info'}
              icon={<IconCheck size={15} />}
            >
              {stage === 'sent'
                ? strings.signIn.sentTitle(email)
                : strings.signIn.recentTitle(email)}
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

            {onlySimpas ? (
              <Button
                variant="primary"
                fullWidth
                onClick={() => void app.startSimpasSignIn({ marketing })}
              >
                {strings.signIn.simpas}
              </Button>
            ) : (
              <>
                {methods?.yandex !== false ? (
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
              </>
            )}

            <p className="za-muted">{strings.signIn.promise}</p>
            {state.authError !== null ? <p className="za-muted">{state.authError}</p> : null}
          </>
        )}

        <p className="za-tertiary-mono">{strings.signIn.privacy}</p>
      </div>
    </div>
  );
}
