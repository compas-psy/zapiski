/**
 * Поведенческие тесты библиотеки: то, что описано в COMPONENTS.md словами
 * («ошибка после blur», «Esc возвращает фокус», «один тост одновременно»),
 * должно быть проверяемо, а не только нарисовано.
 */
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../src/components/Button/Button';
import { TextField } from '../src/components/Field/TextField';
import { Modal } from '../src/components/Overlay/Modal';
import { ToastProvider, useToast } from '../src/components/Overlay/Toast';
import { SegmentedControl } from '../src/components/Toggle/SegmentedControl';
import { Checkbox, Switch } from '../src/components/Toggle/Toggle';
import { EmptyState } from '../src/components/Feedback/Feedback';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import { APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE } from '../src/theme/types';
import { editorCssVariables } from '../src/theme/applyAppearance';

/* jsdom не реализует matchMedia — подставляем управляемую заглушку. */
let prefersDark = false;
beforeEach(() => {
  prefersDark = false;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('dark') ? prefersDark : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-accent');
});
afterEach(cleanup);

describe('Button', () => {
  it('показывает подпись и переключается на процессную без потери обычной', () => {
    const { rerender } = render(<Button loadingLabel="Отправляем">Отправить</Button>);
    expect(screen.getByRole('button')).toHaveTextContent('Отправить');

    rerender(
      <Button loading loadingLabel="Отправляем">
        Отправить
      </Button>,
    );
    const button = screen.getByRole('button');
    /* Обе подписи остаются в разметке — ширина кнопки не прыгает. */
    expect(button.textContent).toContain('Отправить');
    expect(button.textContent).toContain('Отправляем');
    expect(button).toBeDisabled();
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});

describe('TextField', () => {
  it('не показывает ошибку во время набора и показывает после blur', () => {
    render(<TextField label="Почта" error="Похоже, в адресе опечатка" />);
    const input = screen.getByLabelText('Почта');

    fireEvent.change(input, { target: { value: 'marina@' } });
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.blur(input);
    expect(screen.getByRole('alert')).toHaveTextContent('Похоже, в адресе опечатка');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    /* Пользователь снова печатает — ошибка перестаёт «кричать». */
    fireEvent.change(input, { target: { value: 'marina@ya.ru' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Оверлеи', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Открыть
        </button>
        <Modal open={open} onClose={() => setOpen(false)} title="Восстановить версию?">
          <button type="button">Внутри</button>
        </Modal>
      </>
    );
  }

  it('Esc закрывает модалку и возвращает фокус на вызвавший элемент', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Открыть' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Восстановить версию?');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});

describe('Тост', () => {
  function Harness() {
    const toast = useToast();
    return (
      <>
        <button type="button" onClick={() => toast.show({ message: 'Первый' })}>
          Первый
        </button>
        <button type="button" onClick={() => toast.show({ message: 'Второй' })}>
          Второй
        </button>
      </>
    );
  }

  it('одновременно живёт только один: новый вытесняет предыдущий', () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Первый' }));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Второй' }));
    const toasts = screen.getAllByRole('status');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toHaveTextContent('Второй');
  });

  it('исчезает через 6 секунд', () => {
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <Harness />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Первый' }));
      expect(screen.getAllByRole('status')).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(6000);
      });
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Переключатели', () => {
  it('тумблер объявлен как switch, чекбокс — как checkbox', () => {
    render(
      <>
        <Switch label="Отпечаток" defaultChecked />
        <Checkbox label="Купить хлеб" />
      </>,
    );
    expect(screen.getByRole('switch', { name: 'Отпечаток' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Купить хлеб' })).not.toBeChecked();
  });

  it('сегментированный контрол ходит стрелками', () => {
    function Harness() {
      const [value, setValue] = useState('a');
      return (
        <SegmentedControl
          label="Режим"
          value={value}
          onChange={setValue}
          options={[
            { value: 'a', label: 'А' },
            { value: 'b', label: 'Б' },
            { value: 'c', label: 'В' },
          ]}
        />
      );
    }
    render(<Harness />);
    const first = screen.getByRole('radio', { name: 'А' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Б' })).toBeChecked();
  });
});

describe('Пустое состояние', () => {
  it('содержит ровно одну кнопку', () => {
    render(
      <EmptyState
        title="Здесь пока тихо"
        description="Первая мысль появится за две секунды"
        action={<Button>Написать заметку</Button>}
      />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

describe('ThemeProvider', () => {
  function Harness() {
    const { theme, setTheme, setAccent, setEditor } = useTheme();
    return (
      <>
        <span data-testid="theme">{theme}</span>
        <button type="button" onClick={() => setTheme('ink')}>
          Чернила
        </button>
        <button type="button" onClick={() => setAccent('pine')}>
          Хвоя
        </button>
        <button type="button" onClick={() => setEditor({ fontSize: 20, compact: true })}>
          Крупно
        </button>
      </>
    );
  }

  it('по умолчанию следует за системой: светлая ОС → paper', () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('paper');
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper');
    expect(document.documentElement.getAttribute('data-accent')).toBe('garnet');
  });

  it('тёмная ОС → graphite; ink выбирается только вручную', () => {
    prefersDark = true;
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('graphite');
    fireEvent.click(screen.getByRole('button', { name: 'Чернила' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('ink');
  });

  it('смена акцента и настроек редактора — только атрибуты и переменные', () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Хвоя' }));
    expect(document.documentElement.getAttribute('data-accent')).toBe('pine');

    fireEvent.click(screen.getByRole('button', { name: 'Крупно' }));
    const root = document.documentElement;
    expect(root.getAttribute('data-density')).toBe('compact');
    expect(root.style.getPropertyValue('--editor-font-scale')).toBe('1.25');
  });

  it('выбор пользователя переживает перезапуск', () => {
    const { unmount } = render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Чернила' }));
    unmount();

    const stored = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}');
    expect(stored.theme).toBe('ink');

    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('ink');
  });
});

describe('Настройки редактора как множители', () => {
  it('размер и интерлиньяж считаются относительно базовых 16 / 1.65', () => {
    expect(editorCssVariables(DEFAULT_APPEARANCE)['--editor-font-scale']).toBe('1');
    expect(
      editorCssVariables({
        ...DEFAULT_APPEARANCE,
        editor: { ...DEFAULT_APPEARANCE.editor, fontSize: 14, lineHeight: 1.45, columnWidth: 720 },
      }),
    ).toEqual({
      '--editor-font-scale': '0.875',
      '--editor-line-scale': '0.87879',
      '--editor-measure': '45rem',
    });
  });

  it('вся ширина отключает ограничение колонки', () => {
    expect(
      editorCssVariables({
        ...DEFAULT_APPEARANCE,
        editor: { ...DEFAULT_APPEARANCE.editor, columnWidth: 'full' },
      })['--editor-measure'],
    ).toBe('none');
  });
});
