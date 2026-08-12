/**
 * Граница ошибки вокруг экрана.
 *
 * Во всём приложении не было ни одной: любая ошибка внутри любого экрана
 * гасила окно целиком и оставляла белый прямоугольник. На десктопе это хотя бы
 * видно в консоли; на телефоне консоли нет, и отказ неотличим от «кнопка не
 * работает» — ровно так и выглядела часть отзыва заказчика.
 *
 * Граница ставится вокруг СОДЕРЖИМОГО экрана, а не вокруг всего приложения:
 * упавший экран не должен уносить с собой навигацию, иначе человек остаётся в
 * тупике без единой кнопки.
 *
 * Классовый компонент здесь не выбор стиля: ловить ошибки рендера в React
 * умеет только он — хука с такой возможностью нет.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

import type { Strings } from '../i18n/index.js';

export interface ScreenBoundaryProps {
  strings: Strings;
  /** Меняется при переходе — по нему граница сбрасывается на новом экране. */
  resetKey: string;
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class ScreenBoundary extends Component<ScreenBoundaryProps, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  /**
   * Уход с упавшего экрана обязан его «расколдовать»: без сброса человек
   * возвращается к той же плашке даже там, где всё в порядке.
   */
  override componentDidUpdate(previous: ScreenBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    /* В консоль — полностью, человеку — спокойно. Стек в интерфейсе не
       помогает никому: починить его пользователь всё равно не может.
       Сообщение по-английски намеренно: это лог для разработчика, а не текст
       продукта, и в каталоге строк ему не место (инвариант 5). */
    console.error('ScreenBoundary caught an error:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const copy = this.props.strings.app;
    return (
      <div className="za-crash" role="alert">
        <h2 className="za-crash__title">{copy.crashed}</h2>
        <p className="za-crash__hint">{copy.crashedHint}</p>
        <button
          type="button"
          className="za-crash__retry"
          onClick={() => this.setState({ failed: false })}
        >
          {copy.crashedRetry}
        </button>
      </div>
    );
  }
}
