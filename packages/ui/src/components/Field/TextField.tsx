import { useId, useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from '../../internal/cx';
import './Field.css';

type NativeInputProps = Omit<ComponentPropsWithRef<'input'>, 'size' | 'children'>;

export interface TextFieldProps extends NativeInputProps {
  /** Подпись поля. В формах длиннее двух полей плейсхолдер её не заменяет. */
  label?: ReactNode;
  /** Пояснение под полем (не ошибка). */
  hint?: ReactNode;
  /** Текст ошибки. Показывается ПОСЛЕ blur, не во время набора. */
  error?: ReactNode;
  /**
   * Показать ошибку немедленно (например, после submit), не дожидаясь blur.
   */
  showError?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Моноширинный ввод — почта, пути, коды (SCREENS.md §2). */
  mono?: boolean;
  className?: string;
}

export function TextField({
  label,
  hint,
  error,
  showError,
  leading,
  trailing,
  mono = false,
  className,
  id,
  disabled,
  onBlur,
  onChange,
  ...rest
}: TextFieldProps): ReactNode {
  const generatedId = useId();
  const inputId = id ?? `z-field-${generatedId}`;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  /* Ошибка живёт только после blur: во время набора текст не «кричит». */
  const [blurred, setBlurred] = useState(false);
  const invalid = Boolean(error) && (showError ?? blurred);

  const describedBy =
    [invalid ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div
      className={cx(
        'z-field',
        mono && 'z-field--mono',
        invalid && 'z-field--invalid',
        disabled && 'z-field--disabled',
        className,
      )}
    >
      {label ? (
        <label className="z-field__label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <div className="z-field__control">
        {leading ? <span className="z-field__affix">{leading}</span> : null}
        <input
          {...rest}
          id={inputId}
          disabled={disabled}
          className="z-field__input"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            setBlurred(false);
            onChange?.(event);
          }}
          onBlur={(event) => {
            setBlurred(true);
            onBlur?.(event);
          }}
        />
        {trailing ? <span className="z-field__affix">{trailing}</span> : null}
      </div>
      {invalid ? (
        <span className="z-field__message" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
      {hint && !invalid ? (
        <span className="z-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
