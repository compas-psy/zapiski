/**
 * Сегментированный контрол.
 *
 * `SegmentedControl` — компонент
 * дизайн-системы ЗАПИСОК: состав библиотеки пережил смену палитры
 * (DS-ALIGNMENT §8 в этой части остался в силе), поменялись значения под ним.
 * Значения не выдумываются: всё построено на токенах из design/tokens.json.
 */
import { useRef, type ReactNode } from 'react';
import { cx } from '../../internal/cx';
import './Toggle.css';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Подпись группы для скринридера. */
  label: string;
  className?: string;
}

/**
 * Сегментированный контрол — COMPONENTS.md §4: контейнер --surface радиус 10,
 * паддинг 3, активный сегмент радиус 8 с тенью, бегунок 200 мс.
 * Клавиатура: стрелки перемещают выбор (паттерн radiogroup).
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: SegmentedControlProps<T>): ReactNode {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const count = Math.max(1, options.length);

  const move = (delta: number): void => {
    for (let step = 1; step <= count; step += 1) {
      const next = (index + delta * step + count * count) % count;
      const option = options[next];
      if (option && !option.disabled) {
        onChange(option.value);
        refs.current[next]?.focus();
        return;
      }
    }
  };

  return (
    <div className={cx('z-segmented', className)} role="radiogroup" aria-label={label}>
      <span
        className="z-segmented__indicator"
        aria-hidden="true"
        style={{
          inlineSize: `calc((100% - 6px) / ${count})`,
          transform: `translateX(calc(${index} * 100%))`,
        }}
      />
      {options.map((option, optionIndex) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[optionIndex] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={option.disabled}
            className={cx('z-segmented__option', active && 'z-segmented__option--active')}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                move(1);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                move(-1);
              }
            }}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
