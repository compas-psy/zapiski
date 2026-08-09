/**
 * СГЕНЕРИРОВАННЫЙ ФАЙЛ — не редактировать руками.
 * Источник: packages/ui/src/styles/tokens.css + снимок дизайн-системы СИМПАС
 * (styles/simpas/vendor/tokens/colors.css), тема «СИМПАС», акцент «Хвоя».
 * Обновить: node scripts/gen-print-palette.mjs
 *
 * Палитра для экспорта в HTML/PDF/DOCX. Экспортный документ покидает
 * приложение и не может ссылаться на рантайм-токены темы, поэтому цвета здесь
 * литеральные. Чтобы они не разъезжались с дизайн-системой, файл выводится из
 * токенов, а тест export-palette.test.ts падает, если его забыли пересобрать.
 *
 * BEHAVIOR §9: экспорт всегда в светлой теме, колонка 640,
 * без интерфейсных элементов.
 */

export const PRINT_PALETTE = {
  bg: '#F7F8F4',
  text: '#142018',
  textSecondary: '#5F6C64',
  textTertiary: '#7E8A83',
  surface: '#FFFFFF',
  line: '#E4E9E3',
  accent: '#1D4735',
  accentSoft: '#E7F0EA',
} as const;

/**
 * Семейства шрифтов для экспорта. Продуктовый шрифт указан первым: если он
 * установлен в системе, документ выглядит как в приложении; иначе работает
 * запасной стек. Встроить .woff2 в экспорт нельзя — файл должен оставаться
 * самодостаточным и лёгким.
 */
export const PRINT_FONTS = {
  serif: '"Source Serif 4", Georgia, "Iowan Old Style", serif',
  sans: 'Geist, "Segoe UI", system-ui, sans-serif',
  mono: '"Geist Mono", ui-monospace, SFMono-Regular, monospace',
} as const;
