/**
 * История версий — SCREENS §10b (`4h`), BEHAVIOR §6.
 *
 * Слева список версий 260 (автослияние помечено иконкой), справа diff:
 * добавления на success-soft, удаления на danger-soft с зачёркиванием.
 * «Восстановить эту версию» — ОО: 6-секундный тост с «Отменить».
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { diffText, type VaultPath, type VersionSnapshot } from '@zapiski/core';
import { Button, Diff, IconArrowLeft, IconButton, type DiffLine } from '@zapiski/ui';
import { useApp, useStrings } from '../state/context.js';
import { EmptyBlock } from '../components/ScreenStates.js';
import { IconMerge } from '../components/icons.js';
import { shortDate } from '../lib/format.js';

export interface VersionsScreenProps {
  noteId: VaultPath;
}

export function VersionsScreen({ noteId }: VersionsScreenProps): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const [versions, setVersions] = useState<VersionSnapshot[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [current, setCurrent] = useState('');

  useEffect(() => {
    const vault = app.vaultRef;
    if (!vault) return;
    const meta = vault.metaOf(noteId);
    void vault.read(noteId).then((note) => setCurrent(note?.body ?? ''));
    if (!meta) return;
    /* История живёт в движке синка: там же, где снапшоты слияний. */
    void app.versionsFor(meta.id).then((list) => {
      setVersions(list);
      setActiveId(list[0]?.id ?? null);
    });
  }, [app, noteId]);

  const active = versions.find((item) => item.id === activeId) ?? null;
  const lines = useMemo<DiffLine[]>(
    () => (active ? toDiffLines(active.body, current) : []),
    [active, current],
  );
  const added = lines.filter((line) => line.type === 'add').length;
  const removed = lines.filter((line) => line.type === 'remove').length;

  return (
    <div className="za-editor">
      <div className="za-header">
        <IconButton
          icon={<IconArrowLeft size={20} />}
          label={strings.app.back}
          tone="ghost"
          onClick={() => app.back()}
        />
        <h1 className="za-h1 za-h1--mobile za-header__title">{strings.versions.title}</h1>
        <span className="za-tertiary-mono">{strings.versions.counters(added, removed)}</span>
      </div>

      {versions.length === 0 ? (
        <EmptyBlock title={strings.versions.empty} />
      ) : (
        <div className="za-versions">
          <div className="za-versions__list" role="listbox" aria-label={strings.versions.listLabel}>
            {versions.map((version) => (
              <button
                key={version.id}
                type="button"
                role="option"
                aria-selected={version.id === activeId}
                className={`za-versions__item${version.id === activeId ? ' za-versions__item--active' : ''}`}
                onClick={() => setActiveId(version.id)}
              >
                <span className="za-row-between">
                  <span>{shortDate(version.takenAt)}</span>
                  {version.merged ? <IconMerge size={15} aria-label={strings.versions.merged} /> : null}
                </span>
                <span className="za-tertiary-mono">{strings.versions.source(version.source)}</span>
              </button>
            ))}
          </div>

          <div className="za-scroll">
            <div className="za-page">
              <Diff lines={lines} label={strings.versions.title} />
              <div style={{ paddingBlockStart: 16 }}>
                <Button
                  onClick={() => {
                    if (active) void app.restoreVersion(noteId, active.body);
                  }}
                >
                  {strings.versions.restore}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Построчный diff версии и текущего текста. */
function toDiffLines(from: string, to: string): DiffLine[] {
  const edits = diffText(from, to);
  if (edits.length === 0) {
    return to.split('\n').map((text) => ({ type: 'context', text }));
  }
  const lines: DiffLine[] = [];
  const before = from.split('\n');
  const after = to.split('\n');
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  for (const line of before) {
    if (!afterSet.has(line)) lines.push({ type: 'remove', text: line });
  }
  for (const line of after) {
    lines.push(beforeSet.has(line) ? { type: 'context', text: line } : { type: 'add', text: line });
  }
  return lines;
}
