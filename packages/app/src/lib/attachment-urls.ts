/**
 * Путь вложения → URL, который можно поставить в `src` картинки.
 *
 * Дефект, ради которого написано: вставленная картинка показывалась строкой
 * `attachments/2026-08-11_0f3d3d.jpg` вместо изображения. Редактор честно
 * спрашивал у приложения `resolveAttachment(...)`, а приложение этот колбэк
 * не передавало НИГДЕ — значит, ответ всегда был `null`, и виджет картинки не
 * создавался вовсе.
 *
 * Почему нельзя просто отдать путь. Заметки лежат в папке пользователя, а не
 * на сайте: в вебе это OPFS, на Android — SAF, в Tauri — файловая система.
 * Ни один из этих путей браузер по `src` не откроет. Нужен `blob:`-URL,
 * созданный из байтов, прочитанных портом хранилища.
 *
 * Почему кэш обязателен, а не оптимизация. `resolveAttachment` — СИНХРОННЫЙ
 * колбэк: он вызывается при пересчёте декораций, то есть на каждый кейстрок.
 * Читать файл там нельзя. Поэтому первый вызов возвращает `null` и запускает
 * чтение в фоне, а когда байты пришли — дёргает перерисовку, и второй вызов
 * отдаёт готовый URL.
 */
import type { VaultPath, VaultStorage } from '@zapiski/core';

/** Что отдавать браузеру по расширению: без типа `blob:` показывается пустым. */
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  /* Плеер считает звуком и эти два (`AUDIO_ATTACHMENT` в decorations.ts).
     Без строчки здесь blob получал `application/octet-stream`, и движок,
     который не досматривает содержимое, отказывался их играть. */
  aac: 'audio/aac',
  flac: 'audio/flac',
  pdf: 'application/pdf',
};

function mimeOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot > 0 ? path.slice(dot + 1).toLowerCase() : '';
  return MIME[ext] ?? 'application/octet-stream';
}

export class AttachmentUrls {
  private readonly urls = new Map<VaultPath, string>();
  /**
   * Объём в байтах — для карточки файла (ITERATION-1 §5). Берётся из тех же
   * байтов, что уже прочитаны ради URL: отдельного обращения к диску ради
   * размера не делаем, а спрашивают его на каждом пересчёте декораций.
   */
  private readonly bytes = new Map<VaultPath, number>();
  /** Пути, которые уже читаются: без этого один кейстрок стартует десять чтений. */
  private readonly loading = new Set<VaultPath>();
  private storage: VaultStorage | null = null;

  constructor(private readonly onReady: () => void) {}

  /** Хранилище меняется при смене места заметок — кэш при этом недействителен. */
  attach(storage: VaultStorage | null): void {
    if (this.storage === storage) return;
    this.storage = storage;
    this.clear();
  }

  /**
   * URL вложения или `null`, если байты ещё не прочитаны. `null` — не отказ:
   * чтение запущено, и по его окончании вызывающий будет перерисован.
   */
  resolve(path: string): string | null {
    /* Внешние адреса и data: сюда не попадают — их редактор отдаёт как есть. */
    const clean = path.split('#')[0]?.split('?')[0] ?? path;
    if (clean === '') return null;

    const cached = this.urls.get(clean);
    if (cached !== undefined) return cached;
    if (!this.loading.has(clean)) void this.load(clean);
    return null;
  }

  /**
   * Объём вложения в байтах или `null`, пока байты не прочитаны. Чтение сам не
   * запускает: карточка появляется только после `resolve`, а тот его и начал.
   */
  size(path: string): number | null {
    const clean = path.split('#')[0]?.split('?')[0] ?? path;
    return this.bytes.get(clean) ?? null;
  }

  /**
   * Забыть вложение: файл на диске изменился, и кэш держит прежние байты.
   *
   * Нужно после обрезки (замечание 2): без этого на экране остаётся картинка
   * до обрезки, и человек решает, что ничего не произошло.
   */
  forget(path: string): void {
    const clean = path.split('#')[0]?.split('?')[0] ?? path;
    const url = this.urls.get(clean);
    if (url !== undefined) URL.revokeObjectURL(url);
    this.urls.delete(clean);
    this.bytes.delete(clean);
    this.loading.delete(clean);
  }

  private async load(path: VaultPath): Promise<void> {
    const storage = this.storage;
    if (!storage) return;
    this.loading.add(path);
    try {
      const bytes = await storage.read(path);
      if (!bytes) return;
      /* Копия в новый буфер: `Uint8Array` из порта может смотреть в общий
         пул, и Blob поверх него однажды покажет чужие байты. */
      const blob = new Blob([bytes.slice() as unknown as BlobPart], { type: mimeOf(path) });
      this.urls.set(path, URL.createObjectURL(blob));
      this.bytes.set(path, bytes.byteLength);
      this.onReady();
    } catch {
      /* Файла нет или доступ отозван — виджет просто не появится, а текст
         ссылки останется. Молчим: это не то, ради чего стоит поднимать тост
         на каждый пересчёт декораций. */
    } finally {
      this.loading.delete(path);
    }
  }

  /** Отзывает выданные URL: иначе байты каждой открытой картинки живут вечно. */
  clear(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.bytes.clear();
    this.loading.clear();
  }
}
