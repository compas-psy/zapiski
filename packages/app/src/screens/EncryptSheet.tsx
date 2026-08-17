/**
 * Установка шифрования — SCREENS §7 (`2e`), BEHAVIOR §5.1.
 *
 * Три состояния, и это следствие иерархии ключей (ТЗ §3.3):
 *
 *  · `none` — пароля хранилища ещё нет: лист просит его завести (пароль,
 *    повтор, подсказка, тумблер биометрии, честное предупреждение). Это
 *    происходит ОДИН раз за всё время жизни хранилища;
 *  · `locked` — пароль задан, но ключа в памяти нет: лист просит пароль ОДНИМ
 *    полем и открывает хранилище на месте;
 *  · `open` — ключ в памяти: полей нет вовсе, только кнопка. Спрашивать пароль
 *    на каждую заметку значило бы заводить по паролю на заметку, а это утопия:
 *    их невозможно запомнить, и человек либо ставит везде один, либо перестаёт
 *    шифровать.
 *
 * ── Откуда взялось состояние `locked` ───────────────────────────────────────
 *
 * Его не было, и это стоило заказчику работающего шифрования. Лист спрашивал
 * `hasVaultPassword()` — «соль есть на диске», — а `encryptNote` требует ключ в
 * памяти. Пароль задаётся один раз, приложение с тех пор перезапускается, ключ
 * в памяти не живёт — и лист показывал одну кнопку, которая отвечала «Не удалось
 * зашифровать заметку · Повторить». «Повторить» повторяло отказ, а ввести пароль
 * было негде: его спрашивает только замок УЖЕ зашифрованной заметки. То есть
 * зашифровать первую заметку после перезапуска стало невозможно.
 *
 * Несовпадение повтора показывается только после blur второго поля.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { VaultPath } from '@zapiski/core';
import { BottomSheet, Button, IconInfo, IconLock, InfoNote, Switch, TextField } from '@zapiski/ui';
import { useApp, useStrings } from '../state/context.js';

/** Минимум 8 символов (BEHAVIOR §5.1). */
const MIN_LENGTH = 8;

export interface EncryptSheetProps {
  open: boolean;
  path: VaultPath;
  onClose: () => void;
}

export function EncryptSheet({ open, path, onClose }: EncryptSheetProps): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [hint, setHint] = useState('');
  const [useBiometrics, setUseBiometrics] = useState(true);
  const [busy, setBusy] = useState(false);
  /* `null` — ещё не знаем: сходить на диск надо, а гадать нельзя. */
  const [lock, setLock] = useState<'none' | 'locked' | 'open' | null>(null);
  /* Отказ пароля в состоянии `locked`: «не подошёл» и «проверить нечем» — разные
     новости, и вторую нельзя показывать первой. */
  const [verdict, setVerdict] = useState<'wrong' | 'unknown' | null>(null);
  /*
   * Умеет ли устройство биометрию. Спрашивается вместе с состоянием замка, до
   * первого показа полей, — поэтому тумблер не «появляется через секунду».
   *
   * Проверка здесь ВТОРАЯ: с этой правки `platform.biometrics` уже равен `null`
   * там, где биометрии нет (так было на Windows и не было на Android). Но
   * «умеет» может измениться и после включения — человек снял все отпечатки в
   * системе, — и предлагать палец в этот момент значит обещать несуществующее.
   */
  const [biometricsReady, setBiometricsReady] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const provider = app.host.platform.biometrics;
    void Promise.all([
      app.vaultLockState(),
      provider ? provider.isAvailable().catch(() => false) : Promise.resolve(false),
    ]).then(([state, available]) => {
      if (!alive) return;
      setLock(state);
      setBiometricsReady(available);
    });
    return () => {
      alive = false;
    };
  }, [app, open]);

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = repeat.length > 0 && repeat !== password;
  const ready =
    lock === 'open' ||
    (lock === 'locked' && password.length > 0) ||
    (lock === 'none' && password.length >= MIN_LENGTH && repeat === password);
  /* Три деления, приглушённые цвета, без «слабый/плохой» (BEHAVIOR §5.1). */
  const strength = strengthOf(password);

  /**
   * Шифрование заметки.
   *
   * `try/finally` здесь не перестраховка, а починка сообщённого дефекта: в
   * Windows лист «зависал после ввода пароля». Ловить было нечем — при отказе
   * `setBusy(false)` просто не выполнялся, и кнопка крутилась вечно, пока
   * человек не закрывал приложение.
   *
   * Отказ был настоящий: Argon2id считается в WebAssembly, а CSP оболочки
   * запрещала его инстанцировать. Причина устранена, но вечное вращение
   * кнопки — отдельный дефект, и он чинится здесь: что бы ни случилось,
   * человек получает строку и возможность повторить.
   */
  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      /* Пароль задаётся только в первый раз; дальше шифрование молчит. */
      if (lock === 'none') await app.setVaultPassword(password, biometricsReady && useBiometrics);
      if (lock === 'locked') {
        /*
         * Открыть хранилище на месте. Ровно этого шага и не хватало: без него
         * шифрование отвечало отказом, который не лечится повтором.
         *
         * `setVaultPassword` здесь звать НЕЛЬЗЯ, хотя соблазн есть: он вывел бы
         * ключ из любого введённого пароля и перезаписал контрольный образец —
         * то есть при опечатке объявил бы новым паролем хранилища опечатку, а
         * уже зашифрованные заметки перестали бы открываться чем-либо.
         */
        const opened = await app.unlockVault(password);
        if (opened !== 'ok') {
          setVerdict(opened);
          return;
        }
        setVerdict(null);
      }
      const target = await app.encryptNote(path, hint || undefined);
      if (target === null) {
        app.toast({ message: strings.errors.encryptFailed });
        return;
      }
      setPassword('');
      setRepeat('');
      setHint('');
      onClose();
    } catch {
      app.toast({ message: strings.errors.encryptFailed });
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={lock === 'none' ? strings.crypto.setupTitle : strings.crypto.encryptTitle}
      footer={
        <Button fullWidth disabled={!ready} loading={busy} onClick={() => void submit()}>
          {lock === 'locked' ? strings.crypto.unlockAndEncrypt : strings.crypto.encrypt}
        </Button>
      }
    >
      <div className="za-stack za-stack--tight">
        <span className="za-bullet__tile">
          <IconLock size={18} />
        </span>

        {lock === 'open' ? (
          <InfoNote icon={<IconInfo size={15} />}>{strings.crypto.reuseVaultPassword}</InfoNote>
        ) : null}

        {/*
          Хранилище закрыто: одно поле и ничего больше.

          Повтора здесь нет и быть не должно — пароль уже существует, и «введите
          дважды» на входе означало бы, что мы не знаем, чего просим. Подсказки
          про 8 символов тоже нет: правило длины относится к установке пароля, а
          не к вводу существующего.
        */}
        {lock === 'locked' ? (
          <>
            <InfoNote icon={<IconInfo size={15} />}>{strings.crypto.lockedVaultNote}</InfoNote>
            <TextField
              type="password"
              label={strings.crypto.password}
              value={password}
              autoComplete="current-password"
              error={
                verdict === 'wrong'
                  ? strings.errors.wrongPassword
                  : verdict === 'unknown'
                    ? strings.crypto.cannotCheckPassword
                    : undefined
              }
              showError={verdict !== null}
              onChange={(event) => {
                setPassword(event.target.value);
                /* Сообщение об отказе живёт до следующей попытки, а не до
                   следующего символа: иначе оно исчезает раньше, чем человек
                   успел его прочитать. Но как только он начал править пароль,
                   оно уже про прошлое. */
                if (verdict !== null) setVerdict(null);
              }}
            />
          </>
        ) : null}

        {lock === 'none' ? (
          <>
        {/*
          Правило длины — подсказкой, а не только ошибкой.

          Ошибка в `TextField` живёт после blur: во время набора текст не
          «кричит», и это верно. Но кнопка выключена ИМЕННО этим правилом, и
          пока человек не ушёл из поля, он видит мёртвую кнопку без причины —
          ровно то, что заказчик описал на смене пароля. Подсказка спокойно
          говорит правило заранее, ошибка после blur остаётся.
        */}
        <TextField
          type="password"
          label={strings.crypto.password}
          value={password}
          autoComplete="new-password"
          hint={strings.crypto.tooShort}
          error={tooShort ? strings.crypto.tooShort : undefined}
          showError={tooShort}
          onChange={(event) => setPassword(event.target.value)}
        />
        <div
          className="za-swatches"
          role="img"
          aria-label={`${strings.crypto.strengthLabel}: ${strength}`}
        >
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              style={{
                inlineSize: 44,
                blockSize: 4,
                borderRadius: 'var(--r-full)',
                backgroundColor: index < strength ? 'var(--accent-soft)' : 'var(--line)',
              }}
            />
          ))}
        </div>

        <TextField
          type="password"
          label={strings.crypto.passwordRepeat}
          value={repeat}
          autoComplete="new-password"
          /*
            Несовпадение показывается сразу, не дожидаясь blur.

            Правило «ошибка живёт после blur» написано для проверок вроде
            формата почты, где недопечатанное значение законно. У повтора
            пароля любое расхождение — это и есть положение дел, и именно оно
            держит кнопку выключенной. Ждать blur значит показывать мёртвую
            кнопку без причины; сообщение исчезает в тот же миг, когда пароли
            сошлись.
          */
          error={mismatch ? strings.crypto.mismatch : undefined}
          showError={mismatch}
          onChange={(event) => setRepeat(event.target.value)}
        />
        <TextField
          label={strings.crypto.hint}
          value={hint}
          onChange={(event) => setHint(event.target.value)}
        />

        {/*
          Устройство без биометрии — тумблер скрыт, не «выключен и недоступен»
          (BEHAVIOR §5.1).

          Раньше здесь стояло `platform.biometrics ?`, то есть «есть ли порт», —
          а порт на Android заявлялся всегда. Тумблер показывался на любом
          телефоне, включённым по умолчанию, и человек, нажав «Зашифровать»,
          получал крах приложения на системном диалоге, которого на этом
          устройстве быть не могло. Теперь спрашивается сама возможность.
        */}
        {biometricsReady ? (
          <Switch
            label={strings.crypto.biometricsToggle}
            checked={useBiometrics}
            onChange={(event) => setUseBiometrics(event.target.checked)}
          />
        ) : null}

        <InfoNote icon={<IconInfo size={15} />}>{strings.crypto.warning}</InfoNote>
          </>
        ) : null}
      </div>
    </BottomSheet>
  );
}

function strengthOf(password: string): number {
  if (password.length < MIN_LENGTH) return 0;
  let score = 1;
  if (password.length >= 12) score += 1;
  if (/[^\p{L}\p{N}]/u.test(password) && /\p{N}/u.test(password)) score += 1;
  return Math.min(3, score);
}
