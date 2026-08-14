/**
 * Содержимое папки вложений: `Images`, `Audio`, `Other files`.
 *
 * ── Дефект, ради которого написан файл ──────────────────────────────────────
 *
 * Заказчик прислал три снимка: в заметке картинка, звук и документ — а папки
 * `Images`, `Audio` и `Other files` в приложении пустые. И приписал главное:
 * «файлы по факту в папках есть, но они не отображаются приложением».
 *
 * Причина не в чтении и не в правах. Список заметок показывает ЗАМЕТКИ, а в
 * этих папках лежат файлы, и заметок там не бывает по определению. Значит для
 * любого содержимого папка выглядела пустой, и человек делал единственный
 * возможный вывод: вложения не сохранились. Файлы при этом были на месте.
 *
 * Поэтому здесь другой список — файлов. Это не «ещё один экран»: шапка, поиск
 * и вся обвязка остаются от списка заметок, меняется только то, что внутри.
 */
import { type ReactNode } from 'react';
import type { AttachmentEntry } from '@zapiski/core';
import { IconImage, IconMic, IconPaperclip, List, ListRow } from '@zapiski/ui';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { EmptyBlock } from '../components/ScreenStates.js';
import { formatBytes, shortDate } from '../lib/format.js';

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|heic|bmp)$/i;
const AUDIO = /\.(mp3|ogg|opus|wav|m4a|aac|flac)$/i;

/** Значок по расширению — тот же признак, по которому файл сюда и попал. */
function iconFor(name: string): ReactNode {
  if (IMAGE.test(name)) return <IconImage size={18} />;
  if (AUDIO.test(name)) return <IconMic size={18} />;
  return <IconPaperclip size={18} />;
}

export function AttachmentFolderView(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();

  if (state.folderFiles.length === 0) {
    /*
      Пусто — тоже ответ, но другой: «файлов пока нет», а не «заметок нет».
      Кнопки «Новая заметка» здесь нет намеренно: заметка, созданная в папке
      вложений, ляжет между картинками и будет мешать и там, и в списке.
    */
    return (
      <EmptyBlock
        title={strings.attachments.emptyFolder}
        description={strings.attachments.systemFolderNote}
      />
    );
  }

  return (
    <List label={strings.attachments.title}>
      {state.folderFiles.map((file: AttachmentEntry) => (
        <ListRow
          key={file.path}
          title={file.name}
          leading={iconFor(file.name)}
          /* Размер и дата — то, по чему файл узнают: имена вложений начинаются
             с даты и хеша, и по одному имени человек своё фото не найдёт. */
          meta={`${formatBytes(file.size, strings)} · ${shortDate(file.mtime)}`}
          onClick={() => void app.openAttachmentFile(file.path)}
        />
      ))}
    </List>
  );
}
