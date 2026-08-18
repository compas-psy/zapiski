/**
 * Корзина — 30 дней (ТЗ §5.2), матрица BEHAVIOR §12.
 *
 * «Очистить корзину» — ОДНО ИЗ ТРЁХ мест, где разрешён диалог подтверждения
 * (BEHAVIOR §0). Восстановление — обычное действие без диалога.
 *
 * ── Почему экран выглядит именно так ────────────────────────────────────────
 *
 * Заказчик прислал снимок с одним словом: «Корзина выглядит ужасно». Он прав,
 * и причин было три, все — в раскладке узкой колонки:
 *
 *  1. В шапке рядом с заголовком стояла кнопка «Очистить корзину». Кнопка не
 *     умеет ужиматься уже собственного текста, а заголовок умеет — и ужимался
 *     до «К…». Слово «Корзина» пропадало ровно там, где отвечает на вопрос
 *     «куда я попал». Теперь действие стоит под шапкой, рядом с объяснением
 *     «заметки хранятся 30 дней» — то есть там, где человек и решает, чистить
 *     ли; заодно оно перестало соседствовать со стрелкой «назад».
 *  2. Метастрока печатала ПОЛНЫЙ путь с расширением и не имела обрезки, так
 *     что моноширинный «ЗАПИСКИ/ТЕСТЫ/Шифруемая заметка.md.enc · удалена
 *     18.08.2026» ломался на пять строк. Теперь это одна строка: папка (хвост
 *     пути, как в списке заметок — со значком) и дата.
 *  3. `.za-row` — flex со `stretch` по умолчанию, поэтому текстовая кнопка
 *     «Восстановить» растягивалась во всю высоту строки, а её подсветка при
 *     наведении накрывала полстроки розовым. Теперь действие выровнено по
 *     центру и не тянется.
 *
 * Расширение `.md.enc` из строки ушло, но сведения из неё — нет: у
 * зашифрованной записи остаётся замок рядом с заголовком, тот же, что в списке.
 */
import { useState, type ReactNode } from 'react';
import { isEncryptedPath, TRASH_TTL_DAYS } from '@zapiski/core';
import {
  Button,
  IconArrowLeft,
  IconButton,
  IconFolder,
  IconLock,
  IconRestore,
  IconTrash,
} from '@zapiski/ui';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { EmptyBlock, ListSkeleton } from '../components/ScreenStates.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { folderTrail, shortDate } from '../lib/format.js';

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
      </div>

      <div className="za-scroll">
        <div className="za-trash__bar">
          <p className="za-tertiary-mono za-trash__hint">{strings.trash.ttlHint(TRASH_TTL_DAYS)}</p>
          {state.trash.length > 0 ? (
            <Button
              className="za-trash__purge"
              variant="text"
              size="compact"
              onClick={() => setConfirm(true)}
            >
              {strings.trash.purge}
            </Button>
          ) : null}
        </div>
        {screenState === 'loading' ? (
          <ListSkeleton rows={4} />
        ) : screenState === 'empty' ? (
          <EmptyBlock title={strings.empty.trash} icon={<IconTrash size={24} />} />
        ) : (
          state.trash.map((entry) => {
            const folder = folderTrail(entry.originalPath);
            return (
              <div key={entry.id} className="za-row za-row--static">
                <span className="za-row__body">
                  <span className="za-row__head">
                    <span className="za-row__title">{entry.title}</span>
                    {isEncryptedPath(entry.originalPath) ? (
                      /* Та же метка, что в списке заметок: расширение `.md.enc`
                         ушло из строки, а знание «она зашифрована» осталось. */
                      <span className="za-row__marks">
                        <IconLock size={13} aria-label={strings.list.markEncrypted} />
                      </span>
                    ) : null}
                  </span>
                  <span className="za-row__meta">
                    {folder ? (
                      <>
                        <span className="za-row__folder">
                          <IconFolder size={11} aria-hidden="true" />
                          <span className="za-row__folder-name">{folder}</span>
                        </span>
                        {' · '}
                      </>
                    ) : null}
                    {strings.trash.deletedAt(shortDate(entry.deletedAt))}
                  </span>
                </span>
                <Button
                  className="za-row__action"
                  variant="text"
                  size="compact"
                  aria-label={strings.trash.restore}
                  title={strings.trash.restore}
                  iconStart={<IconRestore size={18} />}
                  onClick={() => void app.restoreFromTrash(entry.id)}
                >
                  {/* Подпись прячется в узкой колонке — см. `.za-row__action`
                      в app.css. Имя действия при этом остаётся: оно приходит
                      из `aria-label`, а не из текста. */}
                  <span className="za-row__action-label">{strings.trash.restore}</span>
                </Button>
              </div>
            );
          })
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
