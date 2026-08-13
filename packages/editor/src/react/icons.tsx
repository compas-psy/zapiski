/**
 * Иконки тулбара: единый набор, stroke 1.75, viewBox 24, round caps/joins,
 * `currentColor` (DESIGN_TOKENS §3). Размер задаётся снаружи — в тулбаре 19.
 */

import type { ReactElement } from 'react';

interface IconProps {
  size?: number;
}

function Svg({ size = 19, children }: IconProps & { children: React.ReactNode }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconHeading = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M6 4v16M18 4v16M6 12h12" />
  </Svg>
);

export const IconBold = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />
  </Svg>
);

export const IconItalic = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M15 5h-5M14 19H9M14.5 5 10 19" />
  </Svg>
);

export const IconList = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
  </Svg>
);

export const IconTask = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
    <path d="M8 12.2 10.8 15 16 9.4" />
  </Svg>
);

export const IconPhoto = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="4" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4 17 4.5-4.2a2 2 0 0 1 2.7 0L20 19" />
  </Svg>
);

export const IconVoice = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
  </Svg>
);

export const IconMore = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M5.5 12h.01M12 12h.01M18.5 12h.01" />
  </Svg>
);

export const IconQuote = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M4 6v12M9 8.5c-1.6 0-2.5 1-2.5 2.3S7.4 13 8.6 13c-.2 1.6-1.2 2.4-2.4 2.6M16 8.5c-1.6 0-2.5 1-2.5 2.3s.9 2.2 2.1 2.2c-.2 1.6-1.2 2.4-2.4 2.6" />
  </Svg>
);

export const IconCode = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="m8.5 8-4.5 4 4.5 4M15.5 8l4.5 4-4.5 4" />
  </Svg>
);

export const IconTable = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <path d="M3.5 9.5h17M9.5 9.5v10" />
  </Svg>
);

export const IconDivider = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M4 12h16M6 7h12M6 17h12" />
  </Svg>
);

export const IconLink = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.2 1.2M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.2-1.2" />
  </Svg>
);

export const IconFootnote = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M4 6h9M4 12h9M4 18h13" />
    <path d="M17 4.5c1.6 0 2.4.8 2.4 1.9 0 1.7-2.6 1.9-2.6 3.6" />
  </Svg>
);

export const IconWiki = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M9 4H6.5v16H9M15 4h2.5v16H15" />
    <path d="M12 9v6" />
  </Svg>
);

/**
 * Выравнивание колонки таблицы: три полосы, укороченная — с той стороны,
 * куда прижимается текст. Живёт здесь, а не в панели, потому что рисуется
 * в двух местах: в панели и в редакторе таблицы, — и две копии одного глифа
 * рано или поздно разъезжаются.
 */
export const IconAlign = ({
  side,
  ...p
}: IconProps & { side: 'left' | 'center' | 'right' }): ReactElement => (
  <Svg {...p}>
    <path
      d={
        side === 'left'
          ? 'M4 7h16M4 12h10M4 17h13'
          : side === 'right'
            ? 'M4 7h16M10 12h10M7 17h13'
            : 'M4 7h16M7 12h10M6 17h12'
      }
    />
  </Svg>
);
