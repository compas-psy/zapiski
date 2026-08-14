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
  ShareOutProvider,
  ShareTargetProvider,
} from '@zapiski/core';

import { COMMANDS, EVENTS, call, on } from './ipc';

/** То, что присылает Rust. `bytes` — обычный массив чисел из JSON. */
interface SharedPayloadDto {
  kind: SharedPayload['kind'];
  text?: string | null;
  url?: string | null;
  bytes?: number[] | null;
  mime?: string | null;
}

function fromDto(dto: SharedPayloadDto): SharedPayload {
  const payload: SharedPayload = { kind: dto.kind };
  if (typeof dto.text === 'string') payload.text = dto.text;
  if (typeof dto.url === 'string') payload.url = dto.url;
  if (Array.isArray(dto.bytes)) payload.bytes = Uint8Array.from(dto.bytes);
  if (typeof dto.mime === 'string') payload.mime = dto.mime;
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
 * Наружу уходит markdown как есть. Telegram разбирает разметку сам, и любая
 * наша «подготовка» текста ломала бы её принимающей стороне.
 */
export function createShareOut(): ShareOutProvider {
  return {
    async text(payload: { title?: string; text: string }): Promise<ShareOutcome> {
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
      }).catch((error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`);

      if (answer === 'shared') return { kind: 'shared' };
      if (answer === 'copied') return { kind: 'copied' };
      const reason = answer.startsWith('error: ') ? answer.slice('error: '.length) : answer;
      return { kind: 'failed', reason };
    },
  };
}
