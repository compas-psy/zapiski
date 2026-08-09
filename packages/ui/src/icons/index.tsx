import type { ReactNode, SVGProps } from 'react';

/**
 * Единый набор иконок: viewBox 24, stroke 1.75 (--icon-stroke), round caps/joins,
 * currentColor (DESIGN_TOKENS.md §3). Иконки — декоративные по умолчанию:
 * подпись даёт вызывающий компонент через aria-label, внутри — aria-hidden.
 *
 * Набор намеренно минимальный: сюда входят только глифы, из которых состоят
 * сами компоненты (шеврон, галочка, крестик, лупа, play/pause) плюс несколько
 * общеупотребимых. Продуктовые иконки экраны передают пропсами.
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Размер в px; по умолчанию наследуется от --icon-list (15). */
  size?: number | string;
}

function Icon({ size, children, ...rest }: IconProps & { children: ReactNode }): ReactNode {
  const px = size ?? 'var(--icon-list)';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={px}
      height={px}
      fill="none"
      stroke="currentColor"
      strokeWidth="var(--icon-stroke)"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconChevronRight = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="m9.5 5 7 7-7 7" />
  </Icon>
);

export const IconChevronDown = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="m5 9.5 7 7 7-7" />
  </Icon>
);

export const IconCheck = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Icon>
);

export const IconClose = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const IconSearch = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m16.3 16.3 4.2 4.2" />
  </Icon>
);

export const IconPlus = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconPlay = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M8.5 5.5 18 12l-9.5 6.5V5.5Z" fill="currentColor" />
  </Icon>
);

export const IconPause = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M9.5 5.5v13M14.5 5.5v13" />
  </Icon>
);

export const IconLock = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="4.75" y="10.5" width="14.5" height="9.5" rx="2.5" />
    <path d="M8.5 10.5V7.75a3.5 3.5 0 0 1 7 0v2.75" />
  </Icon>
);

export const IconUnlock = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="4.75" y="10.5" width="14.5" height="9.5" rx="2.5" />
    <path d="M8.5 10.5V7.75a3.5 3.5 0 0 1 6.8-1.1" />
  </Icon>
);

export const IconPin = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M10 3.5h4l-.6 6 3.1 3.2H7.5l3.1-3.2-.6-6Z" />
    <path d="M12 12.7v7.8" />
  </Icon>
);

export const IconPaperclip = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M16.5 8 9.4 15.1a2.6 2.6 0 0 0 3.7 3.7l7.1-7.1a4.6 4.6 0 0 0-6.5-6.5l-7.1 7.1a6.6 6.6 0 0 0 9.3 9.3" />
  </Icon>
);

export const IconClock = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 1.8" />
  </Icon>
);

export const IconInfo = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11.2v4.8M12 8.2h.01" />
  </Icon>
);

export const IconAlert = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.8v4.9M12 16h.01" />
  </Icon>
);

export const IconPen = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="m4 20 1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z" />
  </Icon>
);

export const IconTrash = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M4.5 7h15M9.5 7V5.6A1.6 1.6 0 0 1 11.1 4h1.8a1.6 1.6 0 0 1 1.6 1.6V7" />
    <path d="m6.6 7 .8 12a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.8-12" />
  </Icon>
);

export const IconFolder = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h3.8l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V7.5Z" />
  </Icon>
);

export const IconHash = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M5.5 9h13M4.5 15h13M10.5 4 9 20M16 4l-1.5 16" />
  </Icon>
);

export const IconMic = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
  </Icon>
);

export const IconArrowLeft = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M19.5 12H4.5m0 0 6-6m-6 6 6 6" />
  </Icon>
);

export const IconMore = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M6 12h.01M12 12h.01M18 12h.01" />
  </Icon>
);

export const IconBold = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M7 5h6.2a3.4 3.4 0 0 1 0 6.8H7V5Zm0 6.8h7.2a3.6 3.6 0 0 1 0 7.2H7v-7.2Z" />
  </Icon>
);

export const IconItalic = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M15.5 5h-5m4.5 0-4 14m4 0h-5" />
  </Icon>
);

export const IconList = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M8.5 7h11M8.5 12h11M8.5 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" />
  </Icon>
);

export const IconCheckSquare = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M20 11.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
    <path d="m8.5 11.5 3 3 8-8.5" />
  </Icon>
);

export const IconImage = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4.5 17.5 4-4L14 19l2.5-2.5 3.5 3" />
  </Icon>
);

export const IconHeading = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M5 5v14M15 5v14M5 12h10" />
  </Icon>
);

export const IconSun = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
  </Icon>
);

export const IconMoon = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M20 14.2A8.5 8.5 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z" />
  </Icon>
);

export const IconRefresh = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5" />
  </Icon>
);
