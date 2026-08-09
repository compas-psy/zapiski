/**
 * `AppHost.saveFile` — отдать готовый файл пользователю (BEHAVIOR §9).
 *
 * Ядро собирает байты (md, zip, html, docx) или печатает PDF, а положить их
 * наружу может только платформа. На Android «наружу» — это «Загрузки»
 * (подробности и различия версий — в `android/.../Downloads.kt`).
 *
 * Байты уходят сырым телом, имя и MIME — заголовками: экспорт vault'а в zip
 * весит десятки мегабайт, и JSON-массив чисел стоил бы дороже самой записи.
 */
import { COMMANDS, callRaw, encodeHeaderValue } from './ipc';

const NAME_HEADER = 'x-file-name';
const MIME_HEADER = 'x-file-mime';

export function saveFile(name: string, data: Uint8Array, mime: string): Promise<void> {
  return callRaw<void>(COMMANDS.saveFile, data, {
    [NAME_HEADER]: encodeHeaderValue(name),
    [MIME_HEADER]: encodeHeaderValue(mime),
  });
}
