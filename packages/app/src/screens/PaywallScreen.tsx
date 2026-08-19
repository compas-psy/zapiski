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
import { trialDaysFor } from '@zapiski/core';
import { Button, IconButton, IconCheck, IconClose } from '@zapiski/ui';
import { BILLING_ENABLED } from '@zapiski/core';
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
    { label: copy.rows.import, free: <Yes />, plus: <Yes /> },
    { label: copy.rows.ownStorage, free: <Yes />, plus: <Yes /> },
    { label: copy.rows.cloud, free: <No />, plus: copy.rows.cloudPlus },
    { label: copy.rows.versions, free: copy.rows.versionsFree, plus: copy.rows.versionsPlus },
    { label: copy.rows.publish, free: <No />, plus: <Yes /> },
    /* «Голос: на устройстве бесплатно, в облаке — по подписке» (мастер-ТЗ §5).
       Строка про голос стоит в таблице заранее и честно: сама фича — P1, а
       бесплатный столбец не пустой, поэтому обещанием тарифа она не является. */
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

        {/*
          Пока продукт бесплатный, кнопка ведёт ко входу и пробному периоду —
          платить не за что. Оплата включается тем же выключателем, что и весь
          раздел тарифов (`BILLING_ENABLED`): один флаг на обеих сторонах,
          чтобы не получилось «кнопка есть, а сервер отвечает 402».
        */}
        {BILLING_ENABLED ? (
          <Button fullWidth onClick={() => void app.startPayment(plan)}>
            {copy.pay}
          </Button>
        ) : (
          <Button fullWidth onClick={() => app.beginSignIn({ name: 'paywall' })}>
            {/* Срок — фактический, а не зашитый: до 01.09.2026 он тридцать дней,
              и кнопка не имеет права обещать меньше сделанного. */}
          {copy.trial(trialDaysFor(Date.now()))}
          </Button>
        )}
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
