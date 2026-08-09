/**
 * Установка шифрования — SCREENS §7 (`2e`), BEHAVIOR §5.1.
 *
 * Bottom sheet: пароль, повтор, подсказка, тумблер биометрии (включён по
 * умолчанию, СКРЫТ, если платформа не поддерживает), плашка с честным
 * предупреждением и кнопка «Зашифровать» — неактивная, пока условия не
 * выполнены. Несовпадение повтора показывается только после blur второго поля.
 */
import { useState, type ReactNode } from 'react';
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

  const biometrics = app.host.platform.biometrics;
  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = repeat.length > 0 && repeat !== password;
  const ready = password.length >= MIN_LENGTH && repeat === password;
  /* Три деления, приглушённые цвета, без «слабый/плохой» (BEHAVIOR §5.1). */
  const strength = strengthOf(password);

  const submit = async (): Promise<void> => {
    setBusy(true);
    const target = await app.encryptNote(path, password, hint || undefined);
    if (target && biometrics && useBiometrics) {
      await biometrics.enroll(target, new TextEncoder().encode(password)).catch(() => undefined);
    }
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
      title={strings.crypto.setupTitle}
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
