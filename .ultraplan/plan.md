# Implementation Plan: довести ЗАПИСКИ до соответствия ТЗ

## Context
Поведенческое ТЗ не менялось — новое в пакете только `REBUILD.md` и `zapiski.css`; закрываем непокрытые старые требования и расхождение геометрии.

## Changes

### Геометрия по эталону (REBUILD §3: «кнопки высотой 44 и радиусом 14»)
- **File**: `packages/ui/src/styles/tokens.css:141`, `packages/ui/src/components/Button/Button.css`
- **Change**: завести `--r-btn: 14px` и дать его кнопке вместо `--r-lg` (сейчас 16). НЕ трогать `--r-md`: он `var(--radius-md)` из системы СИМПАС, правка задела бы чипы и плашки.
- **Reuses**: сторож `scripts/check-design-tokens.mjs` — образец сверки с эталоном

### Ссылка «История» с плашки конфликтов ведёт в пустоту
- **File**: `packages/app/src/screens/SettingsScreen.tsx:436`
- **Change**: передавать `conflicted[0].path`, а не `.id` — `VersionsScreen` принимает `VaultPath` и зовёт `vault.read(noteId)`
- **Reuses**: как в `packages/app/src/screens/InfoPanel.tsx:83`

### Сторож отрисованных размеров
- **File**: `scripts/check-measurements.mjs` (новый)
- **Change**: мерить в браузере кнопку 44/14, поле 44, строку списка 74/58, сайдбар 224/302, колонку 640; включить в `scripts/preflight.sh:56`

### Достижимость по BEHAVIOR §7 и §13
- **File**: `packages/app/src/App.tsx:120-160`, `packages/app/src/screens/CommandPalette.tsx`
- **Change**: закрыть находки аудитов (идут) — каждый хоткей работает И перечислен в палитре (критерий §13.8)

## Implementation Sequence
1. `SettingsScreen.tsx:436` — `.id` → `.path`, тест на переход в историю
2. `tokens.css` — радиусы по ролям; `scripts/check-measurements.mjs`; в преflight
3. Находки аудитов BEHAVIOR/SCREENS — по тяжести для пользователя, каждая с тестом достижимости
4. Живой прогон семи путей в браузере: онбординг · набор · папки · шифрование туда-обратно · поиск · экспорт-импорт · корзина

## Edge Cases & Risks
- **Критерий §13.3 против указания заказчика**: ТЗ требует «разметка проявляется без единого сдвига layout», я сделал схлопывание. Сдвиг теперь только при входе курсора в узел, при обычном наборе его нет. Нужно ваше слово; возврат — одна строка.
- **Слой `.zp-*` не подключаю**: 95 классов плоского CSS против 9 наших компонентов в 45 файлах; поведение (фокус, состояния, доступность) в плоском CSS не выражено. Приводим значения, классы оставляем.
- Правка радиусов трогает все кнопки — ловится сторожем размеров, а не глазами.

## Verification
`bash scripts/preflight.sh --dirty && node scripts/check-measurements.mjs`
