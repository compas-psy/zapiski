/**
 * `ShareTargetProvider` — приём контента из системного «Поделиться»
 * (BEHAVIOR §8).
 *
 * Манифест объявляет `intent-filter` на `ACTION_SEND` для трёх типов:
 * `text/plain` (текст и ссылка — различаются по содержимому), `image/*` и
 * `ACTION_SEND_MULTIPLE` для нескольких картинок. Kotlin-часть разбирает
 * Intent, вытаскивает полезную нагрузку и отдаёт её Rust'у, Rust — сюда.
 *
 * Тонкость запуска: «поделиться» может поднять приложение с нуля, и тогда
 * payload появляется раньше, чем фронтенд успевает подписаться. Поэтому
 * есть две дороги — событие для «приложение уже работает» и очередь
 * `share_take()` для «приложение только что стартовало». Подписка забирает
 * очередь сразу, иначе первый же холодный share терялся бы.
 */
import type {
  SharedPayload,
  ShareOutcome,
  ShareOutFile,
  ShareOutProvider,
  ShareTargetProvider,
} from '@zapiski/core';

import { COMMANDS, EVENTS, call, callRaw, encodeHeaderValue, on } from './ipc';

/** То, что присылает Rust. `bytes` — обычный массив чисел из JSON. */
interface SharedPayloadDto {
  kind: SharedPayload['kind'];
  text?: string | null;
  url?: string | null;
  bytes?: number[] | null;
  mime?: string | null;
  /** Имя файла — только у `kind: 'file'` (ТЗ §5.4). */
  name?: string | null;
}

function fromDto(dto: SharedPayloadDto): SharedPayload {
  const payload: SharedPayload = { kind: dto.kind };
  if (typeof dto.text === 'string') payload.text = dto.text;
  if (typeof dto.url === 'string') payload.url = dto.url;
  if (Array.isArray(dto.bytes)) payload.bytes = Uint8Array.from(dto.bytes);
  if (typeof dto.mime === 'string') payload.mime = dto.mime;
  if (typeof dto.name === 'string') payload.name = dto.name;
  return payload;
}

export function createShareTarget(): ShareTargetProvider {
  return {
    onShare(handler) {
      let disposed = false;
      let unlisten: (() => void) | null = null;

      void on<SharedPayloadDto>(EVENTS.share, (dto) => {
        if (!disposed) handler(fromDto(dto));
      }).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });

      // Холодный старт: то, что ОС передала до подписки, лежит в очереди.
      void call<SharedPayloadDto[]>(COMMANDS.shareTake)
        .then((pending) => {
          if (disposed) return;
          for (const dto of pending) handler(fromDto(dto));
        })
        .catch(() => undefined);

      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  };
}

/**
 * `ShareOutProvider` — отдать заметку системному «Поделиться».
 *
 * Обратная сторона того же интерфейса Android: выше приложение принимает
 * чужое, здесь отдаёт своё. Заказчик просил кнопку в шапке заметки — она
 * появляется ровно там, где этот порт есть, то есть только на Android.
 *
 * ── Почему картинки едут файлами, а не путями ───────────────────────────────
 *
 * Заметка хранится либо в выбранной человеком папке (`content://` SAF), либо в
 * приватном каталоге приложения. Ни то, ни другое получателю недоступно:
 * Telegram не имеет права читать наше хранилище. Поэтому байты каждой картинки
 * едут сюда, ложатся во временный файл в кэше и отдаются наружу как
 * `content://…/share/…` через наш FileProvider — с правом чтения ровно на этот
 * файл и ровно на время отправки.
 *
 * Байты идут сырым телом запроса, по одному файлу за раз: снимок с телефона
 * весит мегабайты, и JSON-массив чисел утроил бы и время, и пиковую память
 * (та же причина, что у `saveFile`).
 */
export function createShareOut(): ShareOutProvider {
  return {
    async share(payload: {
      title?: string;
      text: string;
      files?: readonly ShareOutFile[];
    }): Promise<ShareOutcome> {
      /*
        Картинки: не сумели положить в кэш — отправляем заметку без них.
        Отменить отправку из-за вложения значило бы потерять заметку ради
        картинки, а человек нажимал «Поделиться» ради заметки.
      */
      const staged: string[] = [];
      const mimes: string[] = [];
      for (const file of payload.files ?? []) {
        const path = await stage(file).catch(() => null);
        if (path === null) continue;
        staged.push(path);
        mimes.push(file.mime);
      }

      /*
        Java отвечает словом: `shared`, `copied` или `error: …`. Пересказывать
        его своими словами нельзя — именно так и появился тост «ни одно
        приложение не принимает текст» на телефоне, где приложений полно.
        Отмена в уже открывшемся окне сюда не доходит: она случается после
        успеха и отказом не является.
      */
      const answer = await call<string>(COMMANDS.shareText, {
        title: payload.title ?? '',
        body: payload.text,
        files: staged,
        mimes,
      }).catch((error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`);

      if (answer === 'shared') return { kind: 'shared' };
      if (answer === 'copied') return { kind: 'copied' };
      const reason = answer.startsWith('error: ') ? answer.slice('error: '.length) : answer;
      return { kind: 'failed', reason };
    },
  };
}

/** Положить байты во временный файл и получить его путь. */
function stage(file: ShareOutFile): Promise<string> {
  return callRaw<string>(COMMANDS.shareStage, file.bytes, {
    'x-file-name': encodeHeaderValue(file.name),
  });
}
