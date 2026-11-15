import type { Database } from 'better-sqlite3';

/**
 * Library scoping helpers shared by every repository.
 *
 * - The ONE definition of "in the Bin" / "not in the Bin" for books. Every query that reads
 *   books on behalf of a normal screen uses `notInBin`; only the Bin's own methods use `inBin`.
 *   Nothing else in src may spell out `deleted_at IS [NOT] NULL` (test/repositories.test.ts
 *   greps for it).
 * - `assertMember` / `isMember`: membership is always read from `library_members`.
 */

// Fragments are built from a fixed whitelist of table aliases, never from caller input.
const BOOK_ALIASES = ['b', 'books'] as const;
export type BookAlias = (typeof BOOK_ALIASES)[number];

function assertBookAlias(alias: string): void {
  if (!(BOOK_ALIASES as readonly string[]).includes(alias)) {
    throw new RangeError(`Unsupported books alias: ${alias}`);
  }
}

/** SQL condition that keeps only books that are NOT in the Bin. Constant fragment, no values. */
export function notInBin(alias: BookAlias): string {
  assertBookAlias(alias);
  return `${alias}.deleted_at IS NULL`;
}

/** SQL condition that keeps only books that ARE in the Bin. For the Bin's own methods only. */
export function inBin(alias: BookAlias): string {
  assertBookAlias(alias);
  return `${alias}.deleted_at IS NOT NULL`;
}

export class NotAMemberError extends Error {
  readonly userId: number;
  readonly libraryId: number;

  constructor(userId: number, libraryId: number) {
    super(`User ${String(userId)} is not a member of library ${String(libraryId)}`);
    this.name = 'NotAMemberError';
    this.userId = userId;
    this.libraryId = libraryId;
  }
}

/** Whether `userId` has a row in `library_members` for `libraryId`. Never throws for non-members. */
export function isMember(db: Database, userId: number, libraryId: number): boolean {
  const row = db
    .prepare('SELECT 1 AS present FROM library_members WHERE library_id = ? AND user_id = ?')
    .get(libraryId, userId);
  return row !== undefined;
}

/**
 * Throws `NotAMemberError` unless `userId` is a member of `libraryId`. Handlers call it with
 * `ctx.from.id` before acting on library data; ids from callback data are never trusted alone.
 */
export function assertMember(db: Database, userId: number, libraryId: number): void {
  if (!isMember(db, userId, libraryId)) {
    throw new NotAMemberError(userId, libraryId);
  }
}
