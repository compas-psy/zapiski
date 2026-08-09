import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from '../../internal/cx';
import { IconClose, IconSearch } from '../../icons';
import './Field.css';

type NativeInputProps = Omit<ComponentPropsWithRef<'input'>, 'size' | 'children' | 'type'>;

export interface SearchFieldProps extends NativeInputProps {
  /** Подпись для скринридера (визуально скрыта). */
  label: string;
  /** Показывать крестик очистки, когда есть значение. */
  onClear?: () => void;
  /** Подпись кнопки очистки для скринридера. */
  clearLabel?: string;
  className?: string;
}

/** Поиск — «пилюля»: радиус full, фон --surface, лупа 15 слева (COMPONENTS.md §2). */
export function SearchField({
  label,
  onClear,
  clearLabel,
  className,
  id,
  value,
  ...rest
}: SearchFieldProps): ReactNode {
  const generatedId = useId();
  const inputId = id ?? `z-search-${generatedId}`;
  const hasValue = value !== undefined && value !== '';

  return (
    <div className={cx('z-field', 'z-search', className)}>
      <label className="z-visually-hidden" htmlFor={inputId}>
        {label}
      </label>
      <div className="z-field__control">
        <span className="z-field__affix">
          <IconSearch size={15} />
        </span>
        <input
          {...rest}
          id={inputId}
          value={value}
          type="search"
          role="searchbox"
          className="z-field__input"
        />
        {onClear && hasValue ? (
          <button
            type="button"
            className="z-search__clear"
            onClick={onClear}
            aria-label={clearLabel ?? label}
          >
            <IconClose size={14} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
