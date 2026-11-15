import type { Database } from 'better-sqlite3';

import { nowIso } from '../time.js';
import { assertMember, notInBin } from './scope.js';

/**
 * Per-user read status. `book_reads` is keyed by (user_id, book_id): a row means «Прочитано»,
 * no row means «Не прочитано», and one member's row is never touched by another member.
 *
 * `libraryId` is required everywhere and is applied through `books` (a book of another library,
 * or in the Bin, is not found). Each method also calls `assertMember`, so a caller that forgot
 * the handler-level check still can't read or write marks in a library it doesn't belong to.
 */

/**
 * Marks the book as read by the user (keeping the original `read_at` if it already was).
 * Returns false when the book is not in this library or is in the Bin.
 */
export function markRead(db: Database, userId: number, libraryId: number, bookId: number): boolean {
  assertMember(db, userId, libraryId);
  // The no-op DO UPDATE makes an already-read book count as a change, so `changes` is 0 only
  // when the SELECT found no book.
  const result = db
    .prepare(
      `INSERT INTO book_reads (user_id, book_id, read_at)
       SELECT ?, b.id, ? FROM books b
       WHERE b.id = ? AND b.library_id = ? AND ${notInBin('b')}
       ON CONFLICT (user_id, book_id) DO UPDATE SET read_at = book_reads.read_at`,
    )
    .run(userId, nowIso(), bookId, libraryId);
  return result.changes > 0;
}

/**
 * Removes the user's read mark. Returns true if there was one to remove, false if the book was
 * not marked or is not in this library / is in the Bin.
 */
export function unmarkRead(
  db: Database,
  userId: number,
  libraryId: number,
  bookId: number,
): boolean {
  assertMember(db, userId, libraryId);
  const result = db
    .prepare(
      `DELETE FROM book_reads
       WHERE user_id = ?
         AND book_id IN (
           SELECT b.id FROM books b
           WHERE b.id = ? AND b.library_id = ? AND ${notInBin('b')}
         )`,
    )
    .run(userId, bookId, libraryId);
  return result.changes > 0;
}

/** Whether the user has read the book. False for a book outside this library or in the Bin. */
export function isRead(db: Database, userId: number, libraryId: number, bookId: number): boolean {
  assertMember(db, userId, libraryId);
  const row = db
    .prepare(
      `SELECT 1 AS present
       FROM book_reads r
       JOIN books b ON b.id = r.book_id
       WHERE r.user_id = ? AND b.id = ? AND b.library_id = ? AND ${notInBin('b')}`,
    )
    .get(userId, bookId, libraryId);
  return row !== undefined;
}

/**
 * The subset of `bookIds` the user has read, for rendering a page of books. Ids that are not
 * books of this library (or are binned) never appear in the result.
 */
export function getReadBookIds(
  db: Database,
  userId: number,
  libraryId: number,
  bookIds: readonly number[],
): Set<number> {
  assertMember(db, userId, libraryId);
  // The ids travel as one bound JSON array, so no placeholder list has to be built.
  const rows = db
    .prepare(
      `SELECT b.id AS book_id
       FROM book_reads r
       JOIN books b ON b.id = r.book_id
       WHERE r.user_id = ? AND b.library_id = ? AND ${notInBin('b')}
         AND b.id IN (SELECT value FROM json_each(?))`,
    )
    .all(userId, libraryId, JSON.stringify(bookIds)) as { book_id: number }[];
  return new Set(rows.map((row) => row.book_id));
}
