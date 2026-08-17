/**
 * Форма обращения из беты.
 *
 * ── Что здесь решено и почему ───────────────────────────────────────────────
 *
 * **Тип обращения — список, а не сегменты.** Четыре подписи в один ряд не
 * помещаются на телефоне: этим уже болели настройки, и разбирать заново тот же
 * дефект незачем. Список даёт каждому варианту строку, а строке — пояснение,
 * без которого «Другое» и «Неудобно» неразличимы.
 *
 * **Блок «Что будет отправлено» раскрыт по умолчанию.** Свёрнутый он выглядит
 * как мелкий шрифт под кнопкой: формально сказали, фактически спрятали. Для
 * продукта, который обещает «ни байта из ваших заметок», это неприемлемо.
 * Рядом с каждым пунктом стоит ЗНАЧЕНИЕ, а не только название: «Заметок —
 * от 100 до 500» отвечает на вопрос, а «Количество заметок» только называет
 * его.
 *
 * **Снимок экрана отделён от остальных пунктов и выключен.** Это единственное
 * место формы, где утечка возможна физически, поэтому он не в общем списке
 * галочек, не включён заранее и предупреждает прямым текстом. Снимок
 * выбирает человек сам из галереи: автоматический захват показал бы то, что
 * приложение сочло нужным, а он должен отправить то, что видел.
 *
 * **Отказа нет.** Исходов ровно два: «получили» и «отправим, когда появится
 * сеть». Человек пишет в ту минуту, когда его задело; ответ «не получилось»
 * означал бы, что он не напишет больше никогда.
 */
import { useState, type ReactNode } from 'react';
import {
  Button,
  Checkbox,
  IconArrowLeft,
  IconButton,
  IconCheck,
  IconClose,
  InfoNote,
  Radio,
  Spinner,
  Switch,
  TextField,
} from '@zapiski/ui';
import type {
  DiagnosticsConsent,
  FeedbackContext,
  FeedbackDiagnostics,
  FeedbackEntry,
  FeedbackKind,
} from '@zapiski/core';

import { useApp, useAppState, useStrings } from '../state/context.js';
import { Section } from '../components/ScreenStates.js';
import { downscaleImage } from '../lib/downscale.js';

/** Порядок вариантов — от самого частого к самому редкому. */
const KINDS: FeedbackKind[] = ['broken', 'awkward', 'want-feature', 'other'];

/** Порядок пунктов диагностики — он же порядок в теле запроса. */
const DIAGNOSTIC_KEYS: Array<keyof FeedbackDiagnostics> = [
  'version',
  'platform',
  'locale',
  'notes',
  'encryption',
  'errorCodes',
  'daysSinceInstall',
];

type Stage = 'form' | 'sending' | 'sent' | 'queued';

export function FeedbackScreen(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const copy = strings.feedback;

  const route = state.route.name === 'feedback' ? state.route : null;
  const entry: FeedbackEntry = route?.entry ?? 'menu';
  const context: FeedbackContext | undefined = route?.context;

  const [kind, setKind] = useState<FeedbackKind>('broken');
  const [text, setText] = useState('');
  const [contact, setContact] = useState('');
  const [consent, setConsent] = useState<DiagnosticsConsent>({});
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotOn, setScreenshotOn] = useState(false);
  const [stage, setStage] = useState<Stage>('form');
  const [touched, setTouched] = useState(false);
  const [diagnostics, setDiagnostics] = useState<FeedbackDiagnostics | null>(null);

  /* Диагностику спрашиваем один раз при первом рисовании: она не меняется,
     пока человек заполняет форму, а пересчитывать её на каждый штрих значило
     бы дёргать хранилище за числом заметок. */
  if (diagnostics === null) void app.feedbackDiagnostics().then(setDiagnostics);

  const empty = text.trim().length === 0;

  async function send(): Promise<void> {
    setTouched(true);
    if (empty) return;
    setStage('sending');
    const outcome = await app.submitFeedback(
      {
        kind,
        text: text.trim(),
        ...(contact.trim() ? { contact: contact.trim() } : {}),
        ...(screenshotOn && screenshot ? { screenshot } : {}),
        entry,
        ...(context ? { context } : {}),
      },
      consent,
    );
    setStage(outcome === 'sent' ? 'sent' : 'queued');
  }

  async function pickScreenshot(file: File): Promise<void> {
    try {
      /* Тот же ужиматель, что и у вложений: снимок экрана телефона — это
         несколько мегабайт, а обращению хватает читаемой картинки. Не вышло
         (нет OffscreenCanvas, формат не тот) — берём оригинал: обращение важнее
         экономии. */
      const shrunk = (await downscaleImage(file).catch(() => null)) ?? file;
      const bytes = new Uint8Array(await shrunk.arrayBuffer());
      setScreenshot(`data:${file.type};base64,${base64(bytes)}`);
    } catch {
      setScreenshot(null);
      app.toast({ message: copy.screenshotFailed });
    }
  }

  if (stage === 'sent' || stage === 'queued') {
    return (
      <Done
        title={stage === 'sent' ? copy.sentTitle : copy.queuedTitle}
        hint={stage === 'sent' ? copy.sentHint : copy.queuedHint}
        action={copy.done}
        onDone={() => app.back()}
        back={strings.app.back}
      />
    );
  }

  return (
    <div className="za-editor">
      <div className="za-header">
        <IconButton
          icon={<IconArrowLeft size={20} />}
          label={strings.app.back}
          tone="ghost"
          onClick={() => app.back()}
        />
        <h1 className="za-h1 za-h1--mobile za-header__title">{copy.title}</h1>
      </div>

      <div className="za-scroll">
        <div className="za-page za-stack">
          <p className="za-muted">{copy.intro}</p>

          <Section>{copy.kindLabel}</Section>
          <div className="za-feedback__kinds" role="radiogroup" aria-label={copy.kindLabel}>
            {KINDS.map((value) => (
              /*
                Пояснение живёт ВНУТРИ подписи переключателя, а не рядом с ним.
                Сначала было рядом — и браузер показал, почему так нельзя:
                `Radio` сам по себе `<label>`, а внешняя обёртка добавляла
                второй, вложенный. Вложенные `<label>` — недопустимая разметка,
                и раскладка разъезжалась: пояснение «Не работает то, что должно»
                отставало от «Сломалось» на полсотни пикселей и читалось как
                подпись к СЛЕДУЮЩЕМУ варианту. Теперь это одна подпись, и
                нажатие по любой её части выбирает вариант.
              */
              <Radio
                key={value}
                name="feedback-kind"
                checked={kind === value}
                onChange={() => setKind(value)}
                label={
                  <span className="za-feedback__kind">
                    <span className="za-feedback__kind-name">{copy.kinds[value]}</span>
                    <span className="za-feedback__kind-hint">{copy.kinds[`${value}Hint`]}</span>
                  </span>
                }
              />
            ))}
          </div>

          <Section>{copy.textLabel}</Section>
          {/*
            Обычная `textarea`, а не поле в одну строку: рассказ о сбое — это
            три-четыре предложения, и заставлять писать их в щель значит
            получить одно слово вместо рассказа.
          */}
          <textarea
            className="za-feedback__text"
            value={text}
            rows={6}
            placeholder={copy.textPlaceholder}
            aria-label={copy.textLabel}
            onChange={(event) => setText(event.target.value)}
          />
          {touched && empty ? <p className="za-feedback__error">{copy.textRequired}</p> : null}

          <TextField
            label={copy.contactLabel}
            hint={copy.contactHint}
            type="email"
            value={contact}
            onChange={(event) => setContact(event.currentTarget.value)}
          />

          <Section>{copy.diagnosticsTitle}</Section>
          <p className="za-muted">{copy.diagnosticsHint}</p>
          <div className="za-feedback__diagnostics">
            {diagnostics === null
              ? null
              : DIAGNOSTIC_KEYS.map((key) => (
                  <label className="za-feedback__item" key={key}>
                    <Checkbox
                      checked={consent[key] !== false}
                      onChange={(event) =>
                        setConsent({ ...consent, [key]: event.currentTarget.checked })
                      }
                      label={copy.diagnostics[key]}
                    />
                    <span className="za-feedback__value">{describe(key, diagnostics, copy)}</span>
                  </label>
                ))}
          </div>

          {/*
            Снимок экрана — отдельно от галочек выше и с предупреждением.
            Порядок именно такой: сначала предупреждение, потом тумблер. Иначе
            человек включает, а читает потом.
          */}
          <Section>{copy.screenshotLabel}</Section>
          <InfoNote tone="warning">{copy.screenshotWarning}</InfoNote>
          <Switch
            checked={screenshotOn}
            onChange={(event) => {
              const next = event.currentTarget.checked;
              setScreenshotOn(next);
              if (!next) setScreenshot(null);
            }}
            label={copy.screenshotLabel}
          />
          {screenshotOn ? (
            <div className="za-feedback__shot">
              {screenshot === null ? (
                <label className="za-feedback__pick">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void pickScreenshot(file);
                    }}
                  />
                  <span>{copy.screenshotPick}</span>
                </label>
              ) : (
                <>
                  <img className="za-feedback__preview" src={screenshot} alt={copy.screenshotAttached} />
                  <Button variant="text" onClick={() => setScreenshot(null)}>
                    {copy.screenshotRemove}
                  </Button>
                </>
              )}
            </div>
          ) : null}

          <div className="za-feedback__submit">
            <Button variant="primary" disabled={stage === 'sending'} onClick={() => void send()}>
              {stage === 'sending' ? (
                <>
                  <Spinner size={16} /> {copy.sending}
                </>
              ) : (
                copy.submit
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Экран после отправки. Один и тот же для «уехало» и «уедет». */
function Done(props: {
  title: string;
  hint: string;
  action: string;
  back: string;
  onDone: () => void;
}): ReactNode {
  return (
    <div className="za-editor">
      <div className="za-header">
        <IconButton
          icon={<IconArrowLeft size={20} />}
          label={props.back}
          tone="ghost"
          onClick={props.onDone}
        />
      </div>
      <div className="za-scroll">
        <div className="za-page za-stack za-feedback__done">
          <IconCheck size={32} />
          <h2 className="za-h2">{props.title}</h2>
          <p className="za-muted">{props.hint}</p>
          <Button variant="primary" onClick={props.onDone}>
            {props.action}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Значение пункта человеческими словами.
 *
 * Показывается рядом с названием, потому что согласие на «Количество заметок»
 * — это согласие вслепую. Числа здесь нет и не будет: только корзина.
 */
function describe(
  key: keyof FeedbackDiagnostics,
  diagnostics: FeedbackDiagnostics,
  copy: { notesBuckets: Record<string, string>; on: string; off: string; none: string },
): string {
  switch (key) {
    case 'notes':
      return copy.notesBuckets[diagnostics.notes] ?? diagnostics.notes;
    case 'encryption':
      return diagnostics.encryption ? copy.on : copy.off;
    case 'errorCodes':
      return diagnostics.errorCodes.length > 0 ? diagnostics.errorCodes.join(', ') : copy.none;
    case 'daysSinceInstall':
      return String(diagnostics.daysSinceInstall);
    default:
      return String(diagnostics[key]);
  }
}

/** Байты → base64. Кусками: спред всего массива переполняет стек. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}
