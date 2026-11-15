import type { Database } from 'better-sqlite3';

import { nowIso } from '../time.js';
import { inBin, notInBin } from './scope.js';

/**
 * Books of one library. Every method takes a REQUIRED `libraryId` and every query filters on
 * it, so a book id from another library is simply not found (get returns null, update and
 * delete affect nothing). Callers authorize with `assertMember(userId, libraryId)` first.
 *
 * Normal reads and writes only see books that are NOT in the Bin (through `notInBin`); the
 * Bin methods at the bottom are the only ones that see binned books (through `inBin`).
 * `books_fts` is kept in sync by the triggers in 001_init.sql, so nothing here touches it.
 */

export type BookSource = 'isbn' | 'excel' | 'manual';

export interface Book {
  readonly id: number;
  readonly libraryId: number;
  readonly isbn13: string | null;
  readonly title: string;
  readonly authors: string;
  readonly publishedYear: number | null;
  readonly publisher: string | null;
  readonly coverPath: string | null;
  readonly source: BookSource;
  readonly addedBy: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface NewBook {
  readonly isbn13?: string | null;
  readonly title: string;
  readonly authors?: string;
  readonly publishedYear?: number | null;
  readonly publisher?: string | null;
  readonly coverPath?: string | null;
  readonly source: BookSource;
  /** Telegram user id of the member who added it; null for CLI / Excel imports. */
  readonly addedBy: number | null;
}

/** Fields that may change after creation. An omitted field is left as it is. */
export interface BookPatch {
  readonly title?: string;
  readonly authors?: string;
  readonly publishedYear?: number | null;
  readonly publisher?: string | null;
  readonly coverPath?: string | null;
}

export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
}

export const MAX_PAGE_SIZE = 100;

interface BookRow {
  id: number;
  library_id: number;
  isbn13: string | null;
  title: string;
  authors: string;
  published_year: number | null;
  publisher: string | null;
  cover_path: string | null;
  source: BookSource;
  added_by: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const BOOK_COLUMNS = `b.id, b.library_id, b.isbn13, b.title, b.authors, b.published_year,
  b.publisher, b.cover_path, b.source, b.added_by, b.created_at, b.updated_at, b.deleted_at`;

function toBook(row: BookRow): Book {
  return {
    id: row.id,
    libraryId: row.library_id,
    isbn13: row.isbn13,
    title: row.title,
    authors: row.authors,
    publishedYear: row.published_year,
    publisher: row.publisher,
    coverPath: row.cover_path,
    source: row.source,
    addedBy: row.added_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

/**
 * SQLite treats a negative LIMIT as "no limit", so page requests are validated instead of being
 * passed through: limit 1..MAX_PAGE_SIZE, offset >= 0, both integers.
 */
function assertValidPage(page: PageRequest): void {
  const validLimit = Number.isInteger(page.limit) && page.limit >= 1 && page.limit <= MAX_PAGE_SIZE;
  const validOffset = Number.isInteger(page.offset) && page.offset >= 0;
  if (!validLimit || !validOffset) {
    throw new RangeError(
      `Invalid page: limit ${String(page.limit)} (1..${String(MAX_PAGE_SIZE)}), offset ${String(page.offset)} (>= 0)`,
    );
  }
}

/** Adds a book to the library. The ISBN stays unique per library, including binned books. */
export function insertBook(db: Database, libraryId: number, book: NewBook): Book {
  const now = nowIso();
  const values = {
    libraryId,
    isbn13: book.isbn13 ?? null,
    title: book.title,
    authors: book.authors ?? '',
    publishedYear: book.publishedYear ?? null,
    publisher: book.publisher ?? null,
    coverPath: book.coverPath ?? null,
    source: book.source,
    addedBy: book.addedBy,
    now,
  };
  const result = db
    .prepare(
      `INSERT INTO books (library_id, isbn13, title, authors, published_year, publisher,
                          cover_path, source, added_by, created_at, updated_at)
       VALUES (@libraryId, @isbn13, @title, @authors, @publishedYear, @publisher,
               @coverPath, @source, @addedBy, @now, @now)`,
    )
    .run(values);
  return {
    id: Number(result.lastInsertRowid),
    libraryId,
    isbn13: values.isbn13,
    title: values.title,
    authors: values.authors,
    publishedYear: values.publishedYear,
    publisher: values.publisher,
    coverPath: values.coverPath,
    source: book.source,
    addedBy: book.addedBy,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

/** A book of this library that is not in the Bin, or null. */
export function getBook(db: Database, libraryId: number, bookId: number): Book | null {
  const row = db
    .prepare(
      `SELECT ${BOOK_COLUMNS} FROM books b
       WHERE b.id = ? AND b.library_id = ? AND ${notInBin('b')}`,
    )
    .get(bookId, libraryId) as BookRow | undefined;
  return row === undefined ? null : toBook(row);
}

/** One page of the library's books that are not in the Bin, in the order they were added. */
export function listBooks(db: Database, libraryId: number, page: PageRequest): Book[] {
  assertValidPage(page);
  const rows = db
    .prepare(
      `SELECT ${BOOK_COLUMNS} FROM books b
       WHERE b.library_id = ? AND ${notInBin('b')}
       ORDER BY b.id
       LIMIT ? OFFSET ?`,
    )
    .all(libraryId, page.limit, page.offset) as BookRow[];
  return rows.map(toBook);
}

/** Number of the library's books that are not in the Bin. */
export function countBooks(db: Database, libraryId: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM books b WHERE b.library_id = ? AND ${notInBin('b')}`)
    .get(libraryId) as { n: number };
  return row.n;
}

/**
 * Updates the given fields of a book that is not in the Bin. Returns false (and changes
 * nothing) when the book is not in this library or is binned.
 */
export function updateBook(
  db: Database,
  libraryId: number,
  bookId: number,
  patch: BookPatch,
): boolean {
  // Static SQL: each column keeps its value unless its "has" flag is set, so null can be written
  // on purpose and no column name is ever built from input.
  const result = db
    .prepare(
      `UPDATE books SET
         title          = CASE WHEN @hasTitle THEN @title ELSE title END,
         authors        = CASE WHEN @hasAuthors THEN @authors ELSE authors END,
         published_year = CASE WHEN @hasPublishedYear THEN @publishedYear ELSE published_year END,
         publisher      = CASE WHEN @hasPublisher THEN @publisher ELSE publisher END,
         cover_path     = CASE WHEN @hasCoverPath THEN @coverPath ELSE cover_path END,
         updated_at     = @now
       WHERE id = @bookId AND library_id = @libraryId AND ${notInBin('books')}`,
    )
    .run({
      hasTitle: patch.title === undefined ? 0 : 1,
      title: patch.title ?? null,
      hasAuthors: patch.authors === undefined ? 0 : 1,
      authors: patch.authors ?? null,
      hasPublishedYear: patch.publishedYear === undefined ? 0 : 1,
      publishedYear: patch.publishedYear ?? null,
      hasPublisher: patch.publisher === undefined ? 0 : 1,
      publisher: patch.publisher ?? null,
      hasCoverPath: patch.coverPath === undefined ? 0 : 1,
      coverPath: patch.coverPath ?? null,
      now: nowIso(),
      bookId,
      libraryId,
    });
  return result.changes > 0;
}

/** Moves a book to the Bin. Returns false if it is not in this library or already binned. */
export function softDeleteBook(db: Database, libraryId: number, bookId: number): boolean {
  const now = nowIso();
  const result = db
    .prepare(
      `UPDATE books SET deleted_at = ?, updated_at = ?
       WHERE id = ? AND library_id = ? AND ${notInBin('books')}`,
    )
    .run(now, now, bookId, libraryId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------------------------
// Bin: the only methods that see binned books.
// ---------------------------------------------------------------------------------------------

/** One page of the library's binned books, most recently deleted first. */
export function listBinBooks(db: Database, libraryId: number, page: PageRequest): Book[] {
  assertValidPage(page);
  const rows = db
    .prepare(
      `SELECT ${BOOK_COLUMNS} FROM books b
       WHERE b.library_id = ? AND ${inBin('b')}
       ORDER BY b.deleted_at DESC, b.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(libraryId, page.limit, page.offset) as BookRow[];
  return rows.map(toBook);
}

/** Number of binned books in the library. */
export function countBinBooks(db: Database, libraryId: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM books b WHERE b.library_id = ? AND ${inBin('b')}`)
    .get(libraryId) as { n: number };
  return row.n;
}

/** Takes a binned book out of the Bin. Returns false if it is not binned in this library. */
export function restoreBook(db: Database, libraryId: number, bookId: number): boolean {
  const result = db
    .prepare(
      `UPDATE books SET deleted_at = NULL, updated_at = ?
       WHERE id = ? AND library_id = ? AND ${inBin('books')}`,
    )
    .run(nowIso(), bookId, libraryId);
  return result.changes > 0;
}

/**
 * Permanently deletes a book that is in this library's Bin (final; cascades to its genre links
 * and read marks). An active book is never purged this way: it must be binned first.
 */
export function purgeBinBook(db: Database, libraryId: number, bookId: number): boolean {
  const result = db
    .prepare(`DELETE FROM books WHERE id = ? AND library_id = ? AND ${inBin('books')}`)
    .run(bookId, libraryId);
  return result.changes > 0;
}
