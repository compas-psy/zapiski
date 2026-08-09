/**
 * Отладочное меню — приёмочный критерий №10:
 * «Каждая ячейка матрицы §12 воспроизводима в отладочном меню».
 *
 * Меню не описывает матрицу словами, а рисует её: таблица берётся из
 * `MATRIX` (`state/store.ts`), где §12 записана дословно. Прочерк в
 * спецификации = выключенная ячейка здесь; заполненная — кнопка, которая
 * одновременно переводит приложение на нужный экран и включает состояние.
 *
 * Открывается из Настроек («Отладочное меню»), закрывается «Вернуть как есть».
 */
import { useState, type ReactNode } from 'react';
import { Button, Modal, SegmentedControl } from '@zapiski/ui';
import type { SyncBackend } from '@zapiski/core';
import type { ScreenState } from '../contract.js';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { MATRIX, type MatrixScreen } from '../state/store.js';

const SCREENS = Object.keys(MATRIX) as MatrixScreen[];
const STATES: Array<Exclude<ScreenState, 'normal'>> = [
  'empty',
  'loading',
  'offline',
  'error',
  'locked',
];
const BACKENDS: Array<SyncBackend['id'] | 'none'> = ['none', 'local', 'webdav', 'yandex', 'kompas'];

export function DebugMenu(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const copy = strings.debug;
  /** Какая ячейка показана сейчас — для подписи «Показывается: … · …». */
  const [shown, setShown] = useState<MatrixScreen | null>(null);

  const close = (): void => app.toggleDebug(false);

  /** Показать ячейку: перейти на экран и включить состояние. */
  const show = (screen: MatrixScreen, forced: Exclude<ScreenState, 'normal'>): void => {
    app.setDebug({ forceState: forced });
    setShown(screen);
    goTo(screen);
    close();
  };

  const goTo = (screen: MatrixScreen): void => {
    switch (screen) {
      case 'list':
        app.setScope('all');
        app.navigate({ name: 'list' });
        return;
      case 'folder': {
        const folder = state.folders[0]?.path ?? '';
        app.openFolder(folder);
        return;
      }
      case 'note':
      case 'backlinks': {
        const note = state.notes[0];
        if (note) app.openNote(note.path);
        else void app.createNote();
        return;
      }
      case 'search':
        app.navigate({ name: 'search' });
        return;
      case 'library':
        app.navigate({ name: 'list' });
        app.toggleLibrary(true);
        return;
      case 'archive':
        app.navigate({ name: 'archive' });
        return;
      case 'trash':
        app.navigate({ name: 'trash' });
        return;
      case 'settingsSync':
        app.navigate({ name: 'settings', section: 'sync' });
        return;
      default:
        return;
    }
  };

  const forced = state.debug.forceState;

  return (
    <Modal
      open={state.debugOpen}
      onClose={close}
      wide
      title={copy.title}
      closeLabel={strings.app.close}
      footer={
        <div className="za-row-between">
          <span className="za-tertiary-mono">
            {forced
              ? copy.active(shown ? copy.screens[shown] : copy.screen, copy.states[forced])
              : copy.subtitle}
          </span>
          <Button
            variant="text"
            onClick={() => {
              app.setDebug({ forceState: null, forceSyncBackend: null });
              setShown(null);
              close();
            }}
          >
            {copy.reset}
          </Button>
        </div>
      }
    >
      <div className="za-stack za-stack--tight">
        {SCREENS.map((screen) => (
          <section key={screen}>
            <p className="za-section">{copy.screens[screen]}</p>
            <div className="za-debug-grid">
              {STATES.map((cell) => {
                const supported = MATRIX[screen][cell];
                return (
                  <button
                    key={cell}
                    type="button"
                    disabled={!supported}
                    title={supported ? undefined : copy.notApplicable}
                    aria-label={`${copy.screens[screen]} · ${copy.states[cell]}`}
                    className={`za-debug-cell${forced === cell ? ' za-debug-cell--active' : ''}`}
                    onClick={() => show(screen, cell)}
                  >
                    {copy.states[cell]}
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        <p className="za-section">{copy.backend}</p>
        <SegmentedControl<string>
          label={copy.backend}
          value={state.debug.forceSyncBackend ?? 'none'}
          onChange={(value) =>
            app.setDebug({
              forceSyncBackend: value === 'none' ? null : (value as SyncBackend['id']),
            })
          }
          options={BACKENDS.map((id) => ({ value: id, label: copy.backends[id] }))}
        />
      </div>
    </Modal>
  );
}
