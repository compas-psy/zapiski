/**
 * Ячейки матрицы «экран × состояние» (BEHAVIOR §12) в виде готовых блоков.
 *
 * Правила из SCREENS §10: скелетоны вместо спиннеров везде, где скелетон
 * возможен; оффлайн — чип, а не блокирующий баннер; ошибка не блокирует ввод.
 */
import type { ReactElement, ReactNode } from 'react';
import { Button, EmptyState, SectionLabel, Skeleton, SkeletonList } from '@zapiski/ui';
import { IconLock, IconPen } from '@zapiski/ui';
import { useStrings } from '../state/context.js';

/** Скелетоны строк списка: заголовок 13 + две строки 10, без спиннеров. */
export function ListSkeleton({ rows = 7 }: { rows?: number }): ReactNode {
  const strings = useStrings();
  return <SkeletonList rows={rows} label={strings.app.loading} className="za-state" />;
}

/** Скелетон дерева библиотеки. */
export function TreeSkeleton(): ReactNode {
  const strings = useStrings();
  return (
    <div className="za-state" role="status" aria-busy="true" aria-label={strings.app.loading}>
      {[92, 74, 64, 84, 58].map((width, index) => (
        <div key={index} style={{ padding: '8px 4px' }}>
          <Skeleton variant="line" width={`${width}%`} />
        </div>
      ))}
    </div>
  );
}

/** Скелетон текста заметки — живёт не дольше 150 мс (BEHAVIOR §12). */
export function NoteSkeleton(): ReactNode {
  const strings = useStrings();
  return (
    <div className="za-editor__column" role="status" aria-busy="true" aria-label={strings.app.loading}>
      <Skeleton variant="title" width="58%" />
      {[96, 92, 88, 94, 70].map((width, index) => (
        <div key={index} style={{ paddingBlockStart: 10 }}>
          <Skeleton variant="line" width={`${width}%`} />
        </div>
      ))}
    </div>
  );
}

/**
 * Строки-плейсхолдеры для запертого списка (BEHAVIOR §12, ячейка
 * «Список заметок × Заперто»). Тон спокойный: замок без тревоги.
 */
export function LockedRows({ rows = 5 }: { rows?: number }): ReactNode {
  const strings = useStrings();
  return (
    <div className="za-state">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="za-row" style={{ cursor: 'default' }}>
          <span className="za-row__marks">
            <IconLock size={13} />
          </span>
          <span className="za-row__body">
            <span className="za-row__title">{strings.list.lockedPlaceholder}</span>
            <span className="za-row__snippet za-row__snippet--muted">{strings.list.encrypted}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export interface EmptyBlockProps {
  title: string;
  description?: string;
  /** Ровно одна кнопка — COMPONENTS §7. */
  action?: ReactElement;
  icon?: ReactNode;
}

export function EmptyBlock({ title, description, action, icon }: EmptyBlockProps): ReactNode {
  return (
    <EmptyState
      icon={icon ?? <IconPen size={24} />}
      title={title}
      {...(description ? { description } : {})}
      {...(action ? { action } : {})}
    />
  );
}

/**
 * Ошибка синка на экране списка: строка-статус с «Повторить».
 * Модалок нет — сетевые ошибки живут только в статусе (BEHAVIOR §0).
 */
export function InlineError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}): ReactNode {
  const strings = useStrings();
  return (
    <div className="za-state za-row-between" role="status">
      <span className="za-muted">{message}</span>
      {onRetry ? (
        <Button variant="text" size="compact" onClick={onRetry}>
          {strings.actions.retry}
        </Button>
      ) : null}
    </div>
  );
}

export function Section({ children }: { children: ReactNode }): ReactNode {
  return <SectionLabel className="za-section">{children}</SectionLabel>;
}
