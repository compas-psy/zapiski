import { useId, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../internal/cx';
import './Field.css';

export interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Количество ячеек. По умолчанию 6. */
  length?: number;
  /** Подпись группы для скринридера. */
  label: string;
  /** Скрывать символы (пароль). */
  masked?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onComplete?: (value: string) => void;
  className?: string;
  /** Что подставить вместо символа при masked. По умолчанию «•». */
  maskChar?: string;
}

/** Ячейки кода/пароля 38×48, радиус 11; активная — рамка 1.5 акцент + курсор 2 px. */
export function CodeInput({
  value,
  onChange,
  length = 6,
  label,
  masked = false,
  invalid = false,
  disabled = false,
  autoFocus = false,
  onComplete,
  className,
  maskChar = '•',
}: CodeInputProps): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const id = useId();
  const activeIndex = Math.min(value.length, length - 1);

  return (
    <div
      className={cx('z-code', invalid && 'z-code--invalid', className)}
      role="group"
      aria-label={label}
      onClick={() => inputRef.current?.focus()}
    >
      <input
        ref={inputRef}
        id={`z-code-${id}`}
        className="z-code__input"
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        maxLength={length}
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label={label}
        aria-invalid={invalid || undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => {
          const next = event.target.value.slice(0, length);
          onChange(next);
          if (next.length === length) onComplete?.(next);
        }}
      />
      {Array.from({ length }, (_, index) => {
        const char = value[index];
        const isActive = focused && index === activeIndex && !disabled;
        return (
          <div
            key={index}
            className={cx('z-code__cell', isActive && 'z-code__cell--active')}
            aria-hidden="true"
          >
            {char ? (masked ? maskChar : char) : isActive ? <i className="z-code__caret" /> : null}
          </div>
        );
      })}
    </div>
  );
}

export interface PinDotsProps {
  /** Сколько точек заполнено. */
  filled: number;
  length?: number;
  /** Подпись для скринридера. */
  label: string;
  className?: string;
}

/** Шесть точек ввода 12 px на экране «заперто» (SCREENS.md §7). */
export function PinDots({ filled, length = 6, label, className }: PinDotsProps): ReactNode {
  return (
    <div className={cx('z-pin', className)} role="img" aria-label={label}>
      {Array.from({ length }, (_, index) => (
        <span key={index} className={cx('z-pin__dot', index < filled && 'z-pin__dot--filled')} />
      ))}
    </div>
  );
}
