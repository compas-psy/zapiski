/**
 * Продуктовые иконки экранов.
 *
 * `@zapiski/ui` намеренно держит только глифы, из которых состоят сами
 * компоненты, и предлагает экранам передавать остальные пропсами
 * (`packages/ui/src/icons/index.tsx`). Здесь ровно те, которых там нет.
 *
 * Правила набора — DESIGN_TOKENS §3: viewBox 24, stroke 1.75 из токена,
 * round caps/joins, `currentColor`, декоративные по умолчанию.
 */
import type { ReactNode, SVGProps } from 'react';

export interface AppIconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number | string;
}

function Glyph({ size, children, ...rest }: AppIconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size ?? 'var(--icon-list)'}
      height={size ?? 'var(--icon-list)'}
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

/** Бургер — открывает библиотеку (SCREENS §3). */
export const IconMenu = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Glyph>
);

export const IconArchive = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <path d="M3 7h18v3H3zM5 10v9h14v-9M10 14h4" />
  </Glyph>
);

export const IconSettings = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2M12 19v2M21 12h-2M5 12H3M18.4 5.6l-1.4 1.4M7 17l-1.4 1.4M18.4 18.4 17 17M7 7 5.6 5.6" />
  </Glyph>
);

export const IconQuote = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <path d="M6 6v12M10 9h9M10 15h9" />
  </Glyph>
);

export const IconCode = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <path d="m9 8-5 4 5 4M15 8l5 4-5 4" />
  </Glyph>
);

export const IconTable = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 10h18M9 10v9" />
  </Glyph>
);

/** Разделитель `---`. */
export const IconRule = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <path d="M4 12h16" />
  </Glyph>
);

export const IconLink = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <path d="M10 13a4 4 0 0 0 5.7.3l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2" />
    <path d="M14 11a4 4 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" />
  </Glyph>
);

export const IconFootnote = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <path d="M6 5h9M6 10h12M6 15h7M17 13v6M15 16h4" />
  </Glyph>
);

export const IconWikiLink = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <path d="M8 5 5 12l3 7M16 5l3 7-3 7M13 6l-2 12" />
  </Glyph>
);

/** Отпечаток пальца — биометрия (SCREENS §7 `2f`). */
export const IconFingerprint = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <path d="M12 4a8 8 0 0 1 8 8v2" />
    <path d="M4 12a8 8 0 0 1 4-6.9" />
    <path d="M8 12a4 4 0 0 1 8 0v4" />
    <path d="M12 12v5" />
    <path d="M6 18c1.2-1.4 2-3.4 2-6" />
    <path d="M16 20c.6-1.2 1-2.6 1-4" />
  </Glyph>
);

/** Стрелка «наружу» — deep link в КОМПАС.Дневник (SCREENS §4). */
export const IconExternal = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <path d="M14 5h5v5M19 5l-8 8" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Glyph>
);

export const IconDownload = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <path d="M12 4v11M8 11l4 4 4-4M5 19h14" />
  </Glyph>
);

export const IconUpload = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <path d="M12 20V9M8 12l4-4 4 4M5 5h14" />
  </Glyph>
);

export const IconCopy = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h8" />
  </Glyph>
);

export const IconMerge = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <path d="M7 4v6a4 4 0 0 0 4 4h6" />
    <path d="M14 11l3 3-3 3" />
    <path d="M7 14v6" />
  </Glyph>
);

export const IconMove = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <path d="M4 8V6a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6" />
    <path d="M3 16h7M7 13l3 3-3 3" />
  </Glyph>
);

export const IconBug = (p: AppIconProps): ReactNode => (
  <Glyph {...p}>
    <rect x="8" y="7" width="8" height="12" rx="4" />
    <path d="M4 11h4M16 11h4M4 17h4M16 17h4M9 7 8 4M15 7l1-3" />
  </Glyph>
);
