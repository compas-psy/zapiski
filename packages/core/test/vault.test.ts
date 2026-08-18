import { describe, expect, it } from 'vitest';
import { MemoryVaultStorage } from '../src/memory-storage.js';
import { Vault } from '../src/vault/vault.js';
import { safeFileName, uniqueNotePath } from '../src/vault/naming.js';
import { splitFrontmatter } from '../src/markdown/frontmatter.js';

function clock(start = 1_700_000_000_000): () => number {
  let value = start;
  return () => (value += 1000);
}

async function makeVault(files: Record<string, string> = {}): Promise<{ vault: Vault; storage: MemoryVaultStorage }> {
  const storage = new MemoryVaultStorage({ files });
  const vault = await Vault.open(storage, { now: clock(), renameDelayMs: 0 });
  return { vault, storage };
}

describe('имена файлов (BEHAVIOR §2.2)', () => {
  it('заменяет запрещённые символы на дефис', () => {
    expect(safeFileName('Отчёт: 12/03 <черновик>')).toBe('Отчёт- 12-03 -черновик-');
  });

  it('пустой заголовок даёт «Без названия»', () => {
    expect(safeFileName('   ')).toBe('Без названия');
  });

  it('коллизии разрешаются суффиксами 2, 3', () => {
    const taken = new Set(['Идея.md', 'Идея 2.md']);
    expect(uniqueNotePath('', 'Идея', '.md', (path) => taken.has(path))).toBe('Идея 3.md');
  });
});

describe('vault: чтение и запись', () => {
  it('создаёт заметку, имя файла = заголовок', async () => {
    const { vault } = await makeVault();
    const note = await vault.create({ title: 'Заметка о встрече' });
    expect(note.path).toBe('Заметка о встрече.md');
    expect(note.title).toBe('Заметка о встрече');
    expect(vault.notes()).toHaveLength(1);
  });

  it('работает без frontmatter и не добавляет его (совместимость с Obsidian)', async () => {
    const { vault, storage } = await makeVault();
    const note = await vault.create({ title: 'Без шапки', body: '# Без шапки\n\nтекст' });
    expect(storage.snapshot()[note.path]).toBe('# Без шапки\n\nтекст');
    expect(splitFrontmatter(storage.snapshot()[note.path] as string).frontmatter).toBeNull();
  });

  it('сохраняет и обновляет frontmatter, если он есть', async () => {
    const { vault, storage } = await makeVault({
      'Идея.md': '---\nid: abc\ncreated: 2026-01-01T00:00:00.000Z\ntags:\n  - практика\n---\n# Идея\n\nтело',
    });
    await vault.open();
    const note = await vault.read('Идея.md');
    expect(note?.id).toBe('abc');
    expect(note?.tags).toContain('практика');
    await vault.write('Идея.md', note!.body);
    const text = storage.snapshot()['Идея.md'] as string;
    expect(text.startsWith('---')).toBe(true);
    expect(text).toContain('id: abc');
    expect(text).toContain('updated:');
  });

  /**
   * Заметка из чужого vault'а без H1: заголовка у неё нет, и придумывать его
   * из первой строки нельзя (ITERATION-1 §1). Список назовёт её «Без
   * названия» — и это честнее обрывка текста.
   */
  /**
   * Имя файла — третий источник названия, и для чужих архивов единственный.
   *
   * Заказчик скопировал в папку ЗАПИСОК дерево из Obsidian: «копируются без
   * заголовков самих заметок». У Obsidian имя заметки это имя файла, а
   * `# Заголовок` в тексте не обязателен — мы же смотрели только в текст и во
   * frontmatter, и весь чужой архив приезжал списком «Без названия».
   */
  it('файл без H1 называется по имени файла, текст не трогается', async () => {
    const text = 'Просто первая строка\n\nдальше текст';
    const { vault, storage } = await makeVault({ 'Идеи на пятницу.md': text });
    await vault.open();
    const note = await vault.read('Идеи на пятницу.md');
    expect(note?.title).toBe('Идеи на пятницу');
    /* И это НЕ «безымянная» заметка: приглушать её в списке не за что. */
    expect(note?.untitled).toBeUndefined();
    /* Текст файла при этом не меняется ни на байт: заголовок мы не дописываем. */
    expect(storage.snapshot()['Идеи на пятницу.md']).toBe(text);
  });

  it('своя заметка без заголовка остаётся «Без названия»', async () => {
    /* Обратная сторона того же правила: файл, который так и называется, — это
       наша заметка, созданная без заголовка, и список обязан приглушить её. */
    const { vault } = await makeVault({ 'Без названия.md': 'текст без заголовка' });
    await vault.open();
    const note = await vault.read('Без названия.md');
    expect(note?.title).toBe('Без названия');
    expect(note?.untitled).toBe(true);
  });

  it('атомарная запись не оставляет временных файлов', async () => {
    const { vault, storage } = await makeVault();
    await vault.create({ title: 'Атомарность' });
    expect(storage.paths().some((path) => path.endsWith('.tmp'))).toBe(false);
  });
});

describe('vault: корзина, архив, закрепление', () => {
  it('удаление кладёт в корзину и отменяется тостом', async () => {
    const { vault } = await makeVault();
    const note = await vault.create({ title: 'Черновик' });
    const toast = await vault.trash(note.path);
    expect(toast.message).toBe('Заметка в корзине');
    expect(vault.notes()).toHaveLength(0);
    expect(vault.listTrash()).toHaveLength(1);
    await toast.onAction?.();
    expect(vault.notes()).toHaveLength(1);
  });

  it('тост не повторяет подпись своей же кнопки', async () => {
    /*
     * Заказчик увидел это на снимке корзины: «Заметка в корзине · Отменить»
     * рядом с кнопкой «Отменить» — слово напечатано дважды. Реестр
     * BEHAVIOR §11 описывал тост целиком, вместе с действием, а код читал ту
     * же строку как ТЕКСТ и добавлял кнопку от себя.
     *
     * Проверка написана на паре, а не на строке: важно не «текст такой-то», а
     * «текст и кнопка не дублируют друг друга» — то есть свойство, которое
     * легко потерять в любом следующем тосте с действием.
     */
    const { vault } = await makeVault();
    const note = await vault.create({ title: 'Черновик' });

    for (const toast of [await vault.archiveWithUndo(note.path), await vault.trash(note.path)]) {
      expect(toast.actionLabel, 'у тоста с отменой нет подписи действия').toBeTruthy();
      expect(
        toast.message.includes(toast.actionLabel as string),
        `тост «${toast.message}» повторяет свою кнопку «${toast.actionLabel}»`,
      ).toBe(false);
    }
  });

  it('чистка корзины удаляет только записи старше 30 дней', async () => {
    const storage = new MemoryVaultStorage();
    let now = 1_700_000_000_000;
    const vault = await Vault.open(storage, { now: () => now, renameDelayMs: 0 });
    const old = await vault.create({ title: 'Старое' });
    await vault.trash(old.path);
    now += 31 * 86_400_000;
    const fresh = await vault.create({ title: 'Свежее' });
    await vault.trash(fresh.path);
    expect(await vault.purgeTrash()).toBe(1);
    expect(vault.listTrash()).toHaveLength(1);
  });

  it('архивация — отменяемая операция с текстом из реестра', async () => {
    const { vault } = await makeVault();
    const note = await vault.create({ title: 'В архив' });
    const toast = await vault.archiveWithUndo(note.path);
    expect(toast.message).toBe('Заметка в архиве');
    expect(vault.metaOf(note.path)?.archived).toBe(true);
    await toast.onAction?.();
    expect(vault.metaOf(note.path)?.archived).toBe(false);
  });

  it('закрепление переживает перечитывание индекса', async () => {
    const { vault, storage } = await makeVault();
    const note = await vault.create({ title: 'Важное' });
    await vault.setPinned(note.path, true);
    await vault.persist();
    const reopened = await Vault.open(storage, { renameDelayMs: 0 });
    expect(reopened.metaOf(note.path)?.pinned).toBe(true);
  });
});

describe('vault: вложения (ТЗ §3.2)', () => {
  it('кладёт файл в папку по типу и даёт относительную ссылку', async () => {
    const { vault } = await makeVault();
    const data = new Uint8Array([1, 2, 3, 4]);
    const { path, markdown } = await vault.addAttachment(data, 'png');
    /* `Images`, а не старая единая `attachments`: раскладка по типу — та, что
       живёт в настройках и в библиотеке. */
    expect(path).toMatch(/^Images\/\d{4}-\d{2}-\d{2}_[0-9a-f]{6}\.png$/);
    expect(markdown).toBe(`![](${path})`);
  });

  it('находит осиротевшие вложения', async () => {
    const { vault } = await makeVault();
    const used = await vault.addAttachment(new Uint8Array([1]), 'png');
    await vault.addAttachment(new Uint8Array([2, 2]), 'png');
    await vault.create({ title: 'С картинкой', body: `# С картинкой\n\n![](${used.path})` });
    const orphans = await vault.orphanAttachments();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).not.toBe(used.path);
  });
});

describe('vault: индекс — производная (ТЗ §2.1.1)', () => {
  it('полностью восстанавливается после удаления .zapiski', async () => {
    const { vault, storage } = await makeVault();
    await vault.create({ title: 'Первая', body: '# Первая\n\n#тег текст' });
    await vault.create({ title: 'Вторая', folder: 'Проекты' });
    await vault.persist();
    await storage.remove('.zapiski');
    const reopened = await Vault.open(storage, { renameDelayMs: 0 });
    expect(reopened.notes()).toHaveLength(2);
    expect(reopened.index.byTag('тег')).toHaveLength(1);
  });

  it('переживает повреждённый снапшот индекса', async () => {
    const { vault, storage } = await makeVault();
    await vault.create({ title: 'Живая' });
    await vault.persist();
    await storage.write('.zapiski/index.json', new TextEncoder().encode('{ это не json'));
    const reopened = await Vault.open(storage, { renameDelayMs: 0 });
    expect(reopened.notes()).toHaveLength(1);
  });
});

describe('vault: папки как реальные каталоги', () => {
  it('строит дерево папок со счётчиками', async () => {
    const { vault } = await makeVault();
    await vault.create({ title: 'Идея', folder: 'Проекты' });
    await vault.create({ title: 'Задача', folder: 'Проекты/Работа' });
    const tree = await vault.folders();
    expect(tree.map((node) => node.name)).toContain('Проекты');
    const projects = tree.find((node) => node.name === 'Проекты');
    expect(projects?.count).toBe(2);
    expect(projects?.children.map((child) => child.name)).toEqual(['Работа']);
  });

  it('перемещает заметку между папками', async () => {
    const { vault } = await makeVault();
    const note = await vault.create({ title: 'Переезд' });
    const result = await vault.move(note.path, 'Архивы');
    expect(result.to).toBe('Архивы/Переезд.md');
    expect(vault.metaOf('Архивы/Переезд.md')).toBeDefined();
  });
});
