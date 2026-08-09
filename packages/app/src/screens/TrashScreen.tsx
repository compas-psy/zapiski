/**
 * Корзина — 30 дней (ТЗ §5.2), матрица BEHAVIOR §12.
 *
 * «Очистить корзину» — ОДНО ИЗ ТРЁХ мест, где разрешён диалог подтверждения
 * (BEHAVIOR §0). Восстановление — обычное действие без диалога.
 */
import { useState, type ReactNode } from 'react';
import { TRASH_TTL_DAYS } from '@zapiski/core';
import { Button, IconArrowLeft, IconButton, IconTrash } from '@zapiski/ui';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { EmptyBlock, ListSkeleton } from '../components/ScreenStates.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { shortDate } from '../lib/format.js';

export function TrashScreen(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const [confirm, setConfirm] = useState(false);

  const screenState = app.screenState('trash', state.trash.length === 0);

  return (
    <div className="za-bottom__host">
      <div className="za-header">
        <IconButton
          icon={<IconArrowLeft size={20} />}
          label={strings.app.back}
          tone="ghost"
          onClick={() => app.back()}
        />
        <h1 className="za-h1 za-h1--mobile za-header__title">{strings.trash.title}</h1>
        {state.trash.length > 0 ? (
          <Button variant="text" size="compact" onClick={() => setConfirm(true)}>
            {strings.trash.purge}
          </Button>
        ) : null}
      </div>

      <div className="za-scroll">
        <p className="za-state za-tertiary-mono">{strings.trash.ttlHint(TRASH_TTL_DAYS)}</p>
        {screenState === 'loading' ? (
          <ListSkeleton rows={4} />
        ) : screenState === 'empty' ? (
          <EmptyBlock title={strings.empty.trash} icon={<IconTrash size={24} />} />
        ) : (
          state.trash.map((entry) => (
            <div key={entry.id} className="za-row" style={{ cursor: 'default' }}>
              <span className="za-row__body">
                <span className="za-row__title">{entry.title}</span>
                <span className="za-row__meta">
                  {entry.originalPath} · {strings.trash.deletedAt(shortDate(entry.deletedAt))}
                </span>
              </span>
              <Button
                variant="text"
                size="compact"
                onClick={() => void app.restoreFromTrash(entry.id)}
              >
                {strings.trash.restore}
              </Button>
            </div>
          ))
        )}
      </div>

      {/* Очистка корзины — одно из ТРЁХ разрешённых мест с диалогом. */}
      <ConfirmDialog
        reason="purge-trash"
        open={confirm}
        title={strings.trash.purge}
        question={strings.trash.purgeQuestion}
        confirmLabel={strings.trash.purgeConfirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void app.purgeTrash()}
      />
    </div>
  );
}
