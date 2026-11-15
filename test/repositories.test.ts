import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IN_MEMORY_DB_PATH, openDatabase } from '../src/db/index.js';
import {
  countBinBooks,
  countBooks,
  getBook,
  insertBook,
  listBinBooks,
  listBooks,
  MAX_PAGE_SIZE,
  purgeBinBook,
  restoreBook,
  softDeleteBook,
  updateBook,
} from '../src/db/repositories/books.js';
import type { NewBook } from '../src/db/repositories/books.js';
import {
  createGenre,
  GenreNotFoundError,
  listBookGenres,
  listGenres,
  setBookGenres,
} from '../src/db/repositories/genres.js';
import { getCachedIsbn, putCachedIsbn } from '../src/db/repositories/isbnCache.js';
import { findPendingLinkInvite, hasPendingUsernameInvite } from '../src/db/repositories/invites.js';
import {
  createPersonalLibrary,
  getLibraryForMember,
  getPersonalLibrary,
  isMemberOfAnyLibrary,
  listUserLibraries,
} from '../src/db/repositories/libraries.js';
import { getReadBookIds, isRead, markRead, unmarkRead } from '../src/db/repositories/reads.js';
import {
  assertMember,
  inBin,
  isMember,
  NotAMemberError,
  notInBin,
} from '../src/db/repositories/scope.js';
import type { BookAlias } from '../src/db/repositories/scope.js';
import {
  getActiveLibraryId,
  getUser,
  setActiveLibrary,
  upsertUser,
} from '../src/db/repositories/users.js';
import { nowIso } from '../src/db/time.js';

const HOUR_MS = 60 * 60 * 1000;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIXED_NOW = '2026-11-15T09:30:00.000Z';
const FIRST_PAGE = { limit: 50, offset: 0 };

const ALICE = 1;
const BOB = 2;
const CAROL = 3;

let db: Database;

beforeEach(() => {
  db = openDatabase(IN_MEMORY_DB_PATH);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function freezeTime(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

function addUser(id: number, username: string | null = null): number {
  upsertUser(db, { id, username, firstName: `user${String(id)}` });
  return id;
}

function personalLibrary(userId: number): number {
  return createPersonalLibrary(db, userId, `Library of ${String(userId)}`).id;
}

/** Family libraries are created by a later phase; tests build them with plain SQL. */
function familyLibrary(ownerId: number, memberIds: number[] = []): number {
  const result = db
    .prepare("INSERT INTO libraries (kind, name, owner_user_id) VALUES ('family', 'Family', ?)")
    .run(ownerId);
  const libraryId = Number(result.lastInsertRowid);
  const addMember = db.prepare(
    'INSERT INTO library_members (library_id, user_id, role) VALUES (?, ?, ?)',
  );
  addMember.run(libraryId, ownerId, 'owner');
  for (const memberId of memberIds) addMember.run(libraryId, memberId, 'member');
  return libraryId;
}

function newBook(title: string, extra: Partial<NewBook> = {}): NewBook {
  return { title, source: 'manual', addedBy: null, ...extra };
}

function addBook(libraryId: number, title: string, extra: Partial<NewBook> = {}): number {
  return insertBook(db, libraryId, newBook(title, extra)).id;
}

function addBinnedBook(libraryId: number, title: string): number {
  const id = addBook(libraryId, title);
  expect(softDeleteBook(db, libraryId, id)).toBe(true);
  return id;
}

interface InviteSeed {
  readonly libraryId: number;
  readonly username?: string;
  readonly tokenHash?: string;
  readonly expiresAt?: string;
  readonly acceptedAt?: string | null;
  readonly revokedAt?: string | null;
}

function addInvite(seed: InviteSeed): void {
  const isUsername = seed.username !== undefined;
  db.prepare(
    `INSERT INTO invites (library_id, created_by, kind, token_hash, username, expires_at, accepted_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.libraryId,
    ALICE,
    isUsername ? 'username' : 'link',
    isUsername ? null : (seed.tokenHash ?? 'hash'),
    seed.username ?? null,
    seed.expiresAt ?? new Date(Date.now() + HOUR_MS).toISOString(),
    seed.acceptedAt ?? null,
    seed.revokedAt ?? null,
  );
}

function rawCount(table: string): number {
  // Table names are literals from this file.
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function snapshotLibraryData(): string {
  const tables = ['books', 'genres', 'book_genres', 'book_reads', 'library_members', 'users'];
  return JSON.stringify(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()));
}

function ftsRowids(match: string): number[] {
  const rows = db.prepare('SELECT rowid FROM books_fts WHERE books_fts MATCH ?').all(match) as {
    rowid: number;
  }[];
  return rows.map((row) => row.rowid);
}

describe('time helper', () => {
  it('nowIso returns the fixed-width ISO-8601 UTC format the schema requires', () => {
    expect(nowIso()).toMatch(ISO_PATTERN);
  });

  it('every repository timestamp comes from the same clock', () => {
    freezeTime(FIXED_NOW);
    addUser(ALICE);
    const library = personalLibrary(ALICE);
    const book = insertBook(db, library, newBook('Dune'));
    markRead(db, ALICE, library, book.id);
    putCachedIsbn(db, { isbn13: '9780140449136', payloadJson: '{}', provider: 'openlibrary' });

    expect(book.createdAt).toBe(FIXED_NOW);
    expect(book.updatedAt).toBe(FIXED_NOW);
    const stored = (table: string, column: string): unknown =>
      (db.prepare(`SELECT ${column} AS value FROM ${table}`).get() as { value: unknown }).value;
    expect(stored('users', 'created_at')).toBe(FIXED_NOW);
    expect(stored('users', 'updated_at')).toBe(FIXED_NOW);
    expect(stored('libraries', 'created_at')).toBe(FIXED_NOW);
    expect(stored('library_members', 'joined_at')).toBe(FIXED_NOW);
    expect(stored('books', 'created_at')).toBe(FIXED_NOW);
    expect(stored('book_reads', 'read_at')).toBe(FIXED_NOW);
    expect(stored('isbn_cache', 'fetched_at')).toBe(FIXED_NOW);
  });
});

describe('scope helpers', () => {
  it('builds the Bin conditions for the whitelisted aliases', () => {
    expect(notInBin('b')).toBe('b.deleted_at IS NULL');
    expect(inBin('b')).toBe('b.deleted_at IS NOT NULL');
    expect(notInBin('books')).toBe('books.deleted_at IS NULL');
    expect(inBin('books')).toBe('books.deleted_at IS NOT NULL');
  });

  it('refuses an alias that is not on the whitelist', () => {
    expect(() => notInBin('b; DROP TABLE books' as BookAlias)).toThrow(RangeError);
    expect(() => inBin('x' as BookAlias)).toThrow(RangeError);
  });

  it('only scope.ts spells out the Bin condition in src', () => {
    const srcDir = join(import.meta.dirname, '..', 'src');
    const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter((file) =>
      file.endsWith('.ts'),
    );
    // Covers `IS NULL`, `IS NOT NULL`, `ISNULL`, `NOTNULL` and a quoted column name.
    const binCondition = /deleted_at["`\]]?\s*(IS|ISNULL|NOTNULL)\b/i;

    const offenders = files.filter((file) =>
      binCondition.test(readFileSync(join(srcDir, file), 'utf8')),
    );

    // Guards against the scan silently matching nothing: scope.ts must be the one hit.
    expect(offenders.map((file) => file.replaceAll('\\', '/'))).toEqual([
      'db/repositories/scope.ts',
    ]);
  });

  it('never uses INSERT OR REPLACE on books in the repositories', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'db', 'repositories');
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/INSERT\s+OR\s+REPLACE/i);
    }
  });
});

describe('membership', () => {
  it('assertMember passes for a member and isMember is true', () => {
    addUser(ALICE);
    const library = personalLibrary(ALICE);

    expect(() => {
      assertMember(db, ALICE, library);
    }).not.toThrow();
    expect(isMember(db, ALICE, library)).toBe(true);
  });

  it('assertMember throws NotAMemberError for a user who is not a member', () => {
    addUser(ALICE);
    addUser(BOB);
    const library = personalLibrary(ALICE);

    expect(() => {
      assertMember(db, BOB, library);
    }).toThrow(NotAMemberError);
    expect(isMember(db, BOB, library)).toBe(false);
  });

  it('carries the user and library ids on the error', () => {
    addUser(ALICE);
    const library = personalLibrary(ALICE);

    try {
      assertMember(db, CAROL, library);
      expect.unreachable('assertMember should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NotAMemberError);
      expect(error).toMatchObject({ userId: CAROL, libraryId: library });
    }
  });

  it('membership is per library: being in one library says nothing about another', () => {
    addUser(ALICE);
    addUser(BOB);
    const aliceLibrary = personalLibrary(ALICE);
    const bobLibrary = personalLibrary(BOB);

    expect(isMember(db, ALICE, bobLibrary)).toBe(false);
    expect(isMember(db, BOB, aliceLibrary)).toBe(false);
  });

  it('a library that does not exist has no members', () => {
    addUser(ALICE);

    expect(isMember(db, ALICE, 999)).toBe(false);
    expect(() => {
      assertMember(db, ALICE, 999);
    }).toThrow(NotAMemberError);
  });

  it('a member of a family library is a member (not only the owner)', () => {
    addUser(ALICE);
    addUser(BOB);
    const family = familyLibrary(ALICE, [BOB]);

    expect(isMember(db, BOB, family)).toBe(true);
  });
});

describe('users', () => {
  it('creates a user from Telegram data', () => {
    const user = upsertUser(db, { id: ALICE, username: 'alice', firstName: 'Аліса' });

    expect(user).toEqual({
      id: ALICE,
      username: 'alice',
      firstName: 'Аліса',
      activeLibraryId: null,
    });
    expect(getUser(db, ALICE)).toEqual(user);
  });

  it('refreshes username and first name on a later upsert and keeps one row', () => {
    upsertUser(db, { id: ALICE, username: 'alice', firstName: 'Аліса' });

    const updated = upsertUser(db, { id: ALICE, username: 'alice_new', firstName: 'Alice' });

    expect(updated).toMatchObject({ username: 'alice_new', firstName: 'Alice' });
    expect(rawCount('users')).toBe(1);
  });

  it('allows a user without a username and clears a removed one', () => {
    upsertUser(db, { id: ALICE, username: 'alice', firstName: null });

    const updated = upsertUser(db, { id: ALICE, username: null, firstName: null });

    expect(updated).toMatchObject({ username: null, firstName: null });
  });

  it('keeps the active library when the user is upserted again', () => {
    addUser(ALICE);
    const library = personalLibrary(ALICE);
    setActiveLibrary(db, ALICE, library);

    const again = upsertUser(db, { id: ALICE, username: 'alice', firstName: 'A' });

    expect(again.activeLibraryId).toBe(library);
  });

  it('bumps updated_at on upsert but keeps created_at', () => {
    freezeTime('2026-11-15T09:00:00.000Z');
    addUser(ALICE);
    freezeTime('2026-11-15T10:00:00.000Z');

    upsertUser(db, { id: ALICE, username: 'alice', firstName: 'A' });

    const row = db.prepare('SELECT created_at, updated_at FROM users WHERE id = ?').get(ALICE);
    expect(row).toEqual({
      created_at: '2026-11-15T09:00:00.000Z',
      updated_at: '2026-11-15T10:00:00.000Z',
    });
  });

  it('getUser returns null for an unknown user', () => {
    expect(getUser(db, 404)).toBeNull();
  });

  it('stores and returns the active library of a member', () => {
    addUser(ALICE);
    const library = personalLibrary(ALICE);

    expect(getActiveLibraryId(db, ALICE)).toBeNull();
    setActiveLibrary(db, ALICE, library);

    expect(getActiveLibraryId(db, ALICE)).toBe(library);
    expect(getUser(db, ALICE)?.activeLibraryId).toBe(library);
  });

  it('refuses to set an active library the user is not a member of', () => {
    addUser(ALICE);
    addUser(BOB);
    const aliceLibrary = personalLibrary(ALICE);
    const bobLibrary = personalLibrary(BOB);
    setActiveLibrary(db, BOB, bobLibrary);

    expect(() => {
      setActiveLibrary(db, BOB, aliceLibrary);
    }).toThrow(NotAMemberError);
    expect(getActiveLibraryId(db, BOB)).toBe(bobLibrary);
  });

  it('reports no active library once the user has left it (stale value)', () => {
    addUser(ALICE);
    addUser(BOB);
    const family = familyLibrary(ALICE, [BOB]);
    setActiveLibrary(db, BOB, family);

    db.prepare('DELETE FROM library_members WHERE library_id = ? AND user_id = ?').run(family, BOB);

    expect(getActiveLibraryId(db, BOB)).toBeNull();
  });

  it('reports no active library once the membership is gone, even if the user is in other libraries', () => {
    addUser(ALICE);
    addUser(BOB);
    personalLibrary(BOB);
    const family = familyLibrary(ALICE, [BOB]);
    setActiveLibrary(db, BOB, family);
    expect(getActiveLibraryId(db, BOB)).toBe(family);

    db.prepare('DELETE FROM library_members WHERE library_id = ? AND user_id = ?').run(family, BOB);

    expect(getActiveLibraryId(db, BOB)).toBeNull();
  });

  it('active library is per user', () => {
    addUser(ALICE);
    addUser(BOB);
    const family = familyLibrary(ALICE, [BOB]);
    const aliceLibrary = personalLibrary(ALICE);
    setActiveLibrary(db, ALICE, aliceLibrary);
    setActiveLibrary(db, BOB, family);

    expect(getActiveLibraryId(db, ALICE)).toBe(aliceLibrary);
    expect(getActiveLibraryId(db, BOB)).toBe(family);
  });

  it('getActiveLibraryId is null for an unknown user', () => {
    expect(getActiveLibraryId(db, 404)).toBeNull();
  });
});

describe('libraries', () => {
  it('creates a personal library and its owner membership', () => {
    addUser(ALICE);

    const library = createPersonalLibrary(db, ALICE, 'Моя бібліотека');

    expect(library).toEqual({
      id: expect.any(Number) as number,
      kind: 'personal',
      name: 'Моя бібліотека',
      ownerUserId: ALICE,
    });
    expect(
      db.prepare('SELECT user_id, role FROM library_members WHERE library_id = ?').all(library.id),
    ).toEqual([{ user_id: ALICE, role: 'owner' }]);
  });

  it('creates the library and the membership in one transaction (a failing membership rolls back the library)', () => {
    addUser(ALICE);
    db.exec(
      `CREATE TRIGGER fail_membership BEFORE INSERT ON library_members
       BEGIN SELECT RAISE(ABORT, 'membership failed'); END`,
    );

    expect(() => createPersonalLibrary(db, ALICE, 'Моя бібліотека')).toThrow(/membership failed/);

    expect(rawCount('libraries')).toBe(0);
    expect(rawCount('library_members')).toBe(0);
  });

  it('rejects a second personal library for the same user and leaves the first intact', () => {
    addUser(ALICE);
    const first = createPersonalLibrary(db, ALICE, 'First');

    expect(() => createPersonalLibrary(db, ALICE, 'Second')).toThrow(/UNIQUE/);

    expect(rawCount('libraries')).toBe(1);
    expect(getPersonalLibrary(db, ALICE)?.id).toBe(first.id);
  });

  it('rejects a personal library for a user that does not exist and leaves nothing behind', () => {
    expect(() => createPersonalLibrary(db, 404, 'Ghost')).toThrow(/FOREIGN KEY/);

    expect(rawCount('libraries')).toBe(0);
    expect(rawCount('library_members')).toBe(0);
  });

  it('getPersonalLibrary returns the personal library with the owner role, or null before /start', () => {
    addUser(ALICE);
    addUser(BOB);
    const library = createPersonalLibrary(db, ALICE, 'Mine');

    expect(getPersonalLibrary(db, ALICE)).toEqual({ ...library, role: 'owner' });
    expect(getPersonalLibrary(db, BOB)).toBeNull();
  });

  it("getPersonalLibrary never returns someone else's personal library, even to a member of it", () => {
    addUser(ALICE);
    addUser(BOB);
    personalLibrary(ALICE);
    const bobPersonal = personalLibrary(BOB);
    // A (hypothetical) membership in Alice's personal library must not make it Bob's own.
    db.prepare('INSERT INTO library_members (library_id, user_id, role) VALUES (?, ?, ?)').run(
      getPersonalLibrary(db, ALICE)?.id,
      BOB,
      'member',
    );

    expect(getPersonalLibrary(db, BOB)?.id).toBe(bobPersonal);
  });

  it('getPersonalLibrary skips family libraries the user owns', () => {
    addUser(ALICE);
    familyLibrary(ALICE);
    const personal = personalLibrary(ALICE);

    expect(getPersonalLibrary(db, ALICE)).toMatchObject({ id: personal, kind: 'personal' });
  });

  it('getPersonalLibrary reports the role of the asking user, not of another member', () => {
    addUser(20);
    addUser(10);
    const library = personalLibrary(20);
    db.prepare('INSERT INTO library_members (library_id, user_id, role) VALUES (?, 10, ?)').run(
      library,
      'member',
    );

    expect(getPersonalLibrary(db, 20)).toMatchObject({ id: library, role: 'owner' });
  });

  it('getPersonalLibrary needs the owner to still be a member', () => {
    addUser(ALICE);
    addUser(BOB);
    const library = personalLibrary(ALICE);
    db.prepare('INSERT INTO library_members (library_id, user_id, role) VALUES (?, ?, ?)').run(
      library,
      BOB,
      'member',
    );
    db.prepare('DELETE FROM library_members WHERE library_id = ? AND user_id = ?').run(
      library,
      ALICE,
    );

    expect(getPersonalLibrary(db, ALICE)).toBeNull();
  });

  it('lists only the libraries the user belongs to, personal first, with their roles', () => {
    addUser(ALICE);
    addUser(BOB);
    addUser(CAROL);
    const family = familyLibrary(BOB, [ALICE]);
    const personal = personalLibrary(ALICE);
    const otherFamily = familyLibrary(ALICE);
    personalLibrary(BOB);
    familyLibrary(CAROL);

    const libraries = listUserLibraries(db, ALICE);

    expect(libraries.map((library) => [library.id, library.kind, library.role])).toEqual([
      [personal, 'personal', 'owner'],
      [family, 'family', 'member'],
      [otherFamily, 'family', 'owner'],
    ]);
    expect(listUserLibraries(db, 404)).toEqual([]);
  });

  it('getLibraryForMember returns the library to a member and null to anyone else', () => {
    addUser(ALICE);
    addUser(BOB);
    const family = familyLibrary(ALICE, [BOB]);
    const alicePersonal = personalLibrary(ALICE);

    expect(getLibraryForMember(db, BOB, family)).toMatchObject({
      id: family,
      kind: 'family',
      role: 'member',
    });
    expect(getLibraryForMember(db, ALICE, family)).toMatchObject({ id: family, role: 'owner' });
    expect(getLibraryForMember(db, BOB, alicePersonal)).toBeNull();
    expect(getLibraryForMember(db, CAROL, family)).toBeNull();
    expect(getLibraryForMember(db, ALICE, 999)).toBeNull();
  });

  it('isMemberOfAnyLibrary is true only for users with a membership', () => {
    addUser(ALICE);
    addUser(BOB);
    personalLibrary(ALICE);

    expect(isMemberOfAnyLibrary(db, ALICE)).toBe(true);
    expect(isMemberOfAnyLibrary(db, BOB)).toBe(false);
    expect(isMemberOfAnyLibrary(db, 404)).toBe(false);
  });
});

describe('invites (read side)', () => {
  let library: number;

  beforeEach(() => {
    addUser(ALICE);
    library = familyLibrary(ALICE);
  });

  describe('hasPendingUsernameInvite', () => {
    it('finds a pending invite for the username', () => {
      addInvite({ libraryId: library, username: 'bob_reader' });

      expect(hasPendingUsernameInvite(db, 'bob_reader')).toBe(true);
    });

    it('matches case-insensitively against the lowercased stored username', () => {
      addInvite({ libraryId: library, username: 'bob_reader' });

      expect(hasPendingUsernameInvite(db, 'Bob_Reader')).toBe(true);
    });

    it('does not match another username', () => {
      addInvite({ libraryId: library, username: 'bob_reader' });

      expect(hasPendingUsernameInvite(db, 'carol_reader')).toBe(false);
      expect(hasPendingUsernameInvite(db, 'bob')).toBe(false);
    });

    it('never matches a user without a username', () => {
      addInvite({ libraryId: library, username: 'bob_reader' });

      expect(hasPendingUsernameInvite(db, null)).toBe(false);
      expect(hasPendingUsernameInvite(db, '')).toBe(false);
    });

    it('ignores an accepted invite', () => {
      addInvite({ libraryId: library, username: 'bob_reader', acceptedAt: nowIso() });

      expect(hasPendingUsernameInvite(db, 'bob_reader')).toBe(false);
    });

    it('ignores a revoked invite', () => {
      addInvite({ libraryId: library, username: 'bob_reader', revokedAt: nowIso() });

      expect(hasPendingUsernameInvite(db, 'bob_reader')).toBe(false);
    });

    it('ignores an expired invite', () => {
      addInvite({
        libraryId: library,
        username: 'bob_reader',
        expiresAt: new Date(Date.now() - HOUR_MS).toISOString(),
      });

      expect(hasPendingUsernameInvite(db, 'bob_reader')).toBe(false);
    });

    it('treats an invite as expired at the exact expiry instant, like the DB triggers', () => {
      addInvite({ libraryId: library, username: 'bob_reader', expiresAt: FIXED_NOW });

      freezeTime('2026-11-15T09:29:59.999Z');
      expect(hasPendingUsernameInvite(db, 'bob_reader')).toBe(true);
      freezeTime(FIXED_NOW);
      expect(hasPendingUsernameInvite(db, 'bob_reader')).toBe(false);
    });

    it('finds the pending invite even when older ones for the same username are used up', () => {
      addInvite({ libraryId: library, username: 'bob_reader', acceptedAt: nowIso() });
      addInvite({ libraryId: library, username: 'bob_reader', revokedAt: nowIso() });
      addInvite({ libraryId: library, username: 'bob_reader' });

      expect(hasPendingUsernameInvite(db, 'bob_reader')).toBe(true);
    });
  });

  describe('findPendingLinkInvite', () => {
    it('returns the pending invite for a token hash', () => {
      const expiresAt = new Date(Date.now() + HOUR_MS).toISOString();
      addInvite({ libraryId: library, tokenHash: 'abc123', expiresAt });

      expect(findPendingLinkInvite(db, 'abc123')).toEqual({
        id: expect.any(Number) as number,
        libraryId: library,
        createdBy: ALICE,
        expiresAt,
      });
    });

    it('returns null for an unknown hash', () => {
      addInvite({ libraryId: library, tokenHash: 'abc123' });

      expect(findPendingLinkInvite(db, 'nope')).toBeNull();
    });

    it('returns null for an accepted invite', () => {
      addInvite({ libraryId: library, tokenHash: 'abc123', acceptedAt: nowIso() });

      expect(findPendingLinkInvite(db, 'abc123')).toBeNull();
    });

    it('returns null for a revoked invite', () => {
      addInvite({ libraryId: library, tokenHash: 'abc123', revokedAt: nowIso() });

      expect(findPendingLinkInvite(db, 'abc123')).toBeNull();
    });

    it('returns null for an expired invite and at the exact expiry instant', () => {
      addInvite({ libraryId: library, tokenHash: 'abc123', expiresAt: FIXED_NOW });

      freezeTime('2026-11-15T09:29:59.999Z');
      expect(findPendingLinkInvite(db, 'abc123')).not.toBeNull();
      freezeTime(FIXED_NOW);
      expect(findPendingLinkInvite(db, 'abc123')).toBeNull();
    });
  });
});

describe('isbn cache', () => {
  const isbn13 = '9780140449136';

  it('returns null for an ISBN that is not cached', () => {
    expect(getCachedIsbn(db, isbn13)).toBeNull();
  });

  it('stores a payload and reads it back', () => {
    freezeTime(FIXED_NOW);

    putCachedIsbn(db, { isbn13, payloadJson: '{"title":"Одіссея"}', provider: 'openlibrary' });

    expect(getCachedIsbn(db, isbn13)).toEqual({
      isbn13,
      payloadJson: '{"title":"Одіссея"}',
      provider: 'openlibrary',
      fetchedAt: FIXED_NOW,
    });
  });

  it('replaces an earlier entry and refreshes its timestamp', () => {
    freezeTime(FIXED_NOW);
    putCachedIsbn(db, { isbn13, payloadJson: '{"v":1}', provider: 'openlibrary' });
    freezeTime('2026-11-16T09:30:00.000Z');

    putCachedIsbn(db, { isbn13, payloadJson: '{"v":2}', provider: 'googlebooks' });

    expect(getCachedIsbn(db, isbn13)).toEqual({
      isbn13,
      payloadJson: '{"v":2}',
      provider: 'googlebooks',
      fetchedAt: '2026-11-16T09:30:00.000Z',
    });
    expect(rawCount('isbn_cache')).toBe(1);
  });

  it('is global: the same entry is visible no matter which library asks', () => {
    putCachedIsbn(db, { isbn13, payloadJson: '{}', provider: 'openlibrary' });

    expect(getCachedIsbn(db, isbn13)?.isbn13).toBe(isbn13);
    expect(getCachedIsbn(db, '9780000000002')).toBeNull();
  });
});

describe('books', () => {
  let library: number;

  beforeEach(() => {
    addUser(ALICE);
    library = personalLibrary(ALICE);
  });

  describe('insertBook and getBook', () => {
    it('stores a book with defaults for the optional fields', () => {
      const book = insertBook(db, library, newBook('Дюна'));

      expect(book).toMatchObject({
        libraryId: library,
        isbn13: null,
        title: 'Дюна',
        authors: '',
        publishedYear: null,
        publisher: null,
        coverPath: null,
        source: 'manual',
        addedBy: null,
        deletedAt: null,
      });
      expect(book.createdAt).toMatch(ISO_PATTERN);
      expect(getBook(db, library, book.id)).toEqual(book);
    });

    it('stores every given field', () => {
      const book = insertBook(db, library, {
        isbn13: '9780140449136',
        title: 'The Odyssey',
        authors: 'Homer',
        publishedYear: 1999,
        publisher: 'Penguin',
        coverPath: 'covers/odyssey.jpg',
        source: 'isbn',
        addedBy: ALICE,
      });

      expect(getBook(db, library, book.id)).toMatchObject({
        isbn13: '9780140449136',
        authors: 'Homer',
        publishedYear: 1999,
        publisher: 'Penguin',
        coverPath: 'covers/odyssey.jpg',
        source: 'isbn',
        addedBy: ALICE,
      });
    });

    it('keeps the full-text index in sync on insert', () => {
      const id = addBook(library, 'Гаррі Поттер', { authors: 'Роулінг' });

      expect(ftsRowids('"гарр"*')).toEqual([id]);
      expect(ftsRowids('роулінг')).toEqual([id]);
    });

    it('rejects the same ISBN twice in one library but allows it in another', () => {
      addUser(BOB);
      const other = personalLibrary(BOB);
      addBook(library, 'Odyssey', { isbn13: '9780140449136' });

      expect(() => addBook(library, 'Odyssey again', { isbn13: '9780140449136' })).toThrow(
        /UNIQUE/,
      );
      expect(() => addBook(other, 'Odyssey', { isbn13: '9780140449136' })).not.toThrow();
    });

    it('allows several books without an ISBN', () => {
      addBook(library, 'One');
      addBook(library, 'Two');

      expect(countBooks(db, library)).toBe(2);
    });

    it('does not find a book that does not exist', () => {
      expect(getBook(db, library, 999)).toBeNull();
    });
  });

  describe('listBooks and countBooks', () => {
    it('lists books in the order they were added, page by page', () => {
      const ids = ['A', 'B', 'C', 'D', 'E'].map((title) => addBook(library, title));

      const firstPage = listBooks(db, library, { limit: 2, offset: 0 });
      const secondPage = listBooks(db, library, { limit: 2, offset: 2 });
      const lastPage = listBooks(db, library, { limit: 2, offset: 4 });

      expect(firstPage.map((book) => book.id)).toEqual([ids[0], ids[1]]);
      expect(secondPage.map((book) => book.id)).toEqual([ids[2], ids[3]]);
      expect(lastPage.map((book) => book.id)).toEqual([ids[4]]);
      expect(countBooks(db, library)).toBe(5);
    });

    it('returns an empty page and a zero count for an empty library', () => {
      expect(listBooks(db, library, FIRST_PAGE)).toEqual([]);
      expect(countBooks(db, library)).toBe(0);
    });

    it.each([
      ['limit 0', { limit: 0, offset: 0 }],
      ['negative limit (SQLite would treat it as unlimited)', { limit: -1, offset: 0 }],
      ['limit above the maximum', { limit: MAX_PAGE_SIZE + 1, offset: 0 }],
      ['fractional limit', { limit: 1.5, offset: 0 }],
      ['NaN limit', { limit: Number.NaN, offset: 0 }],
      ['negative offset', { limit: 10, offset: -1 }],
      ['fractional offset', { limit: 10, offset: 0.5 }],
    ])('rejects an invalid page: %s', (_label, page) => {
      addBook(library, 'A');

      expect(() => listBooks(db, library, page)).toThrow(RangeError);
      expect(() => listBinBooks(db, library, page)).toThrow(RangeError);
    });

    it('accepts the largest allowed page', () => {
      addBook(library, 'A');

      expect(listBooks(db, library, { limit: MAX_PAGE_SIZE, offset: 0 })).toHaveLength(1);
    });
  });

  describe('updateBook', () => {
    it('changes only the given fields and returns true', () => {
      const id = addBook(library, 'Old title', {
        authors: 'Author',
        publisher: 'Pub',
        publishedYear: 2000,
        coverPath: 'covers/old.jpg',
      });

      const changed = updateBook(db, library, id, { title: 'New title' });

      expect(changed).toBe(true);
      expect(getBook(db, library, id)).toMatchObject({
        title: 'New title',
        authors: 'Author',
        publisher: 'Pub',
        publishedYear: 2000,
        coverPath: 'covers/old.jpg',
      });
    });

    it('can change every updatable field at once', () => {
      const id = addBook(library, 'T');

      updateBook(db, library, id, {
        title: 'Нова назва',
        authors: 'Автор',
        publishedYear: 2010,
        publisher: 'Видавець',
        coverPath: 'c.jpg',
      });

      expect(getBook(db, library, id)).toMatchObject({
        title: 'Нова назва',
        authors: 'Автор',
        publishedYear: 2010,
        publisher: 'Видавець',
        coverPath: 'c.jpg',
      });
    });

    it('can clear a nullable field on purpose', () => {
      const id = addBook(library, 'T', {
        publisher: 'Pub',
        publishedYear: 2000,
        coverPath: 'c.jpg',
      });

      updateBook(db, library, id, { publisher: null, publishedYear: null, coverPath: null });

      expect(getBook(db, library, id)).toMatchObject({
        publisher: null,
        publishedYear: null,
        coverPath: null,
      });
    });

    it('bumps updated_at and leaves created_at', () => {
      freezeTime('2026-11-15T09:00:00.000Z');
      const id = addBook(library, 'T');
      freezeTime('2026-11-15T11:00:00.000Z');

      updateBook(db, library, id, { authors: 'A' });

      expect(getBook(db, library, id)).toMatchObject({
        createdAt: '2026-11-15T09:00:00.000Z',
        updatedAt: '2026-11-15T11:00:00.000Z',
      });
    });

    it('keeps the full-text index in sync when title or authors change', () => {
      const id = addBook(library, 'Гаррі Поттер', { authors: 'Роулінг' });

      updateBook(db, library, id, { title: 'Дюна', authors: 'Герберт' });

      expect(ftsRowids('"гарр"*')).toEqual([]);
      expect(ftsRowids('"роулінг"')).toEqual([]);
      expect(ftsRowids('"дюн"*')).toEqual([id]);
      expect(ftsRowids('"герберт"')).toEqual([id]);
    });

    it('returns false for a book that does not exist', () => {
      expect(updateBook(db, library, 999, { title: 'X' })).toBe(false);
    });
  });

  describe('Bin', () => {
    it('softDeleteBook moves the book out of every normal read and into the Bin', () => {
      const keep = addBook(library, 'Keep');
      const doomed = addBook(library, 'Doomed');

      expect(softDeleteBook(db, library, doomed)).toBe(true);

      expect(getBook(db, library, doomed)).toBeNull();
      expect(listBooks(db, library, FIRST_PAGE).map((book) => book.id)).toEqual([keep]);
      expect(countBooks(db, library)).toBe(1);
      expect(listBinBooks(db, library, FIRST_PAGE).map((book) => book.id)).toEqual([doomed]);
      expect(countBinBooks(db, library)).toBe(1);
    });

    it('stamps the binned book with deleted_at', () => {
      freezeTime(FIXED_NOW);
      const id = addBinnedBook(library, 'Doomed');

      expect(listBinBooks(db, library, FIRST_PAGE)[0]).toMatchObject({ id, deletedAt: FIXED_NOW });
    });

    it('softDeleteBook returns false for a book that is already binned or does not exist', () => {
      const id = addBinnedBook(library, 'Doomed');

      expect(softDeleteBook(db, library, id)).toBe(false);
      expect(softDeleteBook(db, library, 999)).toBe(false);
    });

    it('does not let updateBook touch a binned book', () => {
      const id = addBinnedBook(library, 'Doomed');

      expect(updateBook(db, library, id, { title: 'Changed' })).toBe(false);

      expect(listBinBooks(db, library, FIRST_PAGE)[0]?.title).toBe('Doomed');
    });

    it('the Bin lists only binned books, most recently deleted first, in pages', () => {
      addBook(library, 'Active');
      freezeTime('2026-11-15T09:00:00.000Z');
      const first = addBinnedBook(library, 'First');
      freezeTime('2026-11-15T10:00:00.000Z');
      const second = addBinnedBook(library, 'Second');
      freezeTime('2026-11-15T11:00:00.000Z');
      const third = addBinnedBook(library, 'Third');

      expect(listBinBooks(db, library, FIRST_PAGE).map((book) => book.id)).toEqual([
        third,
        second,
        first,
      ]);
      expect(listBinBooks(db, library, { limit: 2, offset: 2 }).map((book) => book.id)).toEqual([
        first,
      ]);
      expect(countBinBooks(db, library)).toBe(3);
    });

    it('restoreBook brings a binned book back into normal reads', () => {
      const id = addBinnedBook(library, 'Doomed');

      expect(restoreBook(db, library, id)).toBe(true);

      expect(getBook(db, library, id)).toMatchObject({ id, deletedAt: null });
      expect(countBooks(db, library)).toBe(1);
      expect(countBinBooks(db, library)).toBe(0);
    });

    it('restoreBook returns false for an active or unknown book', () => {
      const id = addBook(library, 'Active');

      expect(restoreBook(db, library, id)).toBe(false);
      expect(restoreBook(db, library, 999)).toBe(false);
      expect(getBook(db, library, id)).not.toBeNull();
    });

    it('purgeBinBook permanently deletes a binned book, its links and its read marks', () => {
      const id = addBook(library, 'Doomed');
      const genre = createGenre(db, library, 'Фентезі');
      setBookGenres(db, library, id, [genre.id]);
      markRead(db, ALICE, library, id);
      softDeleteBook(db, library, id);

      expect(purgeBinBook(db, library, id)).toBe(true);

      expect(countBinBooks(db, library)).toBe(0);
      expect(rawCount('books')).toBe(0);
      expect(rawCount('book_genres')).toBe(0);
      expect(rawCount('book_reads')).toBe(0);
      expect(ftsRowids('"doomed"')).toEqual([]);
      db.exec("INSERT INTO books_fts (books_fts, rank) VALUES ('integrity-check', 1)");
    });

    it('purgeBinBook refuses an active book: it must be binned first', () => {
      const id = addBook(library, 'Active');

      expect(purgeBinBook(db, library, id)).toBe(false);

      expect(getBook(db, library, id)).not.toBeNull();
    });

    it('purgeBinBook returns false for an unknown book', () => {
      expect(purgeBinBook(db, library, 999)).toBe(false);
    });

    it('a binned book keeps its ISBN, so the same ISBN cannot be added again', () => {
      const id = addBook(library, 'Odyssey', { isbn13: '9780140449136' });
      softDeleteBook(db, library, id);

      expect(() => addBook(library, 'Odyssey', { isbn13: '9780140449136' })).toThrow(/UNIQUE/);
    });
  });
});

describe('genres', () => {
  let library: number;

  beforeEach(() => {
    addUser(ALICE);
    library = personalLibrary(ALICE);
  });

  describe('createGenre', () => {
    it('creates a genre in the library', () => {
      const genre = createGenre(db, library, 'Фентезі');

      expect(genre).toEqual({
        id: expect.any(Number) as number,
        libraryId: library,
        name: 'Фентезі',
      });
      expect(listGenres(db, library)).toEqual([genre]);
    });

    it('trims the name', () => {
      expect(createGenre(db, library, '  Фентезі  ').name).toBe('Фентезі');
    });

    it('returns the existing genre for the same name in a different Cyrillic case', () => {
      const first = createGenre(db, library, 'Фентезі');

      const again = createGenre(db, library, 'фентезі');
      const shouting = createGenre(db, library, 'ФЕНТЕЗІ');

      expect(again).toEqual(first);
      expect(shouting).toEqual(first);
      expect(listGenres(db, library)).toHaveLength(1);
    });

    it('returns the existing genre for the same Latin name in a different case', () => {
      const first = createGenre(db, library, 'Fantasy');

      expect(createGenre(db, library, 'fANTASY')).toEqual(first);
      expect(listGenres(db, library)).toHaveLength(1);
    });

    it('treats different names as different genres', () => {
      createGenre(db, library, 'Фентезі');
      createGenre(db, library, 'Фантастика');

      expect(listGenres(db, library)).toHaveLength(2);
    });

    it('the same name in another library is a separate genre', () => {
      addUser(BOB);
      const other = personalLibrary(BOB);

      const mine = createGenre(db, library, 'Фентезі');
      const theirs = createGenre(db, other, 'фентезі');

      expect(theirs.id).not.toBe(mine.id);
      expect(theirs).toMatchObject({ libraryId: other, name: 'фентезі' });
    });
  });

  describe('listGenres', () => {
    it('sorts with Ukrainian collation, not by code point', () => {
      createGenre(db, library, 'Фентезі');
      createGenre(db, library, 'Історія');
      createGenre(db, library, 'Детектив');

      expect(listGenres(db, library).map((genre) => genre.name)).toEqual([
        'Детектив',
        'Історія',
        'Фентезі',
      ]);
    });

    it('lists only the genres of the given library', () => {
      addUser(BOB);
      const other = personalLibrary(BOB);
      createGenre(db, library, 'Mine');
      createGenre(db, other, 'Theirs');

      expect(listGenres(db, library).map((genre) => genre.name)).toEqual(['Mine']);
      expect(listGenres(db, other).map((genre) => genre.name)).toEqual(['Theirs']);
      expect(listGenres(db, 999)).toEqual([]);
    });
  });

  describe('setBookGenres and listBookGenres', () => {
    it('tags a book with several genres', () => {
      const book = addBook(library, 'Book');
      const fantasy = createGenre(db, library, 'Фентезі');
      const history = createGenre(db, library, 'Історія');

      expect(setBookGenres(db, library, book, [fantasy.id, history.id])).toBe(true);

      expect(listBookGenres(db, library, book).map((genre) => genre.name)).toEqual([
        'Історія',
        'Фентезі',
      ]);
    });

    it('replaces the previous genres and can clear them', () => {
      const book = addBook(library, 'Book');
      const fantasy = createGenre(db, library, 'Фентезі');
      const history = createGenre(db, library, 'Історія');
      setBookGenres(db, library, book, [fantasy.id]);

      setBookGenres(db, library, book, [history.id]);
      expect(listBookGenres(db, library, book).map((genre) => genre.id)).toEqual([history.id]);

      setBookGenres(db, library, book, []);
      expect(listBookGenres(db, library, book)).toEqual([]);
    });

    it('tolerates the same genre id twice', () => {
      const book = addBook(library, 'Book');
      const fantasy = createGenre(db, library, 'Фентезі');

      expect(setBookGenres(db, library, book, [fantasy.id, fantasy.id])).toBe(true);

      expect(listBookGenres(db, library, book)).toHaveLength(1);
    });

    it('does not touch other books', () => {
      const book = addBook(library, 'Book');
      const other = addBook(library, 'Other');
      const fantasy = createGenre(db, library, 'Фентезі');
      setBookGenres(db, library, other, [fantasy.id]);

      setBookGenres(db, library, book, []);

      expect(listBookGenres(db, library, other)).toHaveLength(1);
    });

    it('throws GenreNotFoundError for a genre of another library and changes nothing', () => {
      addUser(BOB);
      const otherLibrary = personalLibrary(BOB);
      const foreignGenre = createGenre(db, otherLibrary, 'Foreign');
      const book = addBook(library, 'Book');
      const fantasy = createGenre(db, library, 'Фентезі');
      setBookGenres(db, library, book, [fantasy.id]);

      expect(() => setBookGenres(db, library, book, [fantasy.id, foreignGenre.id])).toThrow(
        GenreNotFoundError,
      );

      expect(listBookGenres(db, library, book).map((genre) => genre.id)).toEqual([fantasy.id]);
      expect(rawCount('book_genres')).toBe(1);
    });

    it('throws GenreNotFoundError for a genre id that does not exist', () => {
      const book = addBook(library, 'Book');

      expect(() => setBookGenres(db, library, book, [999])).toThrow(GenreNotFoundError);
    });

    it('listBookGenres also filters on the library when the same-library trigger is bypassed', () => {
      addUser(BOB);
      const otherLibrary = personalLibrary(BOB);
      const book = addBook(library, 'Book');
      const ownGenre = createGenre(db, library, 'Own');
      const foreignGenre = createGenre(db, otherLibrary, 'Foreign');
      db.exec('DROP TRIGGER book_genres_same_library_insert');
      const link = db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)');
      link.run(book, ownGenre.id);
      link.run(book, foreignGenre.id);

      expect(listBookGenres(db, library, book).map((genre) => genre.id)).toEqual([ownGenre.id]);
      expect(listBookGenres(db, otherLibrary, book)).toEqual([]);
    });

    it('rolls back the whole replacement when a later insert fails (one transaction)', () => {
      const book = addBook(library, 'Book');
      const fantasy = createGenre(db, library, 'Фентезі');
      const history = createGenre(db, library, 'Історія');
      const poison = createGenre(db, library, 'Poison');
      setBookGenres(db, library, book, [fantasy.id]);
      db.exec(
        `CREATE TRIGGER fail_poison BEFORE INSERT ON book_genres
         WHEN NEW.genre_id = ${String(poison.id)}
         BEGIN SELECT RAISE(ABORT, 'insert failed'); END`,
      );

      expect(() => setBookGenres(db, library, book, [history.id, poison.id])).toThrow(
        /insert failed/,
      );

      expect(listBookGenres(db, library, book).map((genre) => genre.id)).toEqual([fantasy.id]);
    });

    it('returns false for a book that does not exist', () => {
      const fantasy = createGenre(db, library, 'Фентезі');

      expect(setBookGenres(db, library, 999, [fantasy.id])).toBe(false);
    });

    it('returns false and changes nothing for a binned book', () => {
      const book = addBook(library, 'Book');
      const fantasy = createGenre(db, library, 'Фентезі');
      const history = createGenre(db, library, 'Історія');
      setBookGenres(db, library, book, [fantasy.id]);
      softDeleteBook(db, library, book);

      expect(setBookGenres(db, library, book, [history.id])).toBe(false);

      expect(listBookGenres(db, library, book)).toEqual([]);
      expect(rawCount('book_genres')).toBe(1);
    });
  });
});

describe('reads', () => {
  let library: number;
  let book: number;

  beforeEach(() => {
    addUser(ALICE);
    addUser(BOB);
    library = familyLibrary(ALICE, [BOB]);
    book = addBook(library, 'Shared book');
  });

  it('a book is not read until the user marks it', () => {
    expect(isRead(db, ALICE, library, book)).toBe(false);
  });

  it('markRead marks the book for that user only', () => {
    expect(markRead(db, ALICE, library, book)).toBe(true);

    expect(isRead(db, ALICE, library, book)).toBe(true);
    expect(isRead(db, BOB, library, book)).toBe(false);
  });

  it("one member's mark and unmark never change another member's status", () => {
    markRead(db, ALICE, library, book);
    markRead(db, BOB, library, book);

    expect(unmarkRead(db, ALICE, library, book)).toBe(true);

    expect(isRead(db, ALICE, library, book)).toBe(false);
    expect(isRead(db, BOB, library, book)).toBe(true);
    expect(rawCount('book_reads')).toBe(1);
  });

  it('unmarking one book keeps the mark on another book of the same user', () => {
    const other = addBook(library, 'Other');
    markRead(db, ALICE, library, book);
    markRead(db, ALICE, library, other);

    expect(unmarkRead(db, ALICE, library, book)).toBe(true);

    expect(isRead(db, ALICE, library, other)).toBe(true);
    expect(isRead(db, ALICE, library, book)).toBe(false);
    expect(rawCount('book_reads')).toBe(1);
  });

  it('isRead is false for an unread book while another book of the library is read', () => {
    const other = addBook(library, 'Other');
    markRead(db, ALICE, library, book);

    expect(isRead(db, ALICE, library, other)).toBe(false);
    expect(isRead(db, ALICE, library, book)).toBe(true);
  });

  it('unmarking a book the user has not read changes nothing and returns false', () => {
    markRead(db, BOB, library, book);

    expect(unmarkRead(db, ALICE, library, book)).toBe(false);

    expect(isRead(db, BOB, library, book)).toBe(true);
  });

  it('marking twice keeps one row and the original read time', () => {
    freezeTime('2026-11-15T09:00:00.000Z');
    markRead(db, ALICE, library, book);
    freezeTime('2026-11-15T12:00:00.000Z');

    expect(markRead(db, ALICE, library, book)).toBe(true);

    expect(rawCount('book_reads')).toBe(1);
    expect(db.prepare('SELECT read_at FROM book_reads').get()).toEqual({
      read_at: '2026-11-15T09:00:00.000Z',
    });
  });

  it('a user can read several books', () => {
    const other = addBook(library, 'Other');

    markRead(db, ALICE, library, book);
    markRead(db, ALICE, library, other);

    expect(getReadBookIds(db, ALICE, library, [book, other])).toEqual(new Set([book, other]));
  });

  it('getReadBookIds returns only the read books among those asked for', () => {
    const second = addBook(library, 'Second');
    const third = addBook(library, 'Third');
    markRead(db, ALICE, library, book);
    markRead(db, ALICE, library, third);
    markRead(db, BOB, library, second);

    expect(getReadBookIds(db, ALICE, library, [book, second, third])).toEqual(
      new Set([book, third]),
    );
    expect(getReadBookIds(db, ALICE, library, [second])).toEqual(new Set());
    expect(getReadBookIds(db, BOB, library, [book, second, third])).toEqual(new Set([second]));
    expect(getReadBookIds(db, ALICE, library, [])).toEqual(new Set());
  });

  it('getReadBookIds ignores books that were not asked for', () => {
    const other = addBook(library, 'Other');
    markRead(db, ALICE, library, book);
    markRead(db, ALICE, library, other);

    expect(getReadBookIds(db, ALICE, library, [other])).toEqual(new Set([other]));
  });

  it('markRead returns false for an unknown book and writes nothing', () => {
    expect(markRead(db, ALICE, library, 999)).toBe(false);

    expect(rawCount('book_reads')).toBe(0);
  });

  it('keeps the read mark of a binned book and shows it again after restore', () => {
    markRead(db, ALICE, library, book);

    softDeleteBook(db, library, book);
    expect(isRead(db, ALICE, library, book)).toBe(false);
    expect(getReadBookIds(db, ALICE, library, [book])).toEqual(new Set());

    restoreBook(db, library, book);
    expect(isRead(db, ALICE, library, book)).toBe(true);
  });

  it('cannot mark or unmark a binned book', () => {
    markRead(db, ALICE, library, book);
    markRead(db, BOB, library, book);
    softDeleteBook(db, library, book);

    expect(markRead(db, ALICE, library, book)).toBe(false);
    expect(unmarkRead(db, ALICE, library, book)).toBe(false);
    expect(rawCount('book_reads')).toBe(2);
  });

  it('a user who is not a member cannot read or write marks (assertMember in every method)', () => {
    addUser(CAROL);
    markRead(db, ALICE, library, book);

    expect(() => markRead(db, CAROL, library, book)).toThrow(NotAMemberError);
    expect(() => unmarkRead(db, CAROL, library, book)).toThrow(NotAMemberError);
    expect(() => isRead(db, CAROL, library, book)).toThrow(NotAMemberError);
    expect(() => getReadBookIds(db, CAROL, library, [book])).toThrow(NotAMemberError);

    expect(rawCount('book_reads')).toBe(1);
  });
});

describe('library isolation', () => {
  // Alice owns library A (a personal library), Bob owns library B. Carol is in no library.
  // Library A holds an active book, a binned book, a genre, a genre link and a read mark.
  let libraryA: number;
  let libraryB: number;
  let activeBook: number;
  let binnedBook: number;
  let genreA: number;
  let before: string;

  beforeEach(() => {
    addUser(ALICE);
    addUser(BOB);
    addUser(CAROL);
    libraryA = personalLibrary(ALICE);
    libraryB = personalLibrary(BOB);
    activeBook = addBook(libraryA, 'Secret of A', { isbn13: '9780140449136' });
    binnedBook = addBinnedBook(libraryA, 'Binned secret of A');
    genreA = createGenre(db, libraryA, 'Secret genre').id;
    setBookGenres(db, libraryA, activeBook, [genreA]);
    markRead(db, ALICE, libraryA, activeBook);
    before = snapshotLibraryData();
  });

  it("another library's books are not found by id, listed or counted", () => {
    expect(getBook(db, libraryB, activeBook)).toBeNull();
    expect(getBook(db, libraryB, binnedBook)).toBeNull();
    expect(listBooks(db, libraryB, FIRST_PAGE)).toEqual([]);
    expect(countBooks(db, libraryB)).toBe(0);
    expect(getBook(db, libraryA, activeBook)).not.toBeNull();
  });

  it("another library's Bin is empty and cannot be restored or purged from", () => {
    expect(listBinBooks(db, libraryB, FIRST_PAGE)).toEqual([]);
    expect(countBinBooks(db, libraryB)).toBe(0);
    expect(restoreBook(db, libraryB, binnedBook)).toBe(false);
    expect(purgeBinBook(db, libraryB, binnedBook)).toBe(false);
    expect(snapshotLibraryData()).toBe(before);
    expect(countBinBooks(db, libraryA)).toBe(1);
  });

  it("another library's books cannot be updated or binned", () => {
    expect(updateBook(db, libraryB, activeBook, { title: 'Hacked', authors: 'Hacked' })).toBe(
      false,
    );
    expect(softDeleteBook(db, libraryB, activeBook)).toBe(false);

    expect(snapshotLibraryData()).toBe(before);
    expect(getBook(db, libraryA, activeBook)?.title).toBe('Secret of A');
  });

  it("another library's genres are not listed and cannot be attached to a book", () => {
    const ownBook = addBook(libraryB, 'Own book');

    expect(listGenres(db, libraryB)).toEqual([]);
    expect(() => setBookGenres(db, libraryB, ownBook, [genreA])).toThrow(GenreNotFoundError);
    expect(listBookGenres(db, libraryB, activeBook)).toEqual([]);
    expect(listBookGenres(db, libraryB, ownBook)).toEqual([]);
  });

  it("another library's book genres cannot be changed or cleared", () => {
    expect(setBookGenres(db, libraryB, activeBook, [])).toBe(false);

    expect(listBookGenres(db, libraryA, activeBook).map((genre) => genre.id)).toEqual([genreA]);
    expect(snapshotLibraryData()).toBe(before);
  });

  it("a member of B cannot reach A's read marks, with B's or with A's library id", () => {
    expect(isRead(db, BOB, libraryB, activeBook)).toBe(false);
    expect(markRead(db, BOB, libraryB, activeBook)).toBe(false);
    expect(unmarkRead(db, BOB, libraryB, activeBook)).toBe(false);
    expect(getReadBookIds(db, BOB, libraryB, [activeBook])).toEqual(new Set());
    expect(() => markRead(db, BOB, libraryA, activeBook)).toThrow(NotAMemberError);
    expect(() => unmarkRead(db, BOB, libraryA, activeBook)).toThrow(NotAMemberError);
    expect(() => isRead(db, BOB, libraryA, activeBook)).toThrow(NotAMemberError);
    expect(() => getReadBookIds(db, BOB, libraryA, [activeBook])).toThrow(NotAMemberError);

    expect(snapshotLibraryData()).toBe(before);
    expect(isRead(db, ALICE, libraryA, activeBook)).toBe(true);
  });

  it('a read mark is only visible through the library its book belongs to', () => {
    // Even for a user who is a member of both libraries, A's book is not reachable via B.
    db.prepare('INSERT INTO library_members (library_id, user_id, role) VALUES (?, ?, ?)').run(
      libraryB,
      ALICE,
      'member',
    );

    expect(isRead(db, ALICE, libraryB, activeBook)).toBe(false);
    expect(getReadBookIds(db, ALICE, libraryB, [activeBook])).toEqual(new Set());
    expect(markRead(db, ALICE, libraryB, binnedBook)).toBe(false);
    expect(unmarkRead(db, ALICE, libraryB, activeBook)).toBe(false);
    expect(isRead(db, ALICE, libraryA, activeBook)).toBe(true);
  });

  it('a user in no library fails assertMember for every library and cannot change the active library', () => {
    for (const library of [libraryA, libraryB]) {
      expect(() => {
        assertMember(db, CAROL, library);
      }).toThrow(NotAMemberError);
      expect(() => {
        setActiveLibrary(db, CAROL, library);
      }).toThrow(NotAMemberError);
      expect(getLibraryForMember(db, CAROL, library)).toBeNull();
    }
    expect(listUserLibraries(db, CAROL)).toEqual([]);
    expect(getActiveLibraryId(db, CAROL)).toBeNull();
    expect(snapshotLibraryData()).toBe(before);
  });

  it("one member's read status in a shared family library does not affect another's", () => {
    const family = familyLibrary(ALICE, [BOB]);
    const shared = addBook(family, 'Shared');

    markRead(db, ALICE, family, shared);

    expect(isRead(db, ALICE, family, shared)).toBe(true);
    expect(isRead(db, BOB, family, shared)).toBe(false);
    expect(getReadBookIds(db, BOB, family, [shared])).toEqual(new Set());
    markRead(db, BOB, family, shared);
    unmarkRead(db, ALICE, family, shared);
    expect(isRead(db, BOB, family, shared)).toBe(true);
  });

  it('the same operations succeed in the right library (the checks are not just always failing)', () => {
    expect(updateBook(db, libraryA, activeBook, { title: 'Secret of A, 2nd edition' })).toBe(true);
    expect(restoreBook(db, libraryA, binnedBook)).toBe(true);
    expect(softDeleteBook(db, libraryA, binnedBook)).toBe(true);
    expect(purgeBinBook(db, libraryA, binnedBook)).toBe(true);
    expect(setBookGenres(db, libraryA, activeBook, [])).toBe(true);
    expect(unmarkRead(db, ALICE, libraryA, activeBook)).toBe(true);
  });
});

describe('Bin exclusion', () => {
  let library: number;
  let active: number;
  let binned: number;

  beforeEach(() => {
    addUser(ALICE);
    library = personalLibrary(ALICE);
    active = addBook(library, 'Active');
    binned = addBook(library, 'Binned');
    const genre = createGenre(db, library, 'Фентезі');
    setBookGenres(db, library, binned, [genre.id]);
    markRead(db, ALICE, library, binned);
    softDeleteBook(db, library, binned);
  });

  it('no normal read returns the binned book', () => {
    expect(getBook(db, library, binned)).toBeNull();
    expect(listBooks(db, library, FIRST_PAGE).map((book) => book.id)).toEqual([active]);
    expect(countBooks(db, library)).toBe(1);
    expect(listBookGenres(db, library, binned)).toEqual([]);
    expect(isRead(db, ALICE, library, binned)).toBe(false);
    expect(getReadBookIds(db, ALICE, library, [active, binned])).toEqual(new Set());
  });

  it('no normal write changes the binned book', () => {
    const genre = listGenres(db, library)[0];

    expect(updateBook(db, library, binned, { title: 'X' })).toBe(false);
    expect(softDeleteBook(db, library, binned)).toBe(false);
    expect(setBookGenres(db, library, binned, genre ? [genre.id] : [])).toBe(false);
    expect(markRead(db, ALICE, library, binned)).toBe(false);
    expect(unmarkRead(db, ALICE, library, binned)).toBe(false);
    expect(rawCount('book_reads')).toBe(1);
  });

  it('the Bin methods see only binned books and cannot act on active ones', () => {
    expect(listBinBooks(db, library, FIRST_PAGE).map((book) => book.id)).toEqual([binned]);
    expect(countBinBooks(db, library)).toBe(1);
    expect(restoreBook(db, library, active)).toBe(false);
    expect(purgeBinBook(db, library, active)).toBe(false);
    expect(getBook(db, library, active)).not.toBeNull();
  });
});
