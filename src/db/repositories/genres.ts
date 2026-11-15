import type { Database } from 'better-sqlite3';

import { notInBin } from './scope.js';

/**
 * Genres are per library. Every method takes a REQUIRED `libraryId` and filters on it; a book
 * can only be tagged with genres of its own library (checked here and by a DB trigger).
 */

export interface Genre {
  readonly id: number;
  readonly libraryId: number;
  readonly name: string;
}

interface GenreRow {
  id: number;
  library_id: number;
  name: string;
}

export class GenreNotFoundError extends Error {
  readonly libraryId: number;
  readonly genreId: number;

  constructor(libraryId: number, genreId: number) {
    super(`Genre ${String(genreId)} not found in library ${String(libraryId)}`);
    this.name = 'GenreNotFoundError';
    this.libraryId = libraryId;
    this.genreId = genreId;
  }
}

const UKRAINIAN_LOCALE = 'uk';

function toGenre(row: GenreRow): Genre {
  return { id: row.id, libraryId: row.library_id, name: row.name };
}

function foldGenreName(name: string): string {
  return name.toLocaleLowerCase(UKRAINIAN_LOCALE);
}

/** The library's genres, alphabetically (Ukrainian collation). */
export function listGenres(db: Database, libraryId: number): Genre[] {
  const rows = db
    .prepare('SELECT id, library_id, name FROM genres WHERE library_id = ?')
    .all(libraryId) as GenreRow[];
  return rows
    .map(toGenre)
    .sort((a, b) => a.name.localeCompare(b.name, UKRAINIAN_LOCALE) || a.id - b.id);
}

/**
 * Creates a genre, or returns the library's existing one with the same name ignoring case.
 * The column's NOCASE collation folds ASCII only, so «Фентезі» and «фентезі» are compared here
 * with Ukrainian case folding against the library's existing genres.
 */
export function createGenre(db: Database, libraryId: number, name: string): Genre {
  const trimmed = name.trim();
  const wanted = foldGenreName(trimmed);
  const existing = listGenres(db, libraryId).find((genre) => foldGenreName(genre.name) === wanted);
  if (existing !== undefined) return existing;

  const result = db
    .prepare('INSERT INTO genres (library_id, name) VALUES (?, ?)')
    .run(libraryId, trimmed);
  return { id: Number(result.lastInsertRowid), libraryId, name: trimmed };
}

/** Genres of a book of this library (not in the Bin), alphabetically. Empty if not found. */
export function listBookGenres(db: Database, libraryId: number, bookId: number): Genre[] {
  const rows = db
    .prepare(
      `SELECT g.id, g.library_id, g.name
       FROM book_genres bg
       JOIN books b ON b.id = bg.book_id AND b.library_id = ? AND ${notInBin('b')}
       JOIN genres g ON g.id = bg.genre_id AND g.library_id = ?
       WHERE bg.book_id = ?`,
    )
    .all(libraryId, libraryId, bookId) as GenreRow[];
  return rows
    .map(toGenre)
    .sort((a, b) => a.name.localeCompare(b.name, UKRAINIAN_LOCALE) || a.id - b.id);
}

/**
 * Replaces the genres of a book with `genreIds`, in one transaction. Returns false (changing
 * nothing) when the book is not in this library or is binned. Throws `GenreNotFoundError`
 * (and changes nothing) when any genre id is not a genre of this library.
 */
export function setBookGenres(
  db: Database,
  libraryId: number,
  bookId: number,
  genreIds: readonly number[],
): boolean {
  const replace = db.transaction((): boolean => {
    const book = db
      .prepare(
        `SELECT 1 AS present FROM books b WHERE b.id = ? AND b.library_id = ? AND ${notInBin('b')}`,
      )
      .get(bookId, libraryId);
    if (book === undefined) return false;

    const findGenre = db.prepare('SELECT 1 AS present FROM genres WHERE id = ? AND library_id = ?');
    const uniqueIds = [...new Set(genreIds)];
    for (const genreId of uniqueIds) {
      if (findGenre.get(genreId, libraryId) === undefined) {
        throw new GenreNotFoundError(libraryId, genreId);
      }
    }

    db.prepare('DELETE FROM book_genres WHERE book_id = ?').run(bookId);
    const link = db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)');
    for (const genreId of uniqueIds) link.run(bookId, genreId);
    return true;
  });
  return replace();
}
