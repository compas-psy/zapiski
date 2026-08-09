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
            <input
              ref={fileInput}
              type="file"
              multiple
              className="z-visually-hidden"
              aria-label={copy.pick}
              onChange={(event) => void pick(event.target.files)}
            />
            <Button fullWidth onClick={() => fileInput.current?.click()}>
              {copy.pick}
            </Button>
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

/** Разбор выбранных файлов конкретным импортёром ядра. */
function buildBundle(source: Source, files: Map<string, Uint8Array>): ImportBundle {
  switch (source) {
    case 'bear':
      return importBearFiles(files);
    case 'notion':
      return importNotionFiles(files);
    case 'evernote': {
      const first = [...files.values()][0];
      return importEvernote(first ?? new Uint8Array());
    }
    case 'obsidian':
    case 'folder':
    default:
      return importFolder(files);
  }
}
