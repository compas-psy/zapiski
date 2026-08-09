/**
 * Каталог строк: английский. Перевод реестра BEHAVIOR §11 с сохранением
 * правил формулировок: без восклицательных знаков, без обвинения пользователя,
 * сообщаем что произошло и что можно сделать.
 */
import type { Catalog } from './ru.js';

export const en: Catalog = {
  errors: {
    offline: 'Offline · everything is saved locally',
    syncFailed: 'Could not sync · Retry',
    noSpace: 'The device is out of space. The note is kept in memory — free some space to write it to disk',
    folderUnavailable: 'The folder is unavailable. It may have been moved — please point to its new location',
    webdavAuth: 'The server did not accept the login or password',
    webdavUnreachable: 'The server is not responding · Retry',
    yandexTokenExpired: 'Please sign in to Yandex.Disk again',
    magicLinkExpired: 'This link is no longer valid. Send a new one?',
    mailNotDelivered: (email: string): string =>
      `The email was sent to ${email}. If it has not arrived, check Spam or send it again`,
    wrongPassword: 'That password did not work',
    tryLater: 'Try again in 30 seconds',
    fileCorrupted: 'Could not read the file. It is still on disk — you can open it in another editor',
    conflictMerged: 'Versions merged · History',
    conflictEncrypted: 'The note changed on two devices. Both versions are kept',
    imageInsertFailed: 'Could not insert the image · Retry',
    subscriptionExpired: 'The subscription has ended. Your notes are here, syncing via KOMPAS cloud is paused',
    importPartial: (imported: number, skipped: number): string => `Imported ${imported} · Skipped ${skipped} — show`,
    linksUpdated: (count: number): string => `Links updated: ${count}`,
    noteArchived: 'Note archived · Undo',
    noteTrashed: 'Note moved to trash · Undo',
  },
  actions: {
    undo: 'Undo',
    retry: 'Retry',
    history: 'History',
    show: 'Show',
    open: 'Open',
  },
  notes: {
    untitled: 'Untitled',
    encryptedPlaceholder: 'encrypted — contents are not searched',
    conflictSuffix: (device: string): string => `(conflict, device ${device})`,
  },
  empty: {
    list: 'It is quiet here',
    folder: 'This folder is empty',
    search: 'Nothing found',
    library: 'No folders yet',
    archive: 'The archive is empty',
    trash: 'The trash is empty',
  },
  sync: {
    synced: 'Synced',
    syncing: 'Syncing',
    offline: 'Offline',
    error: 'Could not sync',
  },
};
