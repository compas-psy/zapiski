/**
 * СГЕНЕРИРОВАННЫЙ ФАЙЛ — не редактировать руками.
 * Источник: packages/ui/src/styles/tokens.generated.css (из design/tokens.json),
 * тема «Бумага», акцент «Гранат».
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
  bg: '#FBFAF7',
  text: '#38342E',
  textSecondary: '#726C60',
  textTertiary: '#B6AFA2',
  surface: '#F3F1EA',
  line: '#EAE6DB',
  accent: '#B5503C',
  accentSoft: '#F6E7E2',
} as const;

/**
 * Семейства шрифтов для экспорта. Продуктовый шрифт указан первым: если он
 * установлен в системе, документ выглядит как в приложении; иначе работает
 * запасной стек. Встроить .woff2 в экспорт нельзя — файл должен оставаться
 * самодостаточным и лёгким.
 */
export const PRINT_FONTS = {
  serif: '"Source Serif 4", Georgia, "Iowan Old Style", serif',
  sans: '"Golos Text", "Segoe UI", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
} as const;
