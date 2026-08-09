/**
 * `ServiceMark` — знак сервиса.
 *
 * РЕАЛИЗАЦИЯ ДО ПОЯВЛЕНИЯ ПАКЕТА СИМПАС. В системе есть свой `ServiceMark`
 * (DS-ALIGNMENT §8), но пакет `@simpas/design-system` пока недоступен.
 * Соответствие API и план замены — packages/ui/DS-MAPPING.md.
 *
 * Правила из DS-ALIGNMENT §9 и `ds/zapiski-handoff.md` §2, §6:
 *   · файл `assets/services/zapiski.svg` берётся КАК ЕСТЬ — ни обрезки, ни
 *     перерисовки, ни добавления элементов. Поэтому здесь `<img>`, а не
 *     инлайн-JSX: инлайн неизбежно провоцирует «поправить путь»;
 *   · плитка 500×500, скругление 140, дерево занимает 0.74 стороны —
 *     всё это внутри файла, снаружи мы только масштабируем;
 *   · плитка ЗАПИСОК тёмная, поэтому внутренняя обводка НЕ ставится;
 *   · фон плитки — плашка: ни градиентов, ни теней, ни бликов внутри;
 *   · внутри плитки никаких надписей — имя живёт под иконкой;
 *   · знак читается на 28 px, ниже ветви кроны слипаются в пятно — размер
 *     меньше MIN_READABLE_SIZE считается ошибкой употребления.
 *
 * Терракота попадает на экран только отсюда (и из трёх других разрешённых
 * мест) — как `--svc-zapiski-bg` внутри самого файла знака. В интерфейсных
 * токенах её нет.
 */
import type { ReactNode } from 'react';
import { cx } from '../../internal/cx';
import zapiskiMark from '../../assets/services/zapiski.svg';
import './ServiceMark.css';

/** Ниже этого размера крона знака перестаёт читаться (handoff §6). */
export const MIN_READABLE_SIZE = 28;

/** Пока сервис у нас один. Список расширяется вместе с `services.css`. */
export type ServiceId = 'zapiski';

const MARKS: Record<ServiceId, string> = { zapiski: zapiskiMark };

export interface ServiceMarkProps {
  service?: ServiceId;
  /** Сторона плитки в px. По умолчанию 28 — минимальный читаемый размер. */
  size?: number;
  /**
   * Подпись для скринридера. Знак почти всегда декоративен (имя продукта
   * стоит рядом текстом), поэтому по умолчанию он `aria-hidden`.
   */
  label?: string;
  className?: string;
}

export function ServiceMark({
  service = 'zapiski',
  size = MIN_READABLE_SIZE,
  label,
  className,
}: ServiceMarkProps): ReactNode {
  return (
    <img
      src={MARKS[service]}
      width={size}
      height={size}
      alt={label ?? ''}
      aria-hidden={label ? undefined : true}
      draggable={false}
      className={cx('z-service-mark', className)}
    />
  );
}
