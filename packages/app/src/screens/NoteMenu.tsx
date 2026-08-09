/**
 * Меню «⋯» заметки на mobile — bottom sheet с панелью «Инфо» и действиями
 * (BEHAVIOR §2.9). Плюс вход в режим фокуса, raw-режим и шифрование.
 */
import { useState, type ReactNode } from 'react';
import { isEncryptedPath, type Note, type NoteMeta } from '@zapiski/core';
import { BottomSheet, Button } from '@zapiski/ui';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { InfoPanel } from './InfoPanel.js';
import { EncryptSheet } from './EncryptSheet.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';

export interface NoteMenuProps {
  note: Note;
  backlinks: readonly NoteMeta[];
  open: boolean;
  onClose: () => void;
}

export function NoteMenu({ note, backlinks, open, onClose }: NoteMenuProps): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const [encryptOpen, setEncryptOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
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
                setRemoveOpen(true);
                onClose();
              }}
            >
              {strings.crypto.removeTitle}
            </Button>
          )}
          <InfoPanel note={note} backlinks={backlinks} />
        </div>
      </BottomSheet>

      <EncryptSheet
        open={encryptOpen}
        path={note.path}
        onClose={() => setEncryptOpen(false)}
      />

      {/* Снятие шифрования — одно из ТРЁХ мест с диалогом (BEHAVIOR §0). */}
      <ConfirmDialog
        reason="remove-encryption"
        open={removeOpen}
        title={strings.crypto.removeTitle}
        question={strings.crypto.removeQuestion}
        confirmLabel={strings.crypto.removeConfirm}
        onClose={() => setRemoveOpen(false)}
        onConfirm={() => setRemoveOpen(false)}
      />
    </>
  );
}
