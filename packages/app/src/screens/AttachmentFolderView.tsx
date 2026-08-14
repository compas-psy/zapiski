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
import { useEffect, useState, type ReactNode } from 'react';
import type { AttachmentEntry, VaultPath } from '@zapiski/core';
import { IconImage, IconMic, IconPaperclip, List, ListRow } from '@zapiski/ui';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { EmptyBlock } from '../components/ScreenStates.js';
import { ImageViewer } from '../components/ImageViewer.js';
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
  /**
   * Картинка, открытая на весь экран, и её `blob:`-адрес.
   *
   * Заказчик про папку `Images`: «вложения из неё открываются только в
   * заметке. При клике на неё ничего не происходит». Картинку отдавали
   * системе — а система берётся не за всякий файл, и отказ выглядел как
   * «кнопка не работает». Своя картинка открывается своим просмотрщиком, тем
   * же, что и в заметке; всё остальное по-прежнему уходит системе, ей и место.
   */
  const [viewing, setViewing] = useState<{ path: VaultPath; url: string } | null>(null);

  /* Адрес живёт ровно пока открыт просмотр: иначе байты каждой открытой
     картинки остаются в памяти до конца сеанса. */
  useEffect(() => {
    if (!viewing) return;
    return () => URL.revokeObjectURL(viewing.url);
  }, [viewing]);

  const open = async (file: AttachmentEntry): Promise<void> => {
    if (!IMAGE.test(file.name)) {
      await app.openAttachmentFile(file.path);
      return;
    }
    const url = await app.attachmentUrl(file.path);
    if (url !== null) setViewing({ path: file.path, url });
  };

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
    <>
      <List label={strings.attachments.title}>
        {state.folderFiles.map((file: AttachmentEntry) => (
          <ListRow
            key={file.path}
            title={file.name}
            leading={iconFor(file.name)}
            /* Размер и дата — то, по чему файл узнают: имена вложений начинаются
               с даты и хеша, и по одному имени человек своё фото не найдёт. */
            meta={`${formatBytes(file.size, strings)} · ${shortDate(file.mtime)}`}
            onClick={() => void open(file)}
          />
        ))}
      </List>
      {/* Ширины и обрезки здесь нет намеренно: и то и другое — про картинку В
          ЗАМЕТКЕ, а в папке она сама по себе и ни в какой текст не вставлена. */}
      <ImageViewer
        src={viewing?.url ?? null}
        alt={viewing?.path ?? ''}
        onClose={() => setViewing(null)}
      />
    </>
  );
}
