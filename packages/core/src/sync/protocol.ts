/**
 * Протокол KompasCloud (ADR-0003). Типы объявлены здесь один раз и
 * импортируются и клиентом, и сервером (`server/`): рассинхрон протокола
 * становится ошибкой компиляции, а не багом в проде.
 *
 * Базовый префикс — `/api/v1`. Сервер — «тупая труба» для зашифрованных
 * чанков: содержимого он не понимает (zero-knowledge, ТЗ §2.1.5).
 */
import type { NoteId, VaultPath } from '../contract.js';

export const API_PREFIX = '/api/v1';

export const VAULT_ENDPOINTS = {
  /** GET — список объектов vault'а с ETag. */
  list: `${API_PREFIX}/vault/list`,
  /** GET/PUT/DELETE `?path=` — тело объекта. */
  blob: `${API_PREFIX}/vault/blob`,
  /** POST — пакетная выгрузка CRDT-обновлений. */
  push: `${API_PREFIX}/vault/push`,
  /** POST — дельта по вектору состояния. */
  pull: `${API_PREFIX}/vault/pull`,
  /** WS — мгновенные уведомления об изменениях. */
  subscribe: `${API_PREFIX}/vault/subscribe`,
  /** GET — история версий заметки на сервере (30/365 дней, ТЗ §4.2). */
  versions: `${API_PREFIX}/vault/versions`,
} as const;

export interface CloudEntryDto {
  path: VaultPath;
  etag: string;
  /** Unix-миллисекунды. Логические часы CRDT важнее (ТЗ §4.3). */
  mtime: number;
  size: number;
  /** Зашифрован ли объект. Сервер этим не пользуется — только клиент. */
  encrypted?: boolean;
}

export interface CloudListResponse {
  entries: CloudEntryDto[];
  /** Курсор для инкрементальной выборки. */
  cursor?: string;
}

/** Пакет CRDT-обновлений: `update` — base64 от Yjs-апдейта. */
export interface CloudPushRequest {
  deviceId: string;
  updates: Array<{ noteId: NoteId; update: string }>;
}

export interface CloudPushResponse {
  accepted: number;
  /** Серверные версии по заметкам после применения. */
  etags: Record<NoteId, string>;
}

export interface CloudPullRequest {
  deviceId: string;
  /** Вектор состояния клиента по заметке, base64. */
  stateVectors: Array<{ noteId: NoteId; stateVector: string }>;
}

export interface CloudPullResponse {
  updates: Array<{ noteId: NoteId; update: string }>;
}

export interface CloudErrorDto {
  /** Машинный код; человеческий текст берётся из каталога i18n (BEHAVIOR §11). */
  code:
    | 'unauthorized'
    | 'subscription_expired'
    | 'quota_exceeded'
    | 'conflict'
    | 'not_found'
    | 'server_error';
  message?: string;
}

export interface CloudSubscribeEvent {
  type: 'changed' | 'removed';
  path: VaultPath;
  etag?: string;
}
