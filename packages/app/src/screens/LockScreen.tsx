/**
 * Экран «заперто» — SCREENS §7 (`1l`) и BEHAVIOR §5.2.
 *
 * Тон спокойный: ни красного, ни предупреждающих иконок. Неверный пароль —
 * точки мягко возвращаются в исходное, подпись `--text-secondary`, подсказка,
 * если задана. Попытки 1–4 без задержки, после 5-й 30 с, после 8-й 5 мин.
 * Данные не удаляются никогда, устройство не блокируется.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { VaultPath } from '@zapiski/core';
import { BottomSheet, Button, IconLock, PinDots, TextField } from '@zapiski/ui';
import { IconFingerprint } from '../components/icons.js';
import { useApp, useStrings } from '../state/context.js';

export interface LockScreenProps {
  path: VaultPath;
  title: string;
  onUnlocked: (body: string) => void;
}

export function LockScreen({ path, title, onUnlocked }: LockScreenProps): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const [password, setPassword] = useState('');
  const [failed, setFailed] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [delayLeft, setDelayLeft] = useState(0);
  const [biometricsSheet, setBiometricsSheet] = useState(false);
  /* Привязка отпечатка не подошла к хранилищу и была снята — надо сказать. */
  const [stale, setStale] = useState(false);
  /**
   * Готова ли биометрия именно для этого хранилища.
   *
   * Наличие порта означает лишь, что Windows Hello (или Android Keystore)
   * настроен на машине. Ключ хранилища при этом мог туда и не попасть — тогда
   * кнопка «палец» вела бы прямиком в отказ системы, и человек читал бы его
   * как поломку. `null` — ещё не спросили, кнопку не рисуем.
   */
  const [biometricsReady, setBiometricsReady] = useState<boolean | null>(null);

  const biometrics = app.host.platform.biometrics;

  useEffect(() => {
    void app.hintFor(path).then(setHint);
  }, [app, path]);

  /* Обратный отсчёт в подписи, без блокировки устройства (BEHAVIOR §5.2). */
  useEffect(() => {
    const tick = (): void => setDelayLeft(Math.ceil(app.unlockDelayLeftMs / 1000));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [app]);

  /* Биометрия предлагается автоматически, если она есть И включена
     (BEHAVIOR §5.2). «Есть на устройстве» и «настроена для хранилища» — разные
     вещи: без второй проверки лист предлагал бы палец там, где в keystore
     ничего не лежит, и отмена выглядела бы отказом системы. */
  useEffect(() => {
    if (!biometrics) return;
    void Promise.all([biometrics.isAvailable(), app.biometricsEnabled()]).then(
      ([available, enabled]) => {
        setBiometricsReady(available && enabled);
        if (available && enabled) setBiometricsSheet(true);
      },
    );
  }, [app, biometrics]);

  const submit = async (): Promise<void> => {
    const body = await app.unlock(path, password);
    setPassword('');
    if (body === null) {
      setFailed(true);
      return;
    }
    setFailed(false);
    onUnlocked(body);
  };

  const tryBiometrics = async (): Promise<void> => {
    setBiometricsSheet(false);
    const outcome = await app.unlockWithBiometrics(path);
    if (outcome.kind === 'unlocked') {
      onUnlocked(outcome.body);
      return;
    }
    /* Отмена биометрии — не ошибка: просто остаётся поле пароля.
       Заметка версии 1 — тоже: её открывает только пароль, и привязка
       отпечатка здесь ни при чём, снимать её не за что. */
    if (outcome.kind === 'cancelled' || outcome.kind === 'legacy') return;
    /* Привязка не подходит хранилищу — она уже снята, и об этом надо сказать:
       иначе палец «не срабатывает» молча, и человек считает это поломкой. */
    setBiometricsReady(false);
    setStale(true);
  };

  return (
    <div className="za-locked">
      <span className="za-locked__circle">
        <IconLock size={34} />
      </span>
      <p className="za-locked__title">{title}</p>
      <p className="za-muted">{strings.crypto.lockedTitle}</p>

      <PinDots filled={Math.min(6, password.length)} label={strings.crypto.pinLabel} />

      <div style={{ inlineSize: '100%', maxInlineSize: 320 }}>
        <TextField
          type="password"
          value={password}
          label={strings.crypto.password}
          autoComplete="current-password"
          disabled={delayLeft > 0}
          onChange={(event) => {
            setPassword(event.target.value);
            setFailed(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
        {/*
          Подсказка видна СРАЗУ, а не после ошибки.
          Она и заводится ради того, чтобы вспомнить пароль до попытки; прежде
          её показывали только вместе с «Пароль не подошёл», то есть ровно
          тому, кто уже промахнулся. Человеку, который просто не помнит, она не
          доставалась вовсе — а он-то и есть её адресат.
        */}
        {hint ? <p className="za-muted za-hint">{strings.crypto.hintShown(hint)}</p> : null}
        {failed ? (
          <p className="za-muted" role="status">
            {strings.errors.wrongPassword}
          </p>
        ) : null}
        {stale ? (
          <p className="za-muted" role="status">
            {strings.crypto.biometricsStale}
          </p>
        ) : null}
        {delayLeft > 0 ? (
          <p className="za-muted" role="status">
            {delayLeft === 30 ? strings.errors.tryLater : strings.crypto.tryLaterIn(delayLeft)}
          </p>
        ) : null}
      </div>

      <Button onClick={() => void submit()} disabled={password.length === 0 || delayLeft > 0}>
        {strings.crypto.unlock}
      </Button>

      {/* Возможности нет на платформе или ключа нет в keystore — элемент
          скрыт, а не выключен (BEHAVIOR §5.1). */}
      {biometrics && biometricsReady === true ? (
        <Button variant="text" onClick={() => void tryBiometrics()}>
          {strings.crypto.useBiometrics}
        </Button>
      ) : null}

      {/*
        Забытый пароль — тупик по устройству продукта, но не повод молчать.

        Заказчик: «я не помню пароль и нельзя его восстановить». Восстановить
        действительно нельзя — в этом и защита, — но человек имеет право
        узнать это ЗДЕСЬ, а не догадываться, перебирая пароли. Поэтому раздел
        говорит прямо: обхода нет, файл на месте, заметка цела, попытки не
        удаляют ничего. Ни одной кнопки «восстановить», которая ведёт в никуда.
      */}
      <details className="za-locked__forgot">
        <summary>{strings.crypto.forgotTitle}</summary>
        <p className="za-muted">{strings.crypto.forgotBody}</p>
      </details>

      {biometrics ? (
        <BottomSheet
          open={biometricsSheet}
          onClose={() => setBiometricsSheet(false)}
          title={strings.crypto.biometricsTitle}
        >
          <div className="za-stack" style={{ alignItems: 'center', textAlign: 'center' }}>
            <p className="za-muted">{strings.crypto.biometricsSubtitle}</p>
            <span className="za-locked__circle" style={{ inlineSize: 74, blockSize: 74 }}>
              <IconFingerprint size={30} />
            </span>
            <Button onClick={() => void tryBiometrics()}>{strings.crypto.useBiometrics}</Button>
            <Button variant="text" onClick={() => setBiometricsSheet(false)}>
              {strings.crypto.usePassword}
            </Button>
          </div>
        </BottomSheet>
      ) : null}
    </div>
  );
}
