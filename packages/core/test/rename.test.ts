/**
 * Переименование заметки (BEHAVIOR §2.2, приёмочный критерий №6):
 * «Переименование заметки с 20 входящими ссылками обновляет все 20 или ни одной».
 */
import { describe, expect, it } from 'vitest';
import { MemoryVaultStorage } from '../src/memory-storage.js';
import { Vault } from '../src/vault/vault.js';
import { rewriteWikiLinks } from '../src/vault/rename.js';
import { catalog } from '../src/i18n/i18n.js';

const LINKERS = 20;

/** Vault: одна цель и 20 заметок, ссылающихся на неё. */
async function makeLinkedVault(): Promise<{ vault: Vault; storage: MemoryVaultStorage }> {
  const files: Record<string, string> = {
    'Идея.md': '# Идея\n\nтело заметки\n',
  };
  for (let i = 1; i <= LINKERS; i += 1) {
    files[`Ссылка ${i}.md`] = `# Ссылка ${i}\n\nсм. [[Идея]] и ещё раз [[Идея|как её звали]]\n`;
  }
  const storage = new MemoryVaultStorage({ files });
  const vault = await Vault.open(storage, { renameDelayMs: 0 });
  return { vault, storage };
}

/** Считаем только заметки: снапшот индекса в `.zapiski` — производная. */
function countLinks(storage: MemoryVaultStorage, target: string): number {
  return Object.entries(storage.snapshot()).filter(
    ([path, text]) => !path.startsWith('.zapiski/') && path.endsWith('.md') && text.includes(`[[${target}`),
  ).length;
}

describe('переписывание wiki-ссылок', () => {
  it('сохраняет алиас и якорь', () => {
    const body = 'см. [[Идея]], [[Идея|как её звали]], [[Идея#Раздел]], [[Другая]]';
    const result = rewriteWikiLinks(body, 'Идея', 'Мысль');
    expect(result).toBe('см. [[Мысль]], [[Мысль|как её звали]], [[Мысль#Раздел]], [[Другая]]');
  });

  it('не трогает ссылки внутри кода', () => {
    const body = '`[[Идея]]`\n\n```\n[[Идея]]\n```\n\n[[Идея]]';
    const result = rewriteWikiLinks(body, 'Идея', 'Мысль');
    expect(result?.match(/\[\[Идея\]\]/g)).toHaveLength(2);
    expect(result?.match(/\[\[Мысль\]\]/g)).toHaveLength(1);
  });

  it('возвращает null, если ссылок нет — файл не переписывается', () => {
    expect(rewriteWikiLinks('нет ссылок', 'Идея', 'Мысль')).toBeNull();
  });
});

describe('переименование по заголовку (BEHAVIOR §2.2)', () => {
  it('обновляет все 20 входящих ссылок', async () => {
    const { vault, storage } = await makeLinkedVault();
    await vault.write('Идея.md', '# Мысль\n\nтело заметки\n');
    const results = await vault.flushRenames(true);

    expect(results).toHaveLength(1);
    expect(results[0]?.to).toBe('Мысль.md');
    expect(results[0]?.updatedLinks).toBe(LINKERS);
    expect(countLinks(storage, 'Мысль')).toBe(LINKERS);
    expect(countLinks(storage, 'Идея')).toBe(0);
    expect(storage.snapshot()['Идея.md']).toBeUndefined();
    expect(storage.snapshot()['Мысль.md']).toContain('# Мысль');
  });

  it('текст тоста — дословно из реестра BEHAVIOR §11', async () => {
    const { vault } = await makeLinkedVault();
    await vault.write('Идея.md', '# Мысль\n\nтело\n');
    const [result] = await vault.flushRenames(true);
    expect(catalog('ru').errors.linksUpdated(result?.updatedLinks ?? 0)).toBe('Обновлено ссылок: 20');
  });

  it('при сбое посреди коммита не обновляется НИ ОДНА ссылка', async () => {
    const { vault, storage } = await makeLinkedVault();
    const before = storage.snapshot();
    await vault.write('Идея.md', '# Мысль\n\nтело заметки\n');

    // Сбой на середине коммита: staging уже записан, часть целей переписана.
    // Считаем записи так, чтобы упасть примерно на десятой ссылке.
    storage.failWriteOnce = 2 * LINKERS + 12;
    await expect(vault.flushRenames(true)).rejects.toThrow();
    storage.failWriteOnce = null;

    const after = storage.snapshot();
    expect(countLinks(storage, 'Мысль')).toBe(0);
    expect(countLinks(storage, 'Идея')).toBe(LINKERS);
    expect(after['Идея.md']).toBeDefined();
    expect(after['Мысль.md']).toBeUndefined();
    for (let i = 1; i <= LINKERS; i += 1) {
      expect(after[`Ссылка ${i}.md`]).toBe(before[`Ссылка ${i}.md`]);
    }
  });

  it('журнал незавершённой транзакции откатывается при открытии vault', async () => {
    const { vault, storage } = await makeLinkedVault();
    await vault.write('Идея.md', '# Мысль\n\nтело\n');
    // Диск «умирает» насовсем: откат не доигрывает, журнал остаётся на диске.
    storage.failWriteAfter = 2 * LINKERS + 12;
    await vault.flushRenames(true).catch(() => undefined);
    storage.failWriteAfter = null;

    const reopened = await Vault.open(storage, { renameDelayMs: 0 });
    expect(reopened.notes()).toHaveLength(LINKERS + 1);
    expect(countLinks(storage, 'Идея')).toBe(LINKERS);
    expect(storage.paths().some((path) => path.includes('rename.journal'))).toBe(false);
  });

  it('коллизия имени даёт суффикс, а не перезапись', async () => {
    const { vault, storage } = await makeLinkedVault();
    await vault.create({ title: 'Мысль' });
    await vault.write('Идея.md', '# Мысль\n\nтело\n');
    const [result] = await vault.flushRenames(true);
    expect(result?.to).toBe('Мысль 2.md');
    expect(storage.snapshot()['Мысль.md']).toBeDefined();
  });

  it('переименование ждёт 2 с после прекращения правки первой строки', async () => {
    const storage = new MemoryVaultStorage({ files: { 'Идея.md': '# Идея\n\nтело\n' } });
    let now = 1_700_000_000_000;
    const vault = await Vault.open(storage, { now: () => now });
    await vault.write('Идея.md', '# Мысль\n\nтело\n');

    now += 1500;
    expect(await vault.flushRenames()).toHaveLength(0);
    expect(storage.snapshot()['Идея.md']).toBeDefined();

    now += 700;
    const results = await vault.flushRenames();
    expect(results[0]?.to).toBe('Мысль.md');
  });

  it('перемещение в папку тоже обновляет ссылки', async () => {
    const { vault, storage } = await makeLinkedVault();
    const result = await vault.move('Идея.md', 'Проекты');
    expect(result.to).toBe('Проекты/Идея.md');
    // Имя файла не изменилось — ссылки `[[Идея]]` остаются рабочими.
    expect(countLinks(storage, 'Идея')).toBe(LINKERS);
  });
});
