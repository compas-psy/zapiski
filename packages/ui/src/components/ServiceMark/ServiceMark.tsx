/**
 * `ServiceMark` — знак сервиса.
 *
 * Правила из DS-ALIGNMENT §9 (в части знака и имени они остались в силе)
 * и `ds/zapiski-handoff.md` §2, §6:
 *   · файл `assets/services/zapiski.svg` берётся КАК ЕСТЬ — ни обрезки, ни
 *     перерисовки, ни добавления элементов. Поэтому здесь `<img>`, а не
 *     инлайн-JSX: инлайн неизбежно провоцирует «поправить путь»;
 *   · плитка 500×500, скругление 140, дерево занимает 0.74 стороны —
 *     всё это внутри файла, снаружи мы только масштабируем;
 *   · плитка ЗАПИСОК гранатовая (Р5: «акцент Гранат везде, включая иконку»),
 *     тёмная — поэтому внутренняя обводка НЕ ставится;
 *   · фон плитки — плашка: ни градиентов, ни теней, ни бликов внутри;
 *   · внутри плитки никаких надписей — имя живёт под иконкой;
 *   · знак читается на 28 px, ниже ветви кроны слипаются в пятно — размер
 *     меньше MIN_READABLE_SIZE считается ошибкой употребления.
 *
 * Гранат плитки задан литералом в `design/tokens.json`
 * (`color.brand.svc-zapiski-bg`), а не через `var(--accent)`: бренд не
 * меняется вместе с пользовательским выбором акцента.
 */
import type { ReactNode } from 'react';
import { cx } from '../../internal/cx';
import './ServiceMark.css';

/**
 * Адрес файла знака. `new URL(…, import.meta.url)` вместо `import … from '*.svg'`
 * намеренно: это стандартный ESM, который Vite статически переписывает в адрес
 * эмитированного ассета, и он не требует ambient-объявления модуля `*.svg` —
 * иначе такое объявление пришлось бы дублировать в КАЖДОМ пакете-потребителе
 * (packages/app, apps/web, apps/desktop, apps/mobile).
 */
const ZAPISKI_MARK = new URL('../../assets/services/zapiski.svg', import.meta.url).href;

/** Ниже этого размера крона знака перестаёт читаться (handoff §6). */
export const MIN_READABLE_SIZE = 28;

/** Пока сервис у нас один. Список расширяется вместе с `services.css`. */
export type ServiceId = 'zapiski';

const MARKS: Record<ServiceId, string> = { zapiski: ZAPISKI_MARK };

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
