/**
 * Инвертированный индекс и FTS (ADR-0002): `Map<term, ...>` + фильтры по
 * метаданным. Без SQLite, один и тот же код на всех платформах.
 *
 * Бюджет ТЗ §5.2 — поиск <50 мс на 10 000 заметок — закреплён
 * `test/perf.test.ts`.
 */
import type {
  Note,
  NoteId,
  NoteIndex,
  NoteMeta,
  SearchFragment,
  SearchHit,
  SearchQuery,
  VaultPath,
} from '../contract.js';
import { extractLinks, extractWikiLinks, stripMarkdown } from '../markdown/parse.js';
import { dirName, joinPath, normalizePath, stemOf } from '../util/path.js';
import { normalizeText, tokenize } from '../util/text.js';

/** Контекст фрагмента — ±40 символов (BEHAVIOR §4). */
const FRAGMENT_CONTEXT = 40;
/** До 3 фрагментов на заметку (BEHAVIOR §4). */
const MAX_FRAGMENTS = 3;
/** Ограничение выдачи по умолчанию (BEHAVIOR §4). */
const DEFAULT_LIMIT = 200;

/**
 * Чем платим за поиск: временем или памятью.
 *
 * Решение заказчика: «можно сделать ползунок в настройках: скорость поиска ↔
 * память и пусть пользователь выбирает. По умолчанию — скорость поиска».
 *
 * `speed` — нормализованный текст лежит рядом с исходным: поиск подстрок и
 * фраз идёт по готовой строке. Это вторая копия корпуса в памяти.
 * `memory` — второй копии нет, нормализация считается на лету и только для
 * заметок-кандидатов. На большом хранилище это заметно дешевле по памяти и
 * заметно дороже по времени запроса.
 */
export type IndexMode = 'speed' | 'memory';

interface IndexedNote {
  meta: NoteMeta;
  /** Текст без разметки. У зашифрованных — пустая строка (ТЗ §3.3). */
  plain: string;
  /**
   * Нормализованный текст той же длины — для поиска подстрок и фраз.
   * `null` в режиме экономии памяти: считается на лету при запросе.
   */
  normalized: string | null;
  normalizedTitle: string;
  /** Ключи, по которым на заметку можно сослаться. */
  refKeys: string[];
  /** Нормализованные цели исходящих ссылок. */
  outRefs: string[];
}

/**
 * Нормализация, сохраняющая длину строки: смещения фрагментов подсветки
 * обязаны совпадать с исходным текстом.
 *
 * ── Почему не посимвольная склейка ──────────────────────────────────────────
 *
 * Здесь стояло `out += ...` в цикле по символам, и это стоило приложению
 * ВОСЬМИДЕСЯТИ мегабайт памяти на тысяче заметок. Причина в устройстве строк
 * V8: каждое `+=` не дописывает буфер, а заводит узел-склейку (ConsString),
 * который держит обе половины. Строка в 2700 знаков превращалась в дерево из
 * ~2700 узлов по ~32 байта — в шестнадцать раз дороже самого текста. Снимок
 * кучи показал это прямо: 4,65 миллиона строковых объектов мельче 64 байт на
 * 81 МБ при корпусе в 2,7 МБ.
 *
 * Быстрый путь — целиком нативным `toLowerCase()`. Он покрывает всё, кроме
 * редких букв, у которых строчная форма длиннее прописной (турецкое «İ»);
 * такие ломают главный инвариант — совпадение длин, — и только ради них
 * остаётся посимвольный разбор. Но и он теперь собирает массив и склеивает
 * его один раз: `join` даёт ПЛОСКУЮ строку без дерева склеек.
 */
function normalizeKeepingLength(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) {
    return lower.includes('ё') ? lower.replaceAll('ё', 'е') : lower;
  }
  const parts: string[] = [];
  for (const char of text) {
    const one = char.toLowerCase();
    parts.push(one.length === char.length ? (one === 'ё' ? 'е' : one) : char);
  }
  return parts.join('');
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}

/** Ключи, по которым заметку находят ссылки: заголовок, имя файла, путь. */
export function referenceKeys(meta: NoteMeta): string[] {
  const withoutExt = meta.path.replace(/\.md(\.enc)?$/, '');
  const keys = new Set<string>([
    normalizeText(meta.title),
    normalizeText(stemOf(meta.path)),
    normalizeText(withoutExt),
  ]);
  keys.delete('');
  return [...keys];
}

function hasScheme(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

/** Нормализованные цели исходящих ссылок заметки — `[[wiki]]` и markdown. */
export function outgoingRefs(path: VaultPath, body: string): string[] {
  const out = new Set<string>();
  for (const link of extractWikiLinks(body)) {
    const target = link.target.replace(/\.md$/i, '');
    out.add(normalizeText(target));
    out.add(normalizeText(normalizePath(target)));
  }
  for (const link of extractLinks(body)) {
    const url = link.url;
    if (url === '' || hasScheme(url) || url.startsWith('#')) continue;
    const clean = url.split('#')[0] as string;
    if (!/\.md$/i.test(clean)) continue;
    const resolved = joinPath(dirName(path), clean).replace(/\.md$/i, '');
    out.add(normalizeText(resolved));
    out.add(normalizeText(stemOf(clean)));
  }
  out.delete('');
  return [...out];
}

interface Scored {
  entry: IndexedNote;
  score: number;
  needles: string[];
}

export class InvertedIndex implements NoteIndex {
  private notes = new Map<NoteId, IndexedNote>();
  /** Чем платим за поиск. Умолчание — скоростью запроса (решение заказчика). */
  private mode: IndexMode = 'speed';
  private byPath = new Map<VaultPath, NoteId>();
  /** term → заметки, где терм встречается в заголовке. */
  private titlePostings = new Map<string, Set<NoteId>>();
  /** term → заметка → число вхождений в теле. */
  private bodyPostings = new Map<string, Map<NoteId, number>>();
  private tagPostings = new Map<string, Set<NoteId>>();
  /** Ключ ссылки → заметки-источники. */
  private refIndex = new Map<string, Set<NoteId>>();
  /** Отсортированный список термов для префиксного поиска; ленивый кеш. */
  private sortedTerms: string[] | null = null;

  // ── Изменение состава ──────────────────────────────────────────────────────

  /**
   * Переключить размен «скорость ↔ память».
   *
   * Переключение немедленное и без перестройки индекса: постинги, по которым
   * ищутся термы, от режима не зависят — меняется только то, хранится ли
   * вторая копия текста. Поэтому переключатель в настройках отвечает сразу, а
   * не заставляет ждать переиндексации хранилища.
   */
  setMode(mode: IndexMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    for (const entry of this.notes.values()) {
      entry.normalized = mode === 'memory' ? null : normalizeKeepingLength(entry.plain);
    }
  }

  /** Нынешний размен — его показывают настройки и сторожат тесты. */
  get indexMode(): IndexMode {
    return this.mode;
  }

  /** Нормализованный текст заметки: готовый или посчитанный на месте. */
  private normalizedOf(entry: IndexedNote): string {
    return entry.normalized ?? normalizeKeepingLength(entry.plain);
  }

  add(note: Note): void {
    this.remove(note.id);
    const encrypted = note.encrypted;
    // Зашифрованные заметки не попадают в индекс вовсе (ТЗ §3.3): ни тело,
    // ни заголовок. В выдаче — только плейсхолдер по имени файла.
    const plain = encrypted ? '' : stripMarkdown(note.body);
    const entry: IndexedNote = {
      meta: { ...note as NoteMeta },
      plain,
      normalized: this.mode === 'memory' ? null : normalizeKeepingLength(plain),
      normalizedTitle: encrypted ? '' : normalizeKeepingLength(note.title),
      refKeys: referenceKeys(note),
      outRefs: encrypted ? [] : outgoingRefs(note.path, note.body),
    };
    this.notes.set(note.id, entry);
    this.byPath.set(note.path, note.id);
    if (!encrypted) {
      for (const token of tokenize(note.title)) {
        let set = this.titlePostings.get(token.term);
        if (!set) {
          set = new Set();
          this.titlePostings.set(token.term, set);
        }
        set.add(note.id);
      }
      for (const token of tokenize(plain)) {
        let postings = this.bodyPostings.get(token.term);
        if (!postings) {
          postings = new Map();
          this.bodyPostings.set(token.term, postings);
        }
        postings.set(note.id, (postings.get(note.id) ?? 0) + 1);
      }
      for (const tag of note.tags) {
        const key = normalizeText(tag);
        let set = this.tagPostings.get(key);
        if (!set) {
          set = new Set();
          this.tagPostings.set(key, set);
        }
        set.add(note.id);
      }
      for (const ref of entry.outRefs) {
        let set = this.refIndex.get(ref);
        if (!set) {
          set = new Set();
          this.refIndex.set(ref, set);
        }
        set.add(note.id);
      }
    }
    this.sortedTerms = null;
  }

  update(note: Note): void {
    this.add(note);
  }

  remove(id: NoteId): void {
    const entry = this.notes.get(id);
    if (!entry) return;
    this.notes.delete(id);
    if (this.byPath.get(entry.meta.path) === id) this.byPath.delete(entry.meta.path);
    for (const [term, set] of this.titlePostings) {
      if (set.delete(id) && set.size === 0) this.titlePostings.delete(term);
    }
    for (const [term, postings] of this.bodyPostings) {
      if (postings.delete(id) && postings.size === 0) this.bodyPostings.delete(term);
    }
    for (const [tag, set] of this.tagPostings) {
      if (set.delete(id) && set.size === 0) this.tagPostings.delete(tag);
    }
    for (const [key, set] of this.refIndex) {
      if (set.delete(id) && set.size === 0) this.refIndex.delete(key);
    }
    this.sortedTerms = null;
  }

  /** Полная перестройка — индекс всегда производная (ТЗ §2.1.1). */
  rebuild(notes: Note[]): void {
    this.notes.clear();
    this.byPath.clear();
    this.titlePostings.clear();
    this.bodyPostings.clear();
    this.tagPostings.clear();
    this.refIndex.clear();
    this.sortedTerms = null;
    for (const note of notes) this.add(note);
  }

  // ── Чтение ─────────────────────────────────────────────────────────────────

  all(): NoteMeta[] {
    return [...this.notes.values()].map((entry) => entry.meta);
  }

  get size(): number {
    return this.notes.size;
  }

  get(id: NoteId): NoteMeta | undefined {
    return this.notes.get(id)?.meta;
  }

  byPathLookup(path: VaultPath): NoteMeta | undefined {
    const id = this.byPath.get(normalizePath(path));
    return id === undefined ? undefined : this.notes.get(id)?.meta;
  }

  /** Вложенный тег: `tag:практика` находит и `практика/супервизия`. */
  byTag(tag: string): NoteMeta[] {
    const key = normalizeText(tag.replace(/^#/, ''));
    const out: NoteMeta[] = [];
    for (const [candidate, ids] of this.tagPostings) {
      if (candidate !== key && !candidate.startsWith(`${key}/`)) continue;
      for (const id of ids) {
        const entry = this.notes.get(id);
        if (entry && !out.includes(entry.meta)) out.push(entry.meta);
      }
    }
    return out;
  }

  byFolder(folder: VaultPath): NoteMeta[] {
    const base = normalizePath(folder);
    return this.all().filter((meta) => (base === '' ? true : meta.path.startsWith(`${base}/`)));
  }

  /** Кто ссылается на заметку — `[[wiki]]` и markdown-ссылки (BEHAVIOR §2.10). */
  backlinks(id: NoteId): NoteMeta[] {
    const entry = this.notes.get(id);
    if (!entry) return [];
    const sources = new Set<NoteId>();
    for (const key of entry.refKeys) {
      for (const source of this.refIndex.get(key) ?? []) if (source !== id) sources.add(source);
    }
    return [...sources]
      .map((source) => this.notes.get(source)?.meta)
      .filter((meta): meta is NoteMeta => meta !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Все известные теги с частотой — для автодополнения (BEHAVIOR §2.4). */
  tagFrequencies(): Array<{ tag: string; count: number }> {
    const out: Array<{ tag: string; count: number }> = [];
    for (const [tag, ids] of this.tagPostings) out.push({ tag, count: ids.size });
    return out.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ru'));
  }

  // ── Поиск ──────────────────────────────────────────────────────────────────

  private terms(): string[] {
    if (this.sortedTerms === null) {
      const all = new Set<string>([...this.titlePostings.keys(), ...this.bodyPostings.keys()]);
      this.sortedTerms = [...all].sort();
    }
    return this.sortedTerms;
  }

  /** Термы с данным префиксом — бинарный поиск по отсортированному списку. */
  private prefixTerms(prefix: string, limit = 64): string[] {
    const terms = this.terms();
    let low = 0;
    let high = terms.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((terms[mid] as string) < prefix) low = mid + 1;
      else high = mid;
    }
    const out: string[] = [];
    for (let i = low; i < terms.length && out.length < limit; i += 1) {
      const term = terms[i] as string;
      if (!term.startsWith(prefix)) break;
      out.push(term);
    }
    return out;
  }

  private candidatesForTerm(term: string): { title: Set<NoteId>; body: Map<NoteId, number>; matched: string[] } {
    const title = new Set<NoteId>();
    const body = new Map<NoteId, number>();
    const matched: string[] = [];
    const exact = this.titlePostings.get(term);
    const exactBody = this.bodyPostings.get(term);
    if (exact || exactBody) matched.push(term);
    if (exact) for (const id of exact) title.add(id);
    if (exactBody) for (const [id, count] of exactBody) body.set(id, (body.get(id) ?? 0) + count);
    // Префиксное совпадение: поиск работает по мере ввода (BEHAVIOR §4, debounce 120 мс).
    for (const candidate of this.prefixTerms(term)) {
      if (candidate === term) continue;
      matched.push(candidate);
      for (const id of this.titlePostings.get(candidate) ?? []) title.add(id);
      for (const [id, count] of this.bodyPostings.get(candidate) ?? []) {
        body.set(id, (body.get(id) ?? 0) + count * 0.5);
      }
    }
    return { title, body, matched };
  }

  search(query: SearchQuery, limit: number = DEFAULT_LIMIT): SearchHit[] {
    const filters = query.filters;
    const queryTerms = tokenize(query.text).map((token) => token.term);
    const phrases = (filters.phrases ?? []).map((phrase) => normalizeText(phrase)).filter((p) => p !== '');
    const excluded = (filters.exclude ?? []).map((term) => normalizeText(term)).filter((t) => t !== '');

    const scored: Scored[] = [];
    const encryptedHits: IndexedNote[] = [];

    // Кандидаты: пересечение постингов по всем термам запроса (AND).
    let candidates: Set<NoteId> | null = null;
    const perTerm: Array<{ title: Set<NoteId>; body: Map<NoteId, number>; matched: string[] }> = [];
    for (const term of queryTerms) {
      const posting = this.candidatesForTerm(term);
      perTerm.push(posting);
      const union = new Set<NoteId>([...posting.title, ...posting.body.keys()]);
      candidates = candidates === null ? union : intersect(candidates, union);
    }
    if (candidates === null) candidates = new Set(this.notes.keys());

    for (const id of candidates) {
      const entry = this.notes.get(id);
      if (!entry) continue;
      if (entry.meta.encrypted) continue;
      if (!passesFilters(entry.meta, filters)) continue;

      // Фразы — точное вхождение подстроки в заголовок или тело.
      let phraseScore = 0;
      let phraseOk = true;
      for (const phrase of phrases) {
        const inTitle = entry.normalizedTitle.includes(phrase);
        const inBody = this.normalizedOf(entry).includes(phrase);
        if (!inTitle && !inBody) {
          phraseOk = false;
          break;
        }
        phraseScore += inTitle ? 20 : 6;
      }
      if (!phraseOk) continue;

      // Исключения: `-слово` (BEHAVIOR §4).
      let hasExcluded = false;
      for (const term of excluded) {
        if (
          (this.bodyPostings.get(term)?.has(id) ?? false) ||
          (this.titlePostings.get(term)?.has(id) ?? false) ||
          this.normalizedOf(entry).includes(term) ||
          entry.normalizedTitle.includes(term)
        ) {
          hasExcluded = true;
          break;
        }
      }
      if (hasExcluded) continue;

      // Ранжирование: совпадение в заголовке > в тексте (BEHAVIOR §4).
      let score = phraseScore;
      const needles: string[] = [...phrases];
      for (let i = 0; i < perTerm.length; i += 1) {
        const posting = perTerm[i] as (typeof perTerm)[number];
        if (posting.title.has(id)) score += 10;
        const count = posting.body.get(id);
        if (count !== undefined && count > 0) score += 2 + Math.min(count, 10) * 0.2;
        needles.push(...posting.matched);
      }
      if (queryTerms.length === 0 && phrases.length === 0) score = 1;
      scored.push({ entry, score, needles });
    }

    // Зашифрованные: только по совпадению с именем-плейсхолдером, в конце
    // выдачи, без фрагментов (BEHAVIOR §4).
    if (queryTerms.length > 0 || phrases.length > 0) {
      const placeholderNeedles = [...queryTerms, ...phrases];
      for (const entry of this.notes.values()) {
        if (!entry.meta.encrypted) continue;
        if (!passesFilters(entry.meta, filters)) continue;
        const name = normalizeText(stemOf(entry.meta.path));
        if (placeholderNeedles.some((needle) => name.includes(needle))) encryptedHits.push(entry);
      }
    }

    scored.sort((a, b) => b.score - a.score || b.entry.meta.updatedAt - a.entry.meta.updatedAt);

    const hits: SearchHit[] = [];
    for (const item of scored.slice(0, limit)) {
      hits.push({
        note: item.entry.meta,
        score: Math.round(item.score * 100) / 100,
        fragments: buildFragments(
          item.entry.plain,
          this.normalizedOf(item.entry),
          item.needles,
        ),
        encryptedPlaceholder: false,
      });
    }
    for (const entry of encryptedHits.slice(0, Math.max(0, limit - hits.length))) {
      hits.push({ note: entry.meta, score: 0, fragments: [], encryptedPlaceholder: true });
    }
    return hits;
  }

  // ── Персистентность (`.zapiski/index.json`, ADR-0002) ──────────────────────

  toJSON(): IndexSnapshot {
    return {
      version: INDEX_VERSION,
      notes: [...this.notes.values()].map((entry) => ({ meta: entry.meta, plain: entry.plain, refs: entry.outRefs })),
    };
  }

  /**
   * Загрузка снапшота. Возвращает false, если снапшот отсутствует, битый или
   * другой версии — вызывающий обязан сделать полную перестройку из `.md`.
   */
  loadSnapshot(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const snapshot = raw as Partial<IndexSnapshot>;
    if (snapshot.version !== INDEX_VERSION || !Array.isArray(snapshot.notes)) return false;
    try {
      this.rebuild([]);
      for (const item of snapshot.notes) {
        if (!item || typeof item !== 'object' || !item.meta || typeof item.plain !== 'string') return false;
        const meta = item.meta;
        const entry: IndexedNote = {
          meta,
          plain: item.plain,
          normalized: this.mode === 'memory' ? null : normalizeKeepingLength(item.plain),
          normalizedTitle: meta.encrypted ? '' : normalizeKeepingLength(meta.title),
          refKeys: referenceKeys(meta),
          outRefs: Array.isArray(item.refs) ? item.refs : [],
        };
        this.notes.set(meta.id, entry);
        this.byPath.set(meta.path, meta.id);
        if (meta.encrypted) continue;
        for (const token of tokenize(meta.title)) addToSet(this.titlePostings, token.term, meta.id);
        for (const token of tokenize(item.plain)) {
          let postings = this.bodyPostings.get(token.term);
          if (!postings) {
            postings = new Map();
            this.bodyPostings.set(token.term, postings);
          }
          postings.set(meta.id, (postings.get(meta.id) ?? 0) + 1);
        }
        for (const tag of meta.tags) addToSet(this.tagPostings, normalizeText(tag), meta.id);
        for (const ref of entry.outRefs) addToSet(this.refIndex, ref, meta.id);
      }
      this.sortedTerms = null;
      return this.notes.size === snapshot.notes.length;
    } catch {
      this.rebuild([]);
      return false;
    }
  }
}

export const INDEX_VERSION = 1;

export interface IndexSnapshot {
  version: number;
  notes: Array<{ meta: NoteMeta; plain: string; refs: string[] }>;
}

function addToSet(map: Map<string, Set<NoteId>>, key: string, id: NoteId): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(id);
}

function intersect(a: Set<NoteId>, b: Set<NoteId>): Set<NoteId> {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set<NoteId>();
  for (const id of small) if (large.has(id)) out.add(id);
  return out;
}

/** Фильтры по метаданным: `tag:` `folder:` `before:` `after:` `has:`. */
export function passesFilters(meta: NoteMeta, filters: import('../contract.js').SearchFilters): boolean {
  if (filters.before !== undefined && meta.updatedAt >= filters.before) return false;
  if (filters.after !== undefined && meta.updatedAt < filters.after) return false;
  if (filters.tag && filters.tag.length > 0) {
    const noteTags = meta.tags.map((tag) => normalizeText(tag));
    const ok = filters.tag.every((wanted) => {
      const key = normalizeText(wanted.replace(/^#/, ''));
      return noteTags.some((tag) => tag === key || tag.startsWith(`${key}/`));
    });
    if (!ok) return false;
  }
  if (filters.folder && filters.folder.length > 0) {
    const ok = filters.folder.some((folder) => {
      const base = normalizePath(folder);
      if (base === '') return true;
      const prefix = `${normalizeText(base)}/`;
      return normalizeText(meta.path).startsWith(prefix);
    });
    if (!ok) return false;
  }
  for (const has of filters.has ?? []) {
    if (has === 'image' && !meta.hasImage) return false;
    if (has === 'file' && !meta.hasFile) return false;
    if (has === 'todo' && !meta.hasTodo) return false;
    if (has === 'link' && !meta.hasLink) return false;
  }
  return true;
}

/**
 * До 3 фрагментов с контекстом ±40 символов и диапазонами для подсветки
 * (BEHAVIOR §4, contract.ts `SearchFragment`).
 */
export function buildFragments(plain: string, normalized: string, needles: string[]): SearchFragment[] {
  const unique = [...new Set(needles.filter((needle) => needle !== ''))];
  if (unique.length === 0 || plain === '') return [];

  const occurrences: Array<[number, number]> = [];
  for (const needle of unique) {
    let from = 0;
    for (;;) {
      const at = normalized.indexOf(needle, from);
      if (at === -1) break;
      // Совпадение должно начинаться на границе слова — иначе подсветка
      // прыгает по середине слов.
      if (!isWordChar(normalized[at - 1])) occurrences.push([at, at + needle.length]);
      from = at + Math.max(1, needle.length);
      if (occurrences.length > 200) break;
    }
  }
  if (occurrences.length === 0) return [];
  occurrences.sort((a, b) => a[0] - b[0]);

  const fragments: SearchFragment[] = [];
  let index = 0;
  while (index < occurrences.length && fragments.length < MAX_FRAGMENTS) {
    const first = occurrences[index] as [number, number];
    let start = Math.max(0, first[0] - FRAGMENT_CONTEXT);
    let end = Math.min(plain.length, first[1] + FRAGMENT_CONTEXT);
    const inside: Array<[number, number]> = [first];
    index += 1;
    // Соседние совпадения, попадающие в то же окно, склеиваем.
    while (index < occurrences.length) {
      const next = occurrences[index] as [number, number];
      if (next[0] > end) break;
      end = Math.min(plain.length, Math.max(end, next[1] + FRAGMENT_CONTEXT));
      inside.push(next);
      index += 1;
    }
    // Не режем посреди слова.
    while (start > 0 && isWordChar(plain[start - 1]) && isWordChar(plain[start])) start -= 1;
    while (end < plain.length && isWordChar(plain[end - 1]) && isWordChar(plain[end])) end += 1;
    const text = plain.slice(start, end).replace(/\s+/g, ' ');
    // Схлопывание пробелов меняет смещения — пересчитываем диапазоны по
    // очищенному тексту, сопоставляя те же подстроки.
    const cleanNormalized = normalizeKeepingLength(text);
    const ranges: Array<[number, number]> = [];
    for (const [hitStart, hitEnd] of inside) {
      const needle = normalized.slice(hitStart, hitEnd);
      const at = cleanNormalized.indexOf(needle);
      if (at !== -1 && !ranges.some(([s]) => s === at)) ranges.push([at, at + needle.length]);
    }
    fragments.push({
      text: (start > 0 ? '…' : '') + text.trim() + (end < plain.length ? '…' : ''),
      ranges: ranges.map(([s, e]) => {
        const shift = (start > 0 ? 1 : 0) - (text.length - text.trimStart().length);
        return [s + shift, e + shift] as [number, number];
      }),
    });
  }
  return fragments;
}
