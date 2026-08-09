-- 0002_vault — блобы, CRDT-апдейты, история версий, учёт квоты.
--
-- ZERO-KNOWLEDGE (ТЗ §2.1.5). В этой схеме нет и не может быть колонки с
-- открытым текстом заметки: сервер хранит шифротекст в томе на диске, а в
-- Postgres — только метаданные (путь, etag, размер, время, ключ хранения).
-- Проверяется тестом test/schema.zero-knowledge.test.ts.

CREATE TABLE blobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Путь внутри vault'а. Это пользовательские данные: в ответах API он есть,
  -- в логах — никогда, только path_hash (ТЗ §6).
  path        text        NOT NULL,
  path_hash   text        NOT NULL,
  -- Сильный валидатор: SHA-256 от шифротекста.
  etag        text        NOT NULL,
  size        bigint      NOT NULL CHECK (size >= 0),
  -- Момент записи в миллисекундах эпохи — как в RemoteEntry.mtime.
  mtime       bigint      NOT NULL,
  -- Путь файла в томе. Складывается из хешей, имён vault'а не повторяет.
  storage_key text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Мягкое удаление: строка остаётся надгробием, файл в томе удаляется сразу.
  deleted_at  timestamptz,
  UNIQUE (user_id, path)
);

CREATE INDEX blobs_user_live_idx ON blobs (user_id) WHERE deleted_at IS NULL;
CREATE INDEX blobs_user_mtime_idx ON blobs (user_id, mtime);

-- Непрозрачные CRDT-апдейты. Сервер их не интерпретирует и не может: клиент
-- шифрует апдейт перед отправкой, здесь лежит только шифротекст.
CREATE TABLE crdt_updates (
  -- Монотонный курсор для параметра ?since=
  seq        bigserial PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  note_id    text        NOT NULL,
  ciphertext bytea       NOT NULL,
  size       integer     NOT NULL CHECK (size >= 0),
  device_id  uuid REFERENCES devices (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crdt_updates_cursor_idx ON crdt_updates (user_id, note_id, seq);

-- История версий (ТЗ §4.2). Версия — такой же зашифрованный блоб в томе.
-- Срок хранения проставляется при записи: 30 дней пробный / 365 подписка.
CREATE TABLE versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  note_id     text        NOT NULL,
  -- Путь заметки на момент снимка; может быть NULL, если клиент его не дал.
  path        text,
  path_hash   text,
  storage_key text        NOT NULL,
  etag        text        NOT NULL,
  size        bigint      NOT NULL CHECK (size >= 0),
  -- VersionSnapshot.source: имя устройства либо 'local'.
  source      text        NOT NULL DEFAULT 'local',
  -- VersionSnapshot.merged: версия получена автослиянием (SCREENS §10b `4h`).
  merged      boolean     NOT NULL DEFAULT false,
  taken_at    timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX versions_note_idx ON versions (user_id, note_id, taken_at DESC);
CREATE INDEX versions_expires_idx ON versions (expires_at);

-- Учёт занятого объёма (ТЗ §7: 10 ГБ). Обновляется в той же транзакции,
-- что и запись/удаление, поэтому не расходится с фактом.
CREATE TABLE quota_usage (
  user_id         uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  blob_bytes      bigint      NOT NULL DEFAULT 0 CHECK (blob_bytes >= 0),
  version_bytes   bigint      NOT NULL DEFAULT 0 CHECK (version_bytes >= 0),
  crdt_bytes      bigint      NOT NULL DEFAULT 0 CHECK (crdt_bytes >= 0),
  published_bytes bigint      NOT NULL DEFAULT 0 CHECK (published_bytes >= 0),
  blob_count      integer     NOT NULL DEFAULT 0 CHECK (blob_count >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
