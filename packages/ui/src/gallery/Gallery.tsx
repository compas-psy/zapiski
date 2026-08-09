import { useState, type ReactNode } from 'react';
import { cx } from '../internal/cx';
import { ThemeProvider, useOptionalTheme, useTheme } from '../theme/ThemeProvider';
import {
  ACCENTS,
  EDITOR_FONT_SIZES,
  EDITOR_LINE_HEIGHTS,
  type Accent,
  type EditorColumnWidth,
  type EditorFontSize,
  type EditorLineHeight,
  type ThemePreference,
} from '../theme/types';
import { Button, IconButton } from '../components/Button/Button';
import { TextField } from '../components/Field/TextField';
import { SearchField } from '../components/Field/SearchField';
import { CodeInput, PinDots } from '../components/Field/CodeInput';
import { Badge, ChipRow, FilterChip, Tag } from '../components/Chip/Chip';
import { Checkbox, Radio, RadioGroup, Switch } from '../components/Toggle/Toggle';
import { SegmentedControl } from '../components/Toggle/SegmentedControl';
import { List, ListRow, SectionLabel } from '../components/List/ListRow';
import { BottomSheet } from '../components/Overlay/BottomSheet';
import { Modal } from '../components/Overlay/Modal';
import { Drawer } from '../components/Overlay/Drawer';
import { ToastProvider, useToast } from '../components/Overlay/Toast';
import { Tooltip } from '../components/Overlay/Tooltip';
import { Spinner } from '../components/Feedback/Spinner';
import {
  EmptyState,
  InfoNote,
  Progress,
  Skeleton,
  SkeletonList,
  SyncDot,
} from '../components/Feedback/Feedback';
import {
  Diff,
  DiffInline,
  EditorToolbar,
  MiniPlayer,
  TimecodeRow,
  Waveform,
} from '../components/Special/Special';
import { Tree } from '../components/Special/Tree';
import {
  IconBold,
  IconCheckSquare,
  IconClose,
  IconFolder,
  IconHash,
  IconHeading,
  IconImage,
  IconInfo,
  IconItalic,
  IconList,
  IconLock,
  IconMic,
  IconMore,
  IconPaperclip,
  IconPen,
  IconPin,
  IconSearch,
} from '../icons';
import './Gallery.css';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Системная' },
  { value: 'paper', label: 'Бумага' },
  { value: 'graphite', label: 'Графит' },
  { value: 'ink', label: 'Чернила' },
];

const ACCENT_TITLES: Record<Accent, string> = {
  garnet: 'Гранат',
  pine: 'Хвоя',
  gold: 'Золото',
  blueberry: 'Черника',
  heather: 'Вереск',
  slate: 'Грифель',
};

const SURFACE_TOKENS = [
  '--bg',
  '--surface',
  '--surface-alt',
  '--line',
  '--line-soft',
  '--accent',
  '--accent-soft',
  '--success-soft',
  '--warning-soft',
  '--danger-soft',
  '--info-soft',
];

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="z-gallery__section">
      <h2 className="z-gallery__section-title">{title}</h2>
      {note ? <p className="z-gallery__note">{note}</p> : null}
      {children}
    </section>
  );
}

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="z-gallery__panel">
      <div className="z-gallery__label">{label}</div>
      <div className="z-gallery__stack" style={{ marginBlockStart: 'var(--sp-12)' }}>
        {children}
      </div>
    </div>
  );
}

/* ── Панель управления темой ─────────────────────────────────────────────── */

function ControlBar(): ReactNode {
  const { preference, accent, editor, setTheme, setAccent, setEditor, theme } = useTheme();
  return (
    <div className="z-gallery__bar">
      <div className="z-gallery__control">
        <span className="z-gallery__control-label">Тема · применена «{theme}»</span>
        <SegmentedControl
          label="Тема"
          options={THEME_OPTIONS}
          value={preference}
          onChange={setTheme}
        />
      </div>
      <div className="z-gallery__control">
        <span className="z-gallery__control-label">Акцент</span>
        <div className="z-gallery__accents">
          {ACCENTS.map((name) => (
            <button
              key={name}
              type="button"
              data-accent={name}
              aria-label={ACCENT_TITLES[name]}
              aria-pressed={accent === name}
              title={ACCENT_TITLES[name]}
              className={cx('z-gallery__accent', accent === name && 'z-gallery__accent--active')}
              onClick={() => setAccent(name)}
            />
          ))}
        </div>
      </div>
      <div className="z-gallery__control">
        <span className="z-gallery__control-label">Размер текста</span>
        <SegmentedControl
          label="Размер текста заметки"
          options={EDITOR_FONT_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
          value={String(editor.fontSize)}
          onChange={(value) => setEditor({ fontSize: Number(value) as EditorFontSize })}
        />
      </div>
      <div className="z-gallery__control">
        <span className="z-gallery__control-label">Интерлиньяж</span>
        <SegmentedControl
          label="Интерлиньяж"
          options={EDITOR_LINE_HEIGHTS.map((value) => ({
            value: String(value),
            label: String(value),
          }))}
          value={String(editor.lineHeight)}
          onChange={(value) => setEditor({ lineHeight: Number(value) as EditorLineHeight })}
        />
      </div>
      <div className="z-gallery__control">
        <span className="z-gallery__control-label">Колонка</span>
        <SegmentedControl
          label="Ширина колонки"
          options={[
            { value: '640', label: '640' },
            { value: '720', label: '720' },
            { value: 'full', label: 'вся' },
          ]}
          value={String(editor.columnWidth)}
          onChange={(value) =>
            setEditor({
              columnWidth: (value === 'full' ? 'full' : Number(value)) as EditorColumnWidth,
            })
          }
        />
      </div>
      <div className="z-gallery__control">
        <span className="z-gallery__control-label">Гарнитура и плотность</span>
        <div className="z-gallery__row">
          <Switch
            label="Serif"
            checked={editor.typeface === 'serif'}
            onChange={(event) => setEditor({ typeface: event.target.checked ? 'serif' : 'sans' })}
          />
          <Switch
            label="Компактный режим"
            checked={editor.compact}
            onChange={(event) => setEditor({ compact: event.target.checked })}
          />
        </div>
      </div>
    </div>
  );
}

/* ── Разделы ─────────────────────────────────────────────────────────────── */

function ButtonsSection(): ReactNode {
  const [loading, setLoading] = useState(false);
  return (
    <Section
      title="1 · Кнопки"
      note="Радиус 14, высота 44 (компактная 36), паддинг 11×22, вес 600. Hover, press (scale .97) и кольцо фокуса проверяются вживую: наведите мышь и пройдите по Tab."
    >
      <div className="z-gallery__grid">
        <Panel label="Варианты">
          <div className="z-gallery__row">
            <Button variant="primary">Основная</Button>
            <Button variant="secondary">Вторичная</Button>
            <Button variant="outline">Контурная</Button>
          </div>
          <div className="z-gallery__row">
            <Button variant="text">Текстовая</Button>
            <Button variant="destructive">Удалить заметку</Button>
            <IconButton icon={<IconMore size={19} />} label="Ещё" />
          </div>
        </Panel>
        <Panel label="Состояния">
          <div className="z-gallery__row">
            <Button disabled>Недоступна</Button>
            <Button variant="secondary" disabled>
              Недоступна
            </Button>
            <IconButton icon={<IconPin size={19} />} label="Закрепить" disabled />
          </div>
          <div className="z-gallery__row">
            <Button loading={loading} loadingLabel="Отправляем" onClick={() => setLoading(!loading)}>
              Отправить ссылку
            </Button>
            <span className="z-gallery__label">
              ширина не меняется при переключении загрузки
            </span>
          </div>
        </Panel>
        <Panel label="Компактные 36 и на всю ширину">
          <div className="z-gallery__row">
            <Button size="compact">Компактная</Button>
            <Button size="compact" variant="secondary">
              Компактная
            </Button>
            <IconButton size="compact" icon={<IconSearch size={17} />} label="Найти" />
          </div>
          <Button fullWidth iconStart={<IconPen size={17} />}>
            Новая заметка
          </Button>
        </Panel>
      </div>
    </Section>
  );
}

function FieldsSection(): ReactNode {
  const [value, setValue] = useState('');
  const [mail, setMail] = useState('marina@');
  const [query, setQuery] = useState('');
  const [code, setCode] = useState('418');
  return (
    <Section
      title="2 · Поля ввода"
      note="Радиус 13, паддинг 12×15. Фокус — рамка 1.5 акцента + кольцо. Ошибка появляется после blur, не во время набора: уведите фокус из поля почты."
    >
      <div className="z-gallery__grid">
        <Panel label="Текст, подпись, пояснение">
          <TextField
            label="Название заметки"
            placeholder="Первая строка станет заголовком"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <TextField
            label="Почта"
            mono
            hint="Пришлём ссылку для входа — без паролей и СМС"
            error="Похоже, в адресе опечатка"
            value={mail}
            onChange={(event) => setMail(event.target.value)}
          />
          <TextField label="Путь к хранилищу" value="/storage/emulated/0/Записки" disabled readOnly />
        </Panel>
        <Panel label="Поиск и коды">
          <SearchField
            label="Поиск по заметкам"
            placeholder="Поиск"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClear={() => setQuery('')}
            clearLabel="Очистить поиск"
          />
          <CodeInput label="Код сопряжения" value={code} onChange={setCode} />
          <div className="z-gallery__row">
            <PinDots filled={3} label="Введено 3 из 6 символов пароля" />
            <span className="z-gallery__label">точки ввода пароля заметки</span>
          </div>
        </Panel>
      </div>
    </Section>
  );
}

function ChipsSection(): ReactNode {
  const [active, setActive] = useState<string[]>(['tag']);
  const toggle = (id: string) =>
    setActive((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  return (
    <Section
      title="3 · Чипы, теги, бейджи"
      note="white-space: nowrap; ряд чипов при нехватке места скроллится горизонтально без полосы — не переносится."
    >
      <div className="z-gallery__grid">
        <Panel label="Теги и фильтры">
          <div className="z-gallery__row">
            <Tag>#идеи</Tag>
            <Tag variant="outline">#работа</Tag>
            <Tag variant="surface" icon={<IconHash size={12} />}>
              вложенный/тег
            </Tag>
          </div>
          <div className="z-gallery__row">
            <FilterChip active={active.includes('tag')} onClick={() => toggle('tag')}>
              Тег
            </FilterChip>
            <FilterChip active={active.includes('folder')} onClick={() => toggle('folder')}>
              Папка
            </FilterChip>
            <FilterChip
              active
              onClick={() => undefined}
              onReset={() => undefined}
              resetLabel="Сбросить фильтр периода"
            >
              За месяц
            </FilterChip>
            <FilterChip disabled>Недоступен</FilterChip>
          </div>
        </Panel>
        <Panel label="Бейджи статуса">
          <div className="z-gallery__row">
            <Badge tone="success">бесплатно</Badge>
            <Badge tone="warning">подписка</Badge>
            <Badge tone="danger">ошибка</Badge>
            <Badge tone="info">история</Badge>
            <Badge tone="accent">ЗАПИСКИ+</Badge>
            <Badge>черновик</Badge>
          </div>
        </Panel>
        <Panel label="Ряд чипов — горизонтальный скролл">
          <ChipRow label="Фильтры поиска">
            {['все', 'заметки', 'папки', 'теги', 'вложения', 'зашифрованные', 'архив', 'корзина'].map(
              (item) => (
                <FilterChip key={item}>{item}</FilterChip>
              ),
            )}
          </ChipRow>
        </Panel>
      </div>
    </Section>
  );
}

function TogglesSection(): ReactNode {
  const [switched, setSwitched] = useState(true);
  const [checked, setChecked] = useState(true);
  const [radio, setRadio] = useState('device');
  const [segment, setSegment] = useState('preview');
  return (
    <Section
      title="4 · Переключатели"
      note="Тумблер 40×24, чекбокс 18×18 радиус 6 (заливка 200 мс + галочка 160 мс), радио 18×18 с кольцом 5, сегментированный контрол с бегунком 200 мс."
    >
      <div className="z-gallery__grid">
        <Panel label="Тумблер и чекбокс">
          <Switch
            label="Разблокировать отпечатком"
            checked={switched}
            onChange={(event) => setSwitched(event.target.checked)}
          />
          <Switch label="Недоступно на этой платформе" disabled />
          <Checkbox
            label="Купить хлеб"
            strikeWhenChecked
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          <Checkbox label="Позвонить в сервис" defaultChecked={false} />
          <Checkbox label="Недоступно" disabled />
        </Panel>
        <Panel label="Радио">
          <RadioGroup label="Где обрабатывать голос">
            <Radio
              name="voice"
              label="На этом устройстве"
              checked={radio === 'device'}
              onChange={() => setRadio('device')}
            />
            <Radio
              name="voice"
              label="На домашнем ПК"
              checked={radio === 'pc'}
              onChange={() => setRadio('pc')}
            />
            <Radio name="voice" label="В облаке КОМПАС" disabled />
          </RadioGroup>
        </Panel>
        <Panel label="Сегментированный контрол">
          <SegmentedControl
            label="Режим отображения"
            value={segment}
            onChange={setSegment}
            options={[
              { value: 'preview', label: 'Просмотр' },
              { value: 'raw', label: 'Разметка' },
              { value: 'split', label: 'Две панели' },
            ]}
          />
        </Panel>
      </div>
    </Section>
  );
}

function ListSection(): ReactNode {
  const [selected, setSelected] = useState('1');
  return (
    <Section
      title="5 · Строки списка"
      note="Обычная 74 / компактная 58, паддинг 11×16, разделитель 1 px --line-soft — без карточек. Свайп работает на сенсорном экране: вправо — закрепить, влево — в архив."
    >
      <div className="z-gallery__grid">
        <div className="z-gallery__list">
          <SectionLabel>Закреплённые</SectionLabel>
          <List label="Заметки">
            <ListRow
              title="Разговор с Ниной про дачу"
              snippet="Забор ставим весной, смету прислали. Нужно сравнить с прошлогодней и решить по калитке."
              meta="вчера · 486 слов"
              marks={<IconPin size={13} />}
              selected={selected === '1'}
              onClick={() => setSelected('1')}
              swipeRight={{ label: 'Закрепить', tone: 'accent', onAction: () => undefined }}
              swipeLeft={{ label: 'В архив', tone: 'surface', onAction: () => undefined }}
            />
            <ListRow
              title="Черновик письма в банк"
              snippet="Добрый день! Прошу разъяснить начисление комиссии за период…"
              meta="12 марта · 214 слов"
              marks={<IconPaperclip size={13} />}
              selected={selected === '2'}
              onClick={() => setSelected('2')}
            />
            <ListRow
              title="Дневник · 12 марта"
              snippet="Зашифровано"
              snippetMuted
              meta="12 марта · заперто"
              marks={<IconLock size={13} />}
              selected={selected === '3'}
              onClick={() => setSelected('3')}
            />
          </List>
        </div>
        <div className="z-gallery__list">
          <SectionLabel trailing={<span className="z-mono">3</span>}>Компактные</SectionLabel>
          <List label="Компактные заметки">
            <ListRow compact title="Список покупок" meta="сегодня" onClick={() => undefined} />
            <ListRow compact title="Идеи для отпуска" meta="2 апреля" onClick={() => undefined} />
            <ListRow compact title="Пароли от роутера" meta="1 марта" onClick={() => undefined} />
          </List>
        </div>
      </div>
    </Section>
  );
}

function OverlaysSection(): ReactNode {
  const [sheet, setSheet] = useState(false);
  const [modal, setModal] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const toast = useToast();
  return (
    <Section
      title="6 · Оверлеи"
      note="Все закрываются по Esc и возвращают фокус на вызвавший элемент. Тост живёт 6 секунд, одновременно живёт только один — нажмите дважды."
    >
      <div className="z-gallery__row">
        <Button variant="secondary" onClick={() => setSheet(true)}>
          Bottom sheet
        </Button>
        <Button variant="secondary" onClick={() => setModal(true)}>
          Модалка
        </Button>
        <Button variant="secondary" onClick={() => setDrawer(true)}>
          Библиотека (drawer)
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            toast.show({
              message: 'Заметка перемещена в корзину',
              actionLabel: 'Отменить',
              onAction: () => undefined,
            })
          }
        >
          Тост
        </Button>
        <Tooltip content="Появляется через 500 мс">
          <Button variant="outline">Наведите и подождите</Button>
        </Tooltip>
      </div>

      <BottomSheet
        open={sheet}
        onClose={() => setSheet(false)}
        title="Зашифровать заметку"
        footer={
          <>
            <Button variant="text" onClick={() => setSheet(false)}>
              Не сейчас
            </Button>
            <Button onClick={() => setSheet(false)}>Зашифровать</Button>
          </>
        }
      >
        <div className="z-gallery__stack">
          <TextField label="Пароль" type="password" />
          <TextField label="Повторите пароль" type="password" />
          <InfoNote icon={<IconLock size={15} />}>
            Пароль знаете только вы. Восстановить его мы не сможем — это и есть защита.
          </InfoNote>
        </div>
      </BottomSheet>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Восстановить версию?"
        closeLabel="Закрыть"
        footer={
          <>
            <Button variant="text" onClick={() => setModal(false)}>
              Отмена
            </Button>
            <Button onClick={() => setModal(false)}>Восстановить</Button>
          </>
        }
      >
        <p className="z-snippet">
          Текущий текст сохранится в истории версий — вернуться можно в любой момент.
        </p>
      </Modal>

      <Drawer open={drawer} onClose={() => setDrawer(false)} label="Библиотека">
        <div className="z-gallery__stack">
          <SectionLabel>Папки</SectionLabel>
          <Tree
            label="Папки"
            defaultExpandedIds={['work']}
            selectedId="ideas"
            nodes={[
              {
                id: 'work',
                label: 'Работа',
                icon: <IconFolder size={15} />,
                count: 24,
                children: [
                  { id: 'ideas', label: 'Идеи', icon: <IconFolder size={15} />, count: 8 },
                  { id: 'meetings', label: 'Встречи', icon: <IconFolder size={15} />, count: 16 },
                ],
              },
              { id: 'home', label: 'Дом', icon: <IconFolder size={15} />, count: 12 },
            ]}
          />
          <Button variant="text" onClick={() => setDrawer(false)}>
            Закрыть
          </Button>
        </div>
      </Drawer>
    </Section>
  );
}

function FeedbackSection(): ReactNode {
  return (
    <Section
      title="7 · Обратная связь"
      note="Скелетоны вместо спиннеров там, где известна структура. При prefers-reduced-motion блик и вращение выключаются."
    >
      <div className="z-gallery__grid">
        <Panel label="Плашки-пояснения">
          <InfoNote icon={<IconInfo size={15} />}>
            Заметки мы не читаем — технически не можем.
          </InfoNote>
          <InfoNote tone="success" icon={<IconInfo size={15} />}>
            Локальный режим включён — можно писать.
          </InfoNote>
          <InfoNote tone="warning" icon={<IconInfo size={15} />}>
            Подписка заканчивается через 3 дня.
          </InfoNote>
          <InfoNote tone="danger" icon={<IconInfo size={15} />}>
            Не удалось подключиться к WebDAV — заметки в порядке, синк подождёт.
          </InfoNote>
          <InfoNote tone="info" icon={<IconInfo size={15} />}>
            Конфликтов за месяц: 1 — объединён автоматически, обе версии в истории.
          </InfoNote>
        </Panel>
        <Panel label="Прогресс и статус">
          <Progress value={0.62} label="Загрузка модели" />
          <Progress label="Обработка" />
          <div className="z-gallery__row">
            <Spinner size={14} />
            <Spinner size={22} label="Загружаем" />
            <SyncDot status="synced" label="Синхронизировано" />
            <SyncDot status="syncing" label="Синхронизация" />
            <SyncDot status="offline" label="Оффлайн" />
            <SyncDot status="error" label="Ошибка синхронизации" />
          </div>
          <div className="z-gallery__stack">
            <Skeleton variant="title" />
            <Skeleton variant="line" width="90%" />
            <Skeleton variant="line" width="60%" />
          </div>
        </Panel>
        <Panel label="Пустое состояние">
          <EmptyState
            icon={<IconPen size={26} />}
            title="Здесь пока тихо"
            description="Первая мысль появится за две секунды"
            action={<Button>Написать заметку</Button>}
          />
        </Panel>
        <Panel label="Загрузка списка">
          <SkeletonList rows={3} label="Загружаем заметки" />
        </Panel>
      </div>
    </Section>
  );
}

function SpecialSection(): ReactNode {
  const [playing, setPlaying] = useState(false);
  const [activeLine, setActiveLine] = useState(1);
  const [bold, setBold] = useState(false);
  return (
    <Section
      title="8 · Специальные компоненты"
      note="Тулбар 44 с элементами 34×34, мини-плеер, таймкоды, вейвформа, diff и дерево."
    >
      <div className="z-gallery__grid">
        <Panel label="Тулбар редактора">
          <EditorToolbar
            label="Форматирование"
            items={[
              { id: 'h', icon: <IconHeading size={19} />, label: 'Заголовок', onSelect: () => undefined },
              {
                id: 'b',
                icon: <IconBold size={19} />,
                label: 'Полужирный',
                active: bold,
                onSelect: () => setBold(!bold),
              },
              { id: 'i', icon: <IconItalic size={19} />, label: 'Курсив', onSelect: () => undefined },
              { id: 'ul', icon: <IconList size={19} />, label: 'Список', onSelect: () => undefined },
              {
                id: 'todo',
                icon: <IconCheckSquare size={19} />,
                label: 'Чекбокс',
                onSelect: () => undefined,
              },
              { id: 'img', icon: <IconImage size={19} />, label: 'Фото', onSelect: () => undefined },
              { id: 'mic', icon: <IconMic size={19} />, label: 'Запись', onSelect: () => undefined },
              { id: 'more', icon: <IconMore size={19} />, label: 'Ещё', onSelect: () => undefined },
            ]}
          />
        </Panel>
        <Panel label="Мини-плеер и вейвформа">
          <MiniPlayer
            playing={playing}
            onTogglePlay={() => setPlaying(!playing)}
            playLabel="Воспроизвести"
            pauseLabel="Пауза"
            progress={0.38}
            positionLabel="01:12"
            durationLabel="03:07"
            speedLabel="1,5×"
            onSpeedChange={() => undefined}
            progressLabel="Позиция воспроизведения"
          />
          <Waveform
            label="Уровень записи"
            values={[0.2, 0.5, 0.3, 0.8, 0.6, 0.4, 0.9, 0.7, 0.3, 0.5, 0.6, 0.2, 0.8, 0.4, 0.6, 0.9, 0.5, 0.3]}
          />
        </Panel>
        <Panel label="Строки с таймкодом">
          {[
            { time: '00:04', text: 'Забор ставим весной, смету уже прислали.' },
            { time: '00:21', text: 'Нужно сравнить с прошлогодней и решить по калитке.' },
            { time: '00:48', text: 'Позвонить Нине в четверг после обеда.' },
          ].map((line, index) => (
            <TimecodeRow
              key={line.time}
              time={line.time}
              active={activeLine === index}
              onSelect={() => setActiveLine(index)}
            >
              {line.text}
            </TimecodeRow>
          ))}
        </Panel>
        <Panel label="Diff">
          <Diff
            label="Изменения версии"
            lines={[
              { type: 'context', text: '## Смета на забор' },
              { type: 'remove', text: '- профлист, 18 секций' },
              { type: 'add', text: '+ профлист, 21 секция' },
              { type: 'context', text: 'Доставка входит в стоимость.' },
            ]}
          />
          <p className="z-snippet">
            Инлайн: <DiffInline type="add">21 секция</DiffInline>{' '}
            <DiffInline type="remove">18 секций</DiffInline>
          </p>
        </Panel>
        <Panel label="Дерево тегов">
          <Tree
            label="Теги"
            defaultExpandedIds={['proj']}
            nodes={[
              {
                id: 'proj',
                label: '#проекты',
                icon: <IconHash size={15} />,
                count: 31,
                children: [
                  { id: 'proj-home', label: '#проекты/дом', icon: <IconHash size={15} />, count: 12 },
                  { id: 'proj-work', label: '#проекты/работа', icon: <IconHash size={15} />, count: 19 },
                ],
              },
              { id: 'ideas', label: '#идеи', icon: <IconHash size={15} />, count: 7 },
            ]}
          />
        </Panel>
      </div>
    </Section>
  );
}

function TypographySection(): ReactNode {
  return (
    <Section
      title="9 · Типографика и подсветка кода"
      note="Заголовки различаются размером и насыщенностью, не цветом. Ссылки — акцент + пунктир."
    >
      <div className="z-gallery__grid">
        <Panel label="Роли">
          <p className="z-h1">Тихая комната для мыслей</p>
          <p className="z-h2">Раздел заметки</p>
          <p className="z-body">
            Текст заметки: размер, интерлиньяж и гарнитура берутся из пользовательских
            множителей — переключите ползунки сверху и посмотрите, как это выглядит.
          </p>
          <p className="z-snippet">Сниппет строки списка — две строки с многоточием.</p>
          <p className="z-caption">Секционная подпись</p>
          <p className="z-mono">изменено только что · 486 слов · автосохранение — всегда</p>
          <p className="z-body">
            Ссылка <a className="z-link" href="#top">[[вики-ссылка]]</a> и{' '}
            <mark className="z-mark">подсветка ==вот такая==</mark>.
          </p>
          <blockquote className="z-quote">
            Цитата: левая линия 2.5 px, курсив вторичным цветом.
          </blockquote>
        </Panel>
        <Panel label="Блок кода">
          <pre className="z-code-block">
            <code>
              <span className="z-tok-comment">{'// пастельная подсветка, в тон теме\n'}</span>
              <span className="z-tok-keyword">export function </span>
              <span className="z-tok-function">openNote</span>
              {'(id: '}
              <span className="z-tok-keyword">string</span>
              {') {\n  '}
              <span className="z-tok-keyword">return </span>
              {'vault.read('}
              <span className="z-tok-string">{"'notes/'"}</span>
              {' + id, '}
              <span className="z-tok-number">150</span>
              {');\n}'}
            </code>
          </pre>
        </Panel>
        <Panel label="Поверхности темы">
          <div className="z-gallery__swatches">
            {SURFACE_TOKENS.map((token) => (
              <div className="z-gallery__swatch" key={token}>
                <span className="z-gallery__swatch-box" style={{ backgroundColor: `var(${token})` }} />
                {token}
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </Section>
  );
}

function GalleryContent(): ReactNode {
  return (
    <div className="z-gallery">
      <ControlBar />
      <ButtonsSection />
      <FieldsSection />
      <ChipsSection />
      <TogglesSection />
      <ListSection />
      <OverlaysSection />
      <FeedbackSection />
      <SpecialSection />
      <TypographySection />
      <Section title="Запрещено (DESIGN_TOKENS §3)">
        <div className="z-gallery__row">
          <Tag variant="outline" icon={<IconClose size={12} />}>
            пульсации
          </Tag>
          <Tag variant="outline" icon={<IconClose size={12} />}>
            bounce / overshoot
          </Tag>
          <Tag variant="outline" icon={<IconClose size={12} />}>
            параллакс
          </Tag>
          <Tag variant="outline" icon={<IconClose size={12} />}>
            конфетти
          </Tag>
          <Tag variant="outline" icon={<IconClose size={12} />}>
            красные бейджи-счётчики
          </Tag>
        </div>
      </Section>
    </div>
  );
}

export interface GalleryProps {
  /** Не оборачивать в ThemeProvider/ToastProvider (если они уже есть выше). */
  bare?: boolean;
}

/**
 * Витрина: все компоненты во всех состояниях с переключателем 3 тем × 6 акцентов.
 * Если провайдера темы нет — поднимает свой, чтобы страницу можно было
 * смонтировать одной строкой.
 */
export function Gallery({ bare = false }: GalleryProps = {}): ReactNode {
  const existing = useOptionalTheme();
  if (existing || bare) {
    return (
      <ToastProvider>
        <GalleryContent />
      </ToastProvider>
    );
  }
  return (
    <ThemeProvider>
      <ToastProvider>
        <GalleryContent />
      </ToastProvider>
    </ThemeProvider>
  );
}
