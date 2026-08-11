/**
 * Публичный API `@zapiski/core` (ARCHITECTURE §5: только через `src/index.ts`,
 * глубокие импорты запрещены).
 *
 * Всё, что здесь есть, — платформо-независимо и не знает, где исполняется:
 * веб-PWA, Tauri desktop или Tauri Android (ADR-0001).
 */

// ── Контракт домена и платформенные порты (владелец — CTO) ──────────────────
export type {
  BiometricProvider,
  CryptoProvider,
  EncryptedContainer,
  GlobalHotkeyProvider,
  HapticProvider,
  HapticStrength,
  MasterKey,
  Note,
  NoteId,
  NoteIndex,
  NoteMeta,
  PdfPageSetup,
  PdfRenderer,
  PlatformCapabilities,
  RemoteEntry,
  SearchFilters,
  SearchFragment,
  SearchHit,
  SearchQuery,
  SharedPayload,
  ShareTargetProvider,
  SyncBackend,
  SyncState,
  SyncStatus,
  UndoableToast,
  UpdateInfo,
  UpdaterProvider,
  VaultEntry,
  VaultFolderPicker,
  WindowControls,
  VaultLocation,
  VaultLocationInfo,
  VaultPath,
  VaultStat,
  VaultStorage,
  VaultWriteMode,
  VersionSnapshot,
} from './contract.js';

// ── Порт хранилища в памяти ────────────────────────────────────────────────
export { MemoryVaultStorage, type MemoryVaultStorageOptions } from './memory-storage.js';

// ── Утилиты путей и текста ─────────────────────────────────────────────────
export {
  ancestorDirs,
  ATTACHMENT_EXTENSIONS,
  ATTACHMENTS_DIR,
  baseName,
  CONFIG_FILE,
  CRDT_DIR,
  dirName,
  extName,
  INDEX_FILE,
  isAttachmentPath,
  isCrdtLogPath,
  isEncryptedPath,
  isInside,
  isMetaPath,
  isNotePath,
  joinPath,
  META_DIR,
  normalizePath,
  QUEUE_FILE,
  relativePath,
  stemOf,
  TRASH_DIR,
  VERSIONS_DIR,
} from './util/path.js';
export { countWords, escapeRegExp, isoDate, normalizeText, tokenize, tokenTerms, truncate } from './util/text.js';
export { bytesEqual, fromBase64, fromUtf8, newId, randomBytes, shortHash, toBase64, toHex, utf8 } from './util/bytes.js';

// ── Markdown ───────────────────────────────────────────────────────────────
export {
  extractLinks,
  extractTags,
  extractTitle,
  extractWikiLinks,
  hasTodo,
  isImageUrl,
  parseNote,
  stripInline,
  stripMarkdown,
  type MarkdownLinkRef,
  type ParsedNote,
  type WikiLinkRef,
} from './markdown/parse.js';
export { Frontmatter, joinFrontmatter, splitFrontmatter, type SplitDocument } from './markdown/frontmatter.js';
export { joinTitle, splitTitle, type NoteTitleSplit } from './markdown/title.js';
export { inlineToText, parseBlocks, parseInline, type Block, type Inline, type ListItem } from './markdown/ast.js';

// ── Vault ──────────────────────────────────────────────────────────────────
export {
  RENAME_DELAY_MS,
  TRASH_TTL_DAYS,
  Vault,
  type CreateNoteInput,
  type FolderNode,
  type TrashEntry,
  type VaultOptions,
} from './vault/vault.js';
export { attachmentName, safeFileName, uniqueNotePath } from './vault/naming.js';
export { ensureDir, readJson, readText, writeAtomic, writeJsonAtomic, writeTextAtomic } from './vault/atomic.js';
export {
  commitRename,
  recoverRename,
  rewriteWikiLinks,
  wikiTargetFor,
  type RenameResult,
} from './vault/rename.js';

// ── Индекс и поиск ─────────────────────────────────────────────────────────
export { InvertedIndex, buildFragments, outgoingRefs, passesFilters, referenceKeys } from './index/note-index.js';
export { formatQuery, parseDateToken, parseQuery } from './index/query.js';

// ── Крипто ─────────────────────────────────────────────────────────────────
export {
  CONTAINER_VERSION,
  decodeContainer,
  encodeContainer,
  encodeHeader,
  KEY_ID_LENGTH,
  LEGACY_CONTAINER_VERSION,
  looksEncrypted,
  MAGIC,
  NONCE_LENGTH,
  SALT_LENGTH,
} from './crypto/container.js';
export { ARGON2_PARAMS, unlockDelayMs, WebCryptoProvider, type WebCryptoProviderOptions } from './crypto/provider.js';
export {
  createEncryptedNote,
  decryptNoteFile,
  decryptNoteToDisk,
  encryptedPathOf,
  encryptNoteFile,
  passwordHint,
  plainPathOf,
  rewriteToCurrentVersion,
} from './crypto/notes.js';
/* Счётчик попыток переживает перезапуск (BEHAVIOR §5.2, SEC-024). */
export {
  EMPTY_UNLOCK_GUARD,
  parseUnlockGuard,
  UnlockGuard,
  type UnlockGuardOptions,
  type UnlockGuardRecord,
} from './crypto/unlock-guard.js';

// ── CRDT ───────────────────────────────────────────────────────────────────
export { clientIdFor, diffText, mergeTexts, mergeUpdates, NoteDoc, type TextEdit } from './crdt/doc.js';
export { CrdtStore } from './crdt/store.js';

// ── Синхронизация ──────────────────────────────────────────────────────────
export { SyncEngine, type SyncEngineOptions, type SyncMode, type SyncOutcome } from './sync/engine.js';
export { ChangeQueue, type ChangeKind, type QueuedChange } from './sync/queue.js';
export { MAX_SNAPSHOTS, VersionHistory } from './sync/versions.js';
export { diff3, type Diff3Result } from './sync/diff3.js';
export { etagOf, LocalFolderBackend, PreconditionFailed, type LocalFolderOptions } from './sync/local-folder.js';
export {
  normalizeEtag,
  parsePropfind,
  SyncError,
  WebDAVBackend,
  type FetchLike,
  type WebDAVOptions,
} from './sync/webdav.js';
export { YandexDiskBackend, type YandexDiskOptions } from './sync/yandex.js';
export { ZapiskiCloudBackend, type ZapiskiCloudOptions, type WebSocketLike } from './sync/zapiski-cloud.js';
export {
  API_PREFIX,
  VAULT_ENDPOINTS,
  type CloudEntryDto,
  type CloudErrorDto,
  type CloudListResponse,
  type CloudPullRequest,
  type CloudPullResponse,
  type CloudPushRequest,
  type CloudPushResponse,
  type CloudSubscribeEvent,
} from './sync/protocol.js';

// ── Импорт ─────────────────────────────────────────────────────────────────
export { applyImport, type ApplyImportOptions } from './import/apply.js';
export { importFolder, importFolderZip, type FolderImportOptions } from './import/obsidian.js';
export { importBear, importBearFiles } from './import/bear.js';
export { csvToMarkdownTable, importNotion, importNotionFiles, parseCsv } from './import/notion.js';
export { enmlToMarkdown, importEvernote, parseEnexDate } from './import/evernote.js';
export {
  decode,
  emptyBundle,
  isMarkdownFile,
  unzip,
  type ImportAsset,
  type ImportBundle,
  type ImportNote,
  type ImportReport,
} from './import/types.js';

// ── Экспорт ────────────────────────────────────────────────────────────────
export { escapeHtml, markdownToHtml, renderPrintableHtml, type HtmlExportOptions } from './export/html.js';
export { exportDocx } from './export/docx.js';
export { exportArchive, exportNote, type ArchiveOptions, type ExportFormat } from './export/archive.js';
export { exportPdf, PDF_PAGE_SETUP, renderPdfSource } from './export/pdf.js';

// ── i18n ───────────────────────────────────────────────────────────────────
export { catalog, DEFAULT_LOCALE, en, isLocale, ru, storedLocale, type Catalog, type Locale } from './i18n/i18n.js';
