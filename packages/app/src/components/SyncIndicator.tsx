/**
 * Индикатор синка — точка 6 px в шапке (BEHAVIOR §6, DESIGN_TOKENS §1).
 * Пульсация запрещена. Тап открывает панель статуса; при ошибке в ней текст
 * из реестра §11 и «Повторить». Модалок с ошибками нет.
 */
import { useState, type ReactNode } from 'react';
import { BottomSheet, Button, SyncDot } from '@zapiski/ui';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { clockTime, formatBytes } from '../lib/format.js';

export function SyncIndicator(): ReactNode {
  const app = useApp();
  const { sync, syncError, online } = useAppState();
  const strings = useStrings();
  const [open, setOpen] = useState(false);

  const state = !online ? 'offline' : sync.state;
  const label =
    state === 'offline'
      ? strings.syncState.offline
      : state === 'error'
        ? strings.syncState.error
        : state === 'syncing'
          ? strings.syncState.syncing
          : strings.syncState.synced;

  return (
    <>
      <button
        type="button"
        aria-label={`${strings.sync.indicator}: ${label}`}
        onClick={() => setOpen(true)}
        style={{ border: 0, background: 'none', padding: 4, cursor: 'pointer' }}
      >
        <SyncDot status={state} label={label} />
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={strings.sync.panelTitle}>
        <div className="za-stack za-stack--tight">
          <div className="za-row-between">
            <span className="za-muted">{strings.sync.lastSync}</span>
            <span className="za-tertiary-mono">
              {sync.lastSyncAt ? clockTime(sync.lastSyncAt) : strings.sync.never}
            </span>
          </div>
          <div className="za-row-between">
            <span className="za-muted">{strings.sync.notes(sync.noteCount)}</span>
            <span className="za-tertiary-mono">{formatBytes(sync.bytes, strings)}</span>
          </div>
          {syncError ? <p className="za-muted">{syncError}</p> : null}
          <Button
            variant="secondary"
            onClick={() => {
              void app.syncNow();
              setOpen(false);
            }}
          >
            {syncError ? strings.actions.retry : strings.sync.syncNow}
          </Button>
        </div>
      </BottomSheet>
    </>
  );
}
