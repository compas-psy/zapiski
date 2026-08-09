/**
 * Paywall ЗАПИСКИ+ — SCREENS §9 (`1u`).
 *
 * Запрещено и здесь отсутствует физически:
 *  • таймеры обратного отсчёта — на экране нет ни одного таймера;
 *  • предвыбранный годовой тариф без пометки — по умолчанию выбран месячный,
 *    у годового явная пометка выгоды;
 *  • скрытая кнопка закрытия — крестик виден всегда и первым в порядке обхода;
 *  • блокировка доступа к созданным заметкам — экран ничего не блокирует,
 *    закрывается в один тап и возвращает ровно туда, откуда пришли.
 */
import { useState, type ReactNode } from 'react';
import { Button, IconButton, IconCheck, IconClose } from '@zapiski/ui';
import { useApp, useStrings } from '../state/context.js';

type Plan = 'monthly' | 'yearly';

export function PaywallScreen(): ReactNode {
  const app = useApp();
  const strings = useStrings();
  /* Годовой НЕ предвыбран. */
  const [plan, setPlan] = useState<Plan>('monthly');
  const copy = strings.paywall;

  const rows: Array<{ label: string; free: ReactNode; plus: ReactNode }> = [
    { label: copy.rows.editor, free: <Yes />, plus: <Yes /> },
    { label: copy.rows.crypto, free: <Yes />, plus: <Yes /> },
    { label: copy.rows.export, free: <Yes />, plus: <Yes /> },
    { label: copy.rows.ownStorage, free: <Yes />, plus: <Yes /> },
    { label: copy.rows.cloud, free: <No />, plus: copy.rows.cloudPlus },
    { label: copy.rows.publish, free: <No />, plus: <Yes /> },
    { label: copy.rows.voice, free: copy.rows.voiceFree, plus: <Yes /> },
  ];

  return (
    <div className="za-screen">
      <div className="za-header">
        {/* Кнопка закрытия видима всегда. */}
        <IconButton
          icon={<IconClose size={20} />}
          label={strings.app.close}
          tone="ghost"
          onClick={() => app.back()}
        />
      </div>

      <div className="za-page za-stack">
        <span className="za-wordmark za-wordmark--plus">{strings.app.wordmarkPlus}</span>
        <p className="za-muted">{copy.subtitle}</p>
        <p className="za-h2">{copy.price}</p>

        <div className="za-stack za-stack--tight">
          <button
            type="button"
            className={`za-card${plan === 'monthly' ? ' za-card--selected' : ''}`}
            aria-pressed={plan === 'monthly'}
            onClick={() => setPlan('monthly')}
          >
            <span className="za-card__title">{copy.monthly}</span>
          </button>
          <button
            type="button"
            className={`za-card${plan === 'yearly' ? ' za-card--selected' : ''}`}
            aria-pressed={plan === 'yearly'}
            onClick={() => setPlan('yearly')}
          >
            <span className="za-row-between">
              <span className="za-card__title">{copy.yearly}</span>
              {/* Явная пометка — без неё годовой тариф выбирать нельзя. */}
              <span className="za-chip za-chip--accent">{copy.yearlyNote}</span>
            </span>
          </button>
        </div>

        <table className="za-table">
          <caption className="z-visually-hidden">{copy.tableLabel}</caption>
          <thead>
            <tr>
              <th scope="col">{copy.columns.feature}</th>
              <th scope="col">{copy.columns.free}</th>
              <th scope="col">{copy.columns.plus}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.free}</td>
                <td>{row.plus}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <Button fullWidth onClick={() => app.navigate({ name: 'signin' })}>
          {copy.trial}
        </Button>
        <p className="za-muted">{copy.honest}</p>
        <p className="za-tertiary-mono">{copy.bundle}</p>
      </div>
    </div>
  );

  function Yes(): ReactNode {
    return <IconCheck size={16} aria-label={copy.yes} />;
  }
  function No(): ReactNode {
    return <span aria-label={copy.no}>—</span>;
  }
}
