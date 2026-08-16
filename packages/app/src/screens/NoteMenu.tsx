/**
 * Меню «⋯» заметки — bottom sheet с действиями и панелью «Инфо»
 * (BEHAVIOR §2.9). Плюс вход в режим фокуса, raw-режим и шифрование.
 *
 * Здесь же снятие шифрования, и оно спрашивает пароль. Прежде подтверждение
 * стояло, а действия за ним не было вовсе: `onConfirm` закрывал диалог и на
 * этом заканчивался. Человек отвечал «да» на вопрос «заметка станет обычным
 * файлом на диске, продолжить?» — и не происходило ничего.
 */
import { useState, type ReactNode } from 'react';
import { isEncryptedPath, type Note, type NoteMeta, type VaultPath } from '@zapiski/core';
import { BottomSheet, Button, IconInfo, InfoNote, TextField } from '@zapiski/ui';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { InfoPanel } from './InfoPanel.js';
import { EncryptSheet } from './EncryptSheet.js';
import type { ConfirmReason } from '../components/ConfirmDialog.js';

export interface NoteMenuProps {
  note: Note;
  backlinks: readonly NoteMeta[];
  open: boolean;
  onClose: () => void;
  /** На десктопе «Инфо» живёт своей колонкой — в листе он был бы вторым. */
  showInfo?: boolean;
}

export function NoteMenu({
  note,
  backlinks,
  open,
  onClose,
  showInfo = true,
}: NoteMenuProps): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const [encryptOpen, setEncryptOpen] = useState(false);
  const encrypted = isEncryptedPath(note.path);

  return (
    <>
      <BottomSheet open={open} onClose={onClose} title={strings.note.infoPanel.title}>
        <div className="za-stack za-stack--tight">
          <Button
            variant="text"
            onClick={() => {
              app.toggleFocusMode(true);
              onClose();
            }}
          >
            {strings.note.focus}
          </Button>
          <Button variant="text" onClick={() => app.toggleRawMode(!state.rawMode)}>
            {strings.note.raw}
          </Button>
          {!encrypted ? (
            <Button
              variant="text"
              onClick={() => {
                setEncryptOpen(true);
                onClose();
              }}
            >
              {strings.list.encrypt}
            </Button>
          ) : (
            <Button
              variant="text"
              onClick={() => {
                app.askRemoveEncryption(note.path);
                onClose();
              }}
            >
              {strings.crypto.removeTitle}
            </Button>
          )}
          {showInfo ? <InfoPanel note={note} backlinks={backlinks} /> : null}
        </div>
      </BottomSheet>

      <EncryptSheet open={encryptOpen} path={note.path} onClose={() => setEncryptOpen(false)} />
    </>
  );
}

/**
 * Снятие шифрования — подтверждение ПАРОЛЕМ, а не кнопкой «да».
 *
 * Это одно из трёх мест с подтверждением (BEHAVIOR §0), и `reason` объявляет
 * его так же, как `ConfirmDialog`: сторож инвариантов считает места, а не
 * компоненты. Форма подтверждения здесь другая по необходимости —
 * `AppController.removeEncryption` требует пароль, и «да/нет» его дать не
 * может. Ровно поэтому прежний диалог ничего и не делал: он спрашивал
 * согласие там, где нужен был ключ.
 *
 * Пароль спрашивается даже при открытом хранилище: после этой операции текст
 * ложится на диск открытым, и подтвердить её должен человек, а не сеанс.
 * Вопрос из BEHAVIOR §5.3 остаётся на экране — он объясняет, что произойдёт.
 */
export function RemoveEncryptionSheet({
  open,
  path,
  onClose,
}: {
  /** Объявление места подтверждения; в поведении не участвует. */
  reason: ConfirmReason;
  open: boolean;
  path: VaultPath;
  onClose: () => void;
}): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const target = await app.removeEncryption(path, password);
      if (target === null) {
        setError(strings.errors.wrongPassword);
        return;
      }
      setPassword('');
      onClose();
      app.toast({ message: strings.crypto.removeDone });
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={strings.crypto.removeTitle}
      footer={
        <Button
          fullWidth
          disabled={password.length === 0}
          loading={busy}
          onClick={() => void submit()}
        >
          {strings.crypto.removeConfirm}
        </Button>
      }
    >
      <div className="za-stack za-stack--tight">
        <InfoNote icon={<IconInfo size={15} />}>{strings.crypto.removeQuestion}</InfoNote>
        <TextField
          type="password"
          label={strings.crypto.password}
          value={password}
          autoComplete="current-password"
          error={error ?? undefined}
          showError={error !== null}
          onChange={(event) => {
            setPassword(event.target.value);
            setError(null);
          }}
        />
      </div>
    </BottomSheet>
  );
}
