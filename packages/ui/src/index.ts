/**
 * @zapiski/ui — токены тем и библиотека компонентов ЗАПИСОК.
 *
 * Токены собираются из `design/tokens.json` — единственного артефакта
 * передачи «дизайн → код» (tz/ZAPISKI_TZ_3_Agents.md §6). Компоненты —
 * `Button`/`Badge`/`Card`/`Input`/`Separator`/`SegmentedControl`/`Icon`/
 * `ServiceMark` — построены на них и своих значений не заводят.
 *
 * Публичный API пакета — только этот файл (ARCHITECTURE.md §5).
 * Стили подключаются здесь же: смена темы работает без ререндера React.
 */
import './styles/index.css';

/* ── Тема ────────────────────────────────────────────────────────────────── */
export {
  ThemeProvider,
  useTheme,
  useOptionalTheme,
  type ThemeContextValue,
  type ThemeProviderProps,
} from './theme/ThemeProvider';
export {
  applyAppearance,
  editorCssVariables,
  parseAppearance,
  readStoredAppearance,
  writeStoredAppearance,
} from './theme/applyAppearance';
export { themeInitScript, themeInitScriptTag } from './theme/initScript';
export {
  ACCENTS,
  APPEARANCE_STORAGE_KEY,
  BASE_FONT_SIZE,
  BASE_LINE_HEIGHT,
  DEFAULT_APPEARANCE,
  DEFAULT_EDITOR_PREFERENCES,
  EDITOR_COLUMN_WIDTHS,
  EDITOR_FONT_SIZES,
  EDITOR_LINE_HEIGHTS,
  PANEL_PLACEMENTS,
  THEMES,
  THEME_PREFERENCES,
  resolveTheme,
  type Accent,
  type AppearanceState,
  type Density,
  type EditorColumnWidth,
  type EditorFontSize,
  type EditorLineHeight,
  type EditorPreferences,
  type PanelPlacement,
  type PanelSpot,
  type Theme,
  type ThemePreference,
  type Typeface,
} from './theme/types';

/* ── Кнопки ──────────────────────────────────────────────────────────────── */
export {
  Button,
  Fab,
  IconButton,
  type ButtonProps,
  type ButtonVariant,
  type ControlSize,
  type FabProps,
  type IconButtonProps,
} from './components/Button/Button';

/* ── Поля ввода ──────────────────────────────────────────────────────────── */
export { TextField, type TextFieldProps } from './components/Field/TextField';
export { SearchField, type SearchFieldProps } from './components/Field/SearchField';
export {
  CodeInput,
  PinDots,
  type CodeInputProps,
  type PinDotsProps,
} from './components/Field/CodeInput';

/* ── Чипы, теги, бейджи ──────────────────────────────────────────────────── */
export {
  Badge,
  ChipRow,
  FilterChip,
  Tag,
  type BadgeProps,
  type BadgeTone,
  type ChipRowProps,
  type FilterChipProps,
  type TagProps,
} from './components/Chip/Chip';

/* ── Переключатели ───────────────────────────────────────────────────────── */
export {
  Checkbox,
  Radio,
  RadioGroup,
  Switch,
  type CheckboxProps,
  type RadioGroupProps,
  type RadioProps,
  type SwitchProps,
} from './components/Toggle/Toggle';
export {
  SegmentedControl,
  type SegmentOption,
  type SegmentedControlProps,
} from './components/Toggle/SegmentedControl';

/* ── Списки ──────────────────────────────────────────────────────────────── */
export {
  List,
  ListRow,
  SectionLabel,
  type ListProps,
  type ListRowProps,
  type SectionLabelProps,
  type SwipeAction,
} from './components/List/ListRow';

/* ── Оверлеи ─────────────────────────────────────────────────────────────── */
export { BottomSheet, type BottomSheetProps } from './components/Overlay/BottomSheet';
export { Modal, type ModalProps } from './components/Overlay/Modal';
export { Drawer, type DrawerProps } from './components/Overlay/Drawer';
export {
  TOAST_DURATION_MS,
  Toast,
  ToastProvider,
  useToast,
  type ToastApi,
  type ToastOptions,
  type ToastProps,
  type ToastProviderProps,
} from './components/Overlay/Toast';
export { TOOLTIP_DELAY_MS, Tooltip, type TooltipProps } from './components/Overlay/Tooltip';

/* ── Обратная связь ──────────────────────────────────────────────────────── */
export { Spinner, type SpinnerProps } from './components/Feedback/Spinner';
export {
  EmptyState,
  InfoNote,
  Progress,
  Skeleton,
  SkeletonList,
  SyncDot,
  type EmptyStateProps,
  type InfoNoteProps,
  type NoteTone,
  type ProgressProps,
  type SkeletonListProps,
  type SkeletonProps,
  type SyncDotProps,
  type SyncStatus,
} from './components/Feedback/Feedback';

/* ── Специальные компоненты продукта ─────────────────────────────────────── */
export {
  Diff,
  DiffInline,
  EditorToolbar,
  MiniPlayer,
  TimecodeRow,
  Waveform,
  type DiffInlineProps,
  type DiffLine,
  type DiffLineType,
  type DiffProps,
  type EditorToolbarProps,
  type MiniPlayerProps,
  type TimecodeRowProps,
  type ToolbarItem,
  type WaveformProps,
} from './components/Special/Special';
export { Tree, type TreeNode, type TreeProps } from './components/Special/Tree';

/* ── Знак сервиса ────────────────────────────────────────────────────────── */
export {
  MIN_READABLE_SIZE,
  ServiceMark,
  type ServiceId,
  type ServiceMarkProps,
} from './components/ServiceMark/ServiceMark';

/* ── Иконки ──────────────────────────────────────────────────────────────── */
export * from './icons';

/* ── Витрина (артефакт приёмки) ──────────────────────────────────────────── */
export { Gallery } from './gallery/Gallery';
