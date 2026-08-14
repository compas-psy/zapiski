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
    cloudUnreachable: 'Could not reach the cloud · Retry',
    noSpace: 'The device is out of space. The note is kept in memory — free some space to write it to disk',
    folderUnavailable: 'The folder is unavailable. It may have been moved — please point to its new location',
    browserStorageUnavailable:
      'The browser refused storage for your notes — they will only last until you close the tab. Check private mode and site data permissions',
    settingNotSaved: 'Could not save the setting — it will revert on restart',
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
    encryptFailed: 'Could not encrypt the note · Retry',
    subscriptionExpired: 'The subscription has ended. Your notes are here, syncing via Zapiski Cloud is paused',
    subscriptionRequired:
      'Syncing via Zapiski Cloud is part of the subscription. Your notes are here and open as usual',
    importPartial: (imported: number, skipped: number): string => `Imported ${imported} · Skipped ${skipped} — show`,
    linksUpdated: (count: number): string => `Links updated: ${count}`,
    renamedTags: (count: number): string =>
      `Renamed in ${count} note${count === 1 ? '' : 's'}`,
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
    conflictSuffix: (device: string): string =>
      device === '' ? '(conflict)' : `(conflict, device ${device})`,
    conflictPlaceSuffix: (place: string): string => `(conflict, ${place})`,
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
  storage: {
    title: 'Where notes are kept',
    appFolder: 'App folder',
    appFolderNote:
      'Plain .md files on the device. Writing goes through a temporary file, so a power failure does not damage a note',
    chooseFolder: 'Choose another folder',
    useAppFolder: 'Go back to the app folder',
    userFolder: 'Chosen folder',
    warningTitle: 'What to know about the chosen folder',
    stagedNote:
      'A note is written to a temporary file first and only then takes its place. That is nearly as safe as the app folder: the replacement happens in two steps, and a very rare power failure exactly between them can leave the note in its previous version',
    directNote:
      'This folder does not support renaming, so notes are written into it directly. If the power goes out exactly while a note is being written, that note may stay incomplete. Other notes are not affected',
    why: 'In return other apps can see the folder: the Yandex.Disk client, for example, syncs it on its own, with no subscription and no cloud of ours',
    chosen: (folder: string): string => `Notes are now in the “${folder}” folder`,
    returned: 'Notes are back in the app folder',
  },
};
