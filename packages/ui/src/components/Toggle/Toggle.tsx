import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from '../../internal/cx';
import './Toggle.css';

type NativeInput = Omit<ComponentPropsWithRef<'input'>, 'type' | 'children' | 'size'>;

/* ── Тумблер ─────────────────────────────────────────────────────────────── */

export interface SwitchProps extends NativeInput {
  /** Видимая подпись. Если её нет — обязателен aria-label. */
  label?: ReactNode;
  className?: string;
}

export function Switch({ label, className, disabled, id, ...rest }: SwitchProps): ReactNode {
  const generated = useId();
  const inputId = id ?? `z-switch-${generated}`;
  return (
    <label
      className={cx('z-switch', disabled && 'z-switch--disabled', className)}
      htmlFor={inputId}
    >
      <input
        {...rest}
        id={inputId}
        type="checkbox"
        role="switch"
        disabled={disabled}
        className={cx('z-switch__input', 'z-visually-hidden')}
      />
      <span className="z-switch__track" aria-hidden="true">
        <span className="z-switch__thumb" />
      </span>
      {label ? <span className="z-switch__label">{label}</span> : null}
    </label>
  );
}

/* ── Чекбокс ─────────────────────────────────────────────────────────────── */

export interface CheckboxProps extends NativeInput {
  label?: ReactNode;
  /** Зачёркивать подпись, когда отмечено (списки задач в заметке). */
  strikeWhenChecked?: boolean;
  className?: string;
}

export function Checkbox({
  label,
  strikeWhenChecked = false,
  className,
  disabled,
  id,
  ...rest
}: CheckboxProps): ReactNode {
  const generated = useId();
  const inputId = id ?? `z-check-${generated}`;
  return (
    <label
      className={cx(
        'z-check',
        strikeWhenChecked && 'z-check--strike',
        disabled && 'z-check--disabled',
        className,
      )}
      htmlFor={inputId}
    >
      <input
        {...rest}
        id={inputId}
        type="checkbox"
        disabled={disabled}
        className={cx('z-check__input', 'z-visually-hidden')}
      />
      <span className="z-check__box" aria-hidden="true">
        <svg className="z-check__mark" viewBox="0 0 18 18">
          <path d="M4 9.3 7.3 12.6 14 5.6" />
        </svg>
      </span>
      {label ? <span className="z-check__label">{label}</span> : null}
    </label>
  );
}

/* ── Радио ───────────────────────────────────────────────────────────────── */

export interface RadioProps extends NativeInput {
  label?: ReactNode;
  className?: string;
}

export function Radio({ label, className, disabled, id, ...rest }: RadioProps): ReactNode {
  const generated = useId();
  const inputId = id ?? `z-radio-${generated}`;
  return (
    <label className={cx('z-radio', disabled && 'z-radio--disabled', className)} htmlFor={inputId}>
      <input
        {...rest}
        id={inputId}
        type="radio"
        disabled={disabled}
        className={cx('z-radio__input', 'z-visually-hidden')}
      />
      <span className="z-radio__dot" aria-hidden="true" />
      {label ? <span className="z-radio__label">{label}</span> : null}
    </label>
  );
}

export interface RadioGroupProps {
  /** Подпись группы для скринридера. */
  label: string;
  children: ReactNode;
  className?: string;
}

export function RadioGroup({ label, children, className }: RadioGroupProps): ReactNode {
  return (
    <div className={cx('z-radio-group', className)} role="radiogroup" aria-label={label}>
      {children}
    </div>
  );
}
