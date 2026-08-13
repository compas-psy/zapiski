/**
 * Импорт — мастер из четырёх шагов (BEHAVIOR §9, SCREENS §11).
 *
 * Источник → файлы → предпросмотр → импорт с отменяемым прогрессом и отчётом.
 * Инвариант «импорт никогда не перезаписывает существующие заметки» держит
 * ядро (`applyImport`), здесь он только проговаривается пользователю.
 */
import { useRef, useState, type ReactNode } from 'react';
import {
  applyImport,
  importBearFiles,
  importEvernote,
  importFolder,
  importNotionFiles,
  unzip,
  type ImportBundle,
  type ImportReport,
} from '@zapiski/core';
import { Button, IconArrowLeft, IconButton, InfoNote, Progress } from '@zapiski/ui';
import { useApp, useStrings } from '../state/context.js';
import { Section } from '../components/ScreenStates.js';

type Source = 'obsidian' | 'bear' | 'notion' | 'evernote' | 'folder';

export function ImportScreen(): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const copy = strings.importer;
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState(0);
  const [source, setSource] = useState<Source>('obsidian');
  const [bundle, setBundle] = useState<ImportBundle | null>(null);
  const [progress, setProgress] = useState(0);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [target, setTarget] = useState('');
  const abort = useRef<{ aborted: boolean }>({ aborted: false });

  const pick = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    const map = new Map<string, Uint8Array>();
    for (const file of Array.from(files)) {
      const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      map.set(relative && relative !== '' ? relative : file.name, new Uint8Array(await file.arrayBuffer()));
    }
    setBundle(buildBundle(source, map));
    setStep(2);
  };

  const run = async (): Promise<void> => {
    const vault = app.vaultRef;
    if (!vault || !bundle) return;
    abort.current = { aborted: false };
    setStep(3);
    const result = await applyImport(vault, bundle, {
      targetFolder: target,
      onProgress: (done, total) => setProgress(total === 0 ? 1 : done / total),
      signal: abort.current,
    });
    setReport(result);
    await app.refresh();
  };

  return (
    <div className="za-screen">
      <div className="za-header">
        <IconButton
          icon={<IconArrowLeft size={20} />}
          label={strings.app.back}
          tone="ghost"
          onClick={() => app.back()}
        />
        <h1 className="za-h1 za-h1--mobile za-header__title">{copy.title}</h1>
      </div>

      <div className="za-page za-stack">
        <div className="za-progress-steps" role="img" aria-label={copy.steps[step]}>
          {copy.steps.map((label, index) => (
            <span
              key={label}
              className={`za-progress-steps__bar${index <= step ? ' za-progress-steps__bar--active' : ''}`}
            />
          ))}
        </div>

        {step === 0 ? (
          <>
            <Section>{copy.steps[0]}</Section>
            {(Object.keys(copy.sources) as Source[]).map((item) => (
              <button
                key={item}
                type="button"
                className={`za-card${source === item ? ' za-card--selected' : ''}`}
                aria-pressed={source === item}
                onClick={() => setSource(item)}
              >
                <span className="za-card__title">{copy.sources[item]}</span>
              </button>
            ))}
            <Button fullWidth onClick={() => setStep(1)}>
              {strings.app.continue}
            </Button>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <Section>{copy.steps[1]}</Section>
            {/*
              Два входа, а не один.

              Obsidian и «папка с .md» приезжают ПАПКОЙ с вложенностью, и
              выбрать её обычным выбором файлов нельзя: человек либо тыкал в
              отдельные файлы, теряя структуру, либо не мог выбрать ничего.
              `webkitdirectory` — единственный способ отдать браузеру каталог;
              относительные пути приходят в `webkitRelativePath`, и разбор их
              уже ждал.

              Bear, Notion и Evernote отдают архив либо один файл — им нужен
              обычный выбор. Показываем оба входа: угадывать за человека, что
              у него на диске, мы не можем.
            */}
            <input
              ref={fileInput}
              type="file"
              multiple
              className="z-visually-hidden"
              aria-label={copy.pick}
              onChange={(event) => void pick(event.target.files)}
            />
            <input
              ref={folderInput}
              type="file"
              multiple
              // @ts-expect-error нестандартный атрибут: другого способа
              // отдать браузеру каталог нет, и он поддержан везде, где мы
              // работаем.
              webkitdirectory=""
              className="z-visually-hidden"
              aria-label={copy.pickFolder}
              onChange={(event) => void pick(event.target.files)}
            />
            <Button fullWidth onClick={() => folderInput.current?.click()}>
              {copy.pickFolder}
            </Button>
            <Button variant="secondary" fullWidth onClick={() => fileInput.current?.click()}>
              {copy.pick}
            </Button>
            <p className="za-muted za-hint">{copy.pickHint}</p>
            <InfoNote>{copy.neverOverwrites}</InfoNote>
          </>
        ) : null}

        {step === 2 && bundle ? (
          <>
            <Section>{copy.steps[2]}</Section>
            <p className="za-muted">
              {copy.preview(bundle.notes.length, bundle.assets.length, bundle.folders)}
            </p>
            <label className="za-field-row">
              <span className="za-muted">{copy.target}</span>
              <input
                className="za-info__path"
                value={target}
                placeholder={copy.targetRoot}
                onChange={(event) => setTarget(event.target.value)}
              />
            </label>
            <Button fullWidth onClick={() => void run()}>
              {copy.start}
            </Button>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <Section>{copy.steps[3]}</Section>
            {report ? (
              <>
                <p className="za-muted">
                  {report.skipped > 0
                    ? strings.errors.importPartial(report.imported, report.skipped)
                    : copy.done(report.imported)}
                </p>
                {report.warnings.length > 0 ? (
                  <details>
                    <summary className="za-muted">{copy.showSkipped}</summary>
                    {report.warnings.map((warning) => (
                      <p key={warning} className="za-tertiary-mono">
                        {warning}
                      </p>
                    ))}
                  </details>
                ) : null}
                <Button fullWidth onClick={() => app.navigate({ name: 'list' })}>
                  {strings.app.done}
                </Button>
              </>
            ) : (
              <>
                <Progress value={progress} label={copy.running} />
                <Button
                  variant="secondary"
                  onClick={() => {
                    abort.current.aborted = true;
                  }}
                >
                  {copy.cancel}
                </Button>
              </>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Разбор выбранных файлов конкретным импортёром ядра.
 *
 * ── Почему архив разворачивается ЗДЕСЬ ──────────────────────────────────────
 *
 * Заказчик: «Импорт… не должен быть просто декорацией». Декорацией он и был, и
 * по одной причине: Notion, Bear и Evernote отдают выгрузку АРХИВОМ. Человек
 * выбирал `Export.zip`, сюда приезжал один бинарный файл, импортёр не находил
 * в нём ни одной заметки и рапортовал «импортировано: 0». Всё остальное —
 * разбор markdown, вложения, защита от перезаписи — было на месте и работало
 * вхолостую, потому что до него не доходило содержимое.
 *
 * Распаковка в ядре была с самого начала (`unzip`, `importBear(zip)`,
 * `importNotion(zip)`, `importFolderZip`) — её просто никто не звал.
 */
function buildBundle(source: Source, files: Map<string, Uint8Array>): ImportBundle {
  const expanded = expandArchives(files);
  switch (source) {
    case 'bear':
      return importBearFiles(expanded);
    case 'notion':
      return importNotionFiles(expanded);
    case 'evernote': {
      /* `.enex` — единственный формат Evernote, и он не архив. Но выгрузку
         часто присылают завёрнутой в zip, поэтому берём первый `.enex` из
         того, что получилось после разворачивания. */
      const enex =
        [...expanded.entries()].find(([name]) => /\.enex$/i.test(name))?.[1] ??
        [...expanded.values()][0];
      return importEvernote(enex ?? new Uint8Array());
    }
    case 'obsidian':
    case 'folder':
    default:
      return importFolder(expanded);
  }
}

/**
 * Развернуть выбранные архивы в обычные файлы.
 *
 * Архив может быть один (обычный случай) или лежать среди прочего — разбираем
 * все. Битый архив не роняет импорт: он остаётся в наборе как есть, и
 * импортёр просто не найдёт в нём заметок.
 */
function expandArchives(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  if (![...files.keys()].some((name) => /\.zip$/i.test(name))) return files;

  const out = new Map<string, Uint8Array>();
  for (const [name, bytes] of files) {
    if (!/\.zip$/i.test(name)) {
      out.set(name, bytes);
      continue;
    }
    try {
      for (const [inner, data] of unzip(bytes)) out.set(inner, data);
    } catch {
      out.set(name, bytes);
    }
  }
  return out;
}
