/**
 * Панель «Инфо» — BEHAVIOR §2.9.
 * Даты, статистика, вложения, backlinks, действия и путь к файлу (тап —
 * скопировать). На desktop — правая панель 280, на mobile — bottom sheet.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { countWords, isEncryptedPath, type Note, type NoteMeta } from '@zapiski/core';
import { Button } from '@zapiski/ui';
import { useApp, useStrings } from '../state/context.js';
import { readingMinutes, shortDate } from '../lib/format.js';
import { Section } from '../components/ScreenStates.js';

export interface InfoPanelProps {
  note: Note;
  backlinks: readonly NoteMeta[];
}

export function InfoPanel({ note, backlinks }: InfoPanelProps): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const [copied, setCopied] = useState(false);

  const words = useMemo(() => countWords(note.body), [note.body]);
  const attachments = useMemo(() => extractAttachments(note.body), [note.body]);
  const encrypted = isEncryptedPath(note.path);

  const copyPath = (): void => {
    void navigator.clipboard?.writeText(note.path).then(() => setCopied(true));
  };

  return (
    <div className="za-stack za-stack--tight">
      <Section>{strings.note.infoPanel.title}</Section>
      <div className="za-info__row">
        <span>{strings.note.infoPanel.created}</span>
        <span className="za-info__value">{shortDate(note.createdAt)}</span>
      </div>
      <div className="za-info__row">
        <span>{strings.note.infoPanel.updated}</span>
        <span className="za-info__value">{shortDate(note.updatedAt)}</span>
      </div>
      <div className="za-info__row">
        <span>{strings.note.infoPanel.stats}</span>
        <span className="za-info__value">
          {strings.list.words(words)} · {strings.note.infoPanel.chars(note.body.length)} ·{' '}
          {strings.note.infoPanel.readingTime(readingMinutes(words))}
        </span>
      </div>

      {attachments.length > 0 ? (
        <>
          <Section>{strings.note.infoPanel.attachments}</Section>
          {attachments.map((item) => (
            <div key={item} className="za-tertiary-mono">
              {item}
            </div>
          ))}
        </>
      ) : null}

      {/* Панель backlinks не показывается вовсе, если ссылок нет (BEHAVIOR §2.10). */}
      {backlinks.length > 0 ? (
        <>
          <Section>{strings.note.infoPanel.backlinks}</Section>
          {backlinks.map((item) => (
            <button
              key={item.path}
              type="button"
              className="za-backlinks__link"
              onClick={() => app.openNote(item.path)}
            >
              {item.title}
            </button>
          ))}
        </>
      ) : null}

      <Section>{strings.note.infoPanel.actions}</Section>
      <div className="za-stack za-stack--tight">
        <Button
          variant="text"
          size="compact"
          onClick={() => app.navigate({ name: 'versions', noteId: note.path })}
        >
          {strings.versions.title}
        </Button>
        {!encrypted ? (
          <Button variant="text" size="compact" onClick={() => void app.duplicate(note.path)}>
            {strings.list.duplicate}
          </Button>
        ) : null}
        <Button
          variant="text"
          size="compact"
          onClick={() => void app.archive(note.path, !note.archived)}
        >
          {note.archived ? strings.list.unarchive : strings.list.archive}
        </Button>
        <Button variant="text" size="compact" onClick={() => void app.trashNote(note.path)}>
          {strings.list.delete}
        </Button>
      </div>

      <Section>{strings.note.infoPanel.path}</Section>
      <button type="button" className="za-info__path" onClick={copyPath}>
        {note.path}
      </button>
      {copied ? <p className="za-tertiary-mono">{strings.note.infoPanel.pathCopied}</p> : null}
    </div>
  );
}

/** Пути вложений из тела: `![](attachments/…)` и `[](attachments/…)`. */
function extractAttachments(body: string): string[] {
  const found = new Set<string>();
  const pattern = /!?\[[^\]]*\]\((attachments\/[^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}
