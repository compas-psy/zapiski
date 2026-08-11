/**
 * Установка шифрования — SCREENS §7 (`2e`), BEHAVIOR §5.1.
 *
 * Два состояния, и это следствие иерархии ключей (ТЗ §3.3):
 *
 *  · пароля хранилища ещё нет — лист просит его завести: пароль, повтор,
 *    подсказка, тумблер биометрии, честное предупреждение. Это происходит
 *    ОДИН раз за всё время жизни хранилища;
 *  · пароль есть — полей нет вовсе, только кнопка. Спрашивать пароль на
 *    каждую заметку значило бы заводить по паролю на заметку, а это утопия:
 *    их невозможно запомнить, и человек либо ставит везде один, либо
 *    перестаёт шифровать.
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
  const [needsPassword, setNeedsPassword] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void app.hasVaultPassword().then((has) => {
      if (alive) setNeedsPassword(!has);
    });
    return () => {
      alive = false;
    };
  }, [app, open]);

  const biometrics = app.host.platform.biometrics;
  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = repeat.length > 0 && repeat !== password;
  const ready =
    needsPassword === false || (password.length >= MIN_LENGTH && repeat === password);
  /* Три деления, приглушённые цвета, без «слабый/плохой» (BEHAVIOR §5.1). */
  const strength = strengthOf(password);

  const submit = async (): Promise<void> => {
    setBusy(true);
    /* Пароль задаётся только в первый раз; дальше шифрование молчит. */
    if (needsPassword) await app.setVaultPassword(password, Boolean(biometrics) && useBiometrics);
    await app.encryptNote(path, hint || undefined);
    setBusy(false);
    setPassword('');
    setRepeat('');
    setHint('');
    onClose();
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={needsPassword === false ? strings.crypto.encryptTitle : strings.crypto.setupTitle}
      footer={
        <Button fullWidth disabled={!ready} loading={busy} onClick={() => void submit()}>
          {strings.crypto.encrypt}
        </Button>
      }
    >
      <div className="za-stack za-stack--tight">
        <span className="za-bullet__tile">
          <IconLock size={18} />
        </span>

        {needsPassword === false ? (
          <InfoNote icon={<IconInfo size={15} />}>{strings.crypto.reuseVaultPassword}</InfoNote>
        ) : null}

        {needsPassword ? (
          <>
        <TextField
          type="password"
          label={strings.crypto.password}
          value={password}
          autoComplete="new-password"
          error={tooShort ? strings.crypto.tooShort : undefined}
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
          /* Ошибка показывается ПОСЛЕ blur — так устроен TextField в ui. */
          error={mismatch ? strings.crypto.mismatch : undefined}
          onChange={(event) => setRepeat(event.target.value)}
        />
        <TextField
          label={strings.crypto.hint}
          value={hint}
          onChange={(event) => setHint(event.target.value)}
        />

        {/* Платформа без биометрии — тумблер скрыт, не «выключен и недоступен». */}
        {biometrics ? (
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
