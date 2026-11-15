import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IN_MEMORY_DB_PATH, openDatabase } from '../src/db/index.js';
import { MigrationError, runMigrations } from '../src/db/migrate.js';

type Db = Database.Database;

const FAMILY_LIMIT = 5;
const HOUR_MS = 60 * 60 * 1000;

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function createUser(db: Db, id: number): number {
  db.prepare('INSERT INTO users (id, first_name) VALUES (?, ?)').run(id, `user${String(id)}`);
  return id;
}

function createLibrary(db: Db, kind: 'personal' | 'family', ownerUserId: number): number {
  const result = db
    .prepare('INSERT INTO libraries (kind, name, owner_user_id) VALUES (?, ?, ?)')
    .run(kind, `${kind} of ${String(ownerUserId)}`, ownerUserId);
  return Number(result.lastInsertRowid);
}

function addMember(db: Db, libraryId: number, userId: number, role = 'member'): void {
  db.prepare('INSERT INTO library_members (library_id, user_id, role) VALUES (?, ?, ?)').run(
    libraryId,
    userId,
    role,
  );
}

interface InviteOptions {
  expiresAt?: string;
  acceptedAt?: string | null;
  revokedAt?: string | null;
}

let inviteCounter = 0;

function addInvite(
  db: Db,
  libraryId: number,
  createdBy: number,
  options: InviteOptions = {},
): void {
  inviteCounter += 1;
  db.prepare(
    `INSERT INTO invites (library_id, created_by, kind, token_hash, expires_at, accepted_at, revoked_at)
     VALUES (?, ?, 'link', ?, ?, ?, ?)`,
  ).run(
    libraryId,
    createdBy,
    `hash-${String(inviteCounter)}`,
    options.expiresAt ?? iso(HOUR_MS),
    options.acceptedAt ?? null,
    options.revokedAt ?? null,
  );
}

function addBook(db: Db, libraryId: number, title: string, authors = ''): number {
  const result = db
    .prepare("INSERT INTO books (library_id, title, authors, source) VALUES (?, ?, ?, 'manual')")
    .run(libraryId, title, authors);
  return Number(result.lastInsertRowid);
}

function addGenre(db: Db, libraryId: number, name: string): number {
  const result = db
    .prepare('INSERT INTO genres (library_id, name) VALUES (?, ?)')
    .run(libraryId, name);
  return Number(result.lastInsertRowid);
}

function count(db: Db, table: string, where = '1 = 1'): number {
  // Table and condition are fixed literals from this test file, never user input.
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as {
    n: number;
  };
  return row.n;
}

function ftsSearch(db: Db, match: string): string[] {
  const rows = db
    .prepare(
      'SELECT books.title AS title FROM books_fts JOIN books ON books.id = books_fts.rowid WHERE books_fts MATCH ?',
    )
    .all(match) as { title: string }[];
  return rows.map((row) => row.title);
}

function ftsRowids(db: Db, match: string): number[] {
  // No join to books: this reads the index itself, so a stale entry for a deleted row shows up.
  const rows = db.prepare('SELECT rowid FROM books_fts WHERE books_fts MATCH ?').all(match) as {
    rowid: number;
  }[];
  return rows.map((row) => row.rowid);
}

function checkFtsIntegrity(db: Db): void {
  // rank = 1 also compares the index with the content table, so it fails on a stale or missing entry.
  db.exec("INSERT INTO books_fts (books_fts, rank) VALUES ('integrity-check', 1)");
}

describe('migrations', () => {
  it('applies 001_init, sets user_version to 1 and creates the expected tables', () => {
    const db = openDatabase(IN_MEMORY_DB_PATH);

    expect(db.pragma('user_version', { simple: true })).toBe(1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((table) => table.name);
    for (const expected of [
      'users',
      'libraries',
      'library_members',
      'invites',
      'genres',
      'books',
      'book_genres',
      'book_reads',
      'isbn_cache',
      'books_fts',
    ]) {
      expect(names).toContain(expected);
    }
    db.close();
  });

  it('is a no-op the second time it runs', () => {
    const db = openDatabase(IN_MEMORY_DB_PATH);
    const schemaBefore = db
      .prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name')
      .all();

    const applied = runMigrations(db);

    expect(applied).toEqual([]);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()).toEqual(
      schemaBefore,
    );
    db.close();
  });

  describe('runner with custom migration files', () => {
    let dir: string;
    let db: Db;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'migrations-'));
      db = new Database(IN_MEMORY_DB_PATH);
    });
    afterEach(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('applies files in numeric order and skips versions already applied', () => {
      writeFileSync(join(dir, '002_second.sql'), 'CREATE TABLE b (x INTEGER);');
      writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE a (x INTEGER);');

      expect(runMigrations(db, dir)).toEqual([1, 2]);
      writeFileSync(join(dir, '003_third.sql'), 'CREATE TABLE c (x INTEGER);');
      expect(runMigrations(db, dir)).toEqual([3]);
      expect(db.pragma('user_version', { simple: true })).toBe(3);
    });

    it('rolls back a failing migration together with its user_version bump', () => {
      writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE a (x INTEGER);');
      writeFileSync(
        join(dir, '002_broken.sql'),
        'CREATE TABLE b (x INTEGER); INSERT INTO missing_table VALUES (1);',
      );

      expect(() => runMigrations(db, dir)).toThrow(MigrationError);

      expect(db.pragma('user_version', { simple: true })).toBe(1);
      const leftover = db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get();
      expect(leftover).toBeUndefined();
    });

    it('rejects a gap in the version numbers', () => {
      writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE a (x INTEGER);');
      writeFileSync(join(dir, '003_third.sql'), 'CREATE TABLE c (x INTEGER);');

      expect(() => runMigrations(db, dir)).toThrow(MigrationError);
    });

    it('refuses a database that is newer than the known migrations', () => {
      writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE a (x INTEGER);');
      db.exec('PRAGMA user_version = 7');

      expect(() => runMigrations(db, dir)).toThrow(MigrationError);
    });
  });
});

describe('openDatabase on a file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'db-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sets WAL, foreign keys and the busy timeout, and creates a missing parent directory', () => {
    const path = join(dir, 'nested', 'deeper', 'library.db');

    const db = openDatabase(path);

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.close();
  });

  it('works when the parent directory already exists and keeps data across reopen', () => {
    const path = join(dir, 'library.db');
    mkdirSync(dir, { recursive: true });
    const first = openDatabase(path);
    createUser(first, 1);
    first.close();

    const second = openDatabase(path);

    expect(count(second, 'users')).toBe(1);
    expect(second.pragma('user_version', { simple: true })).toBe(1);
    second.close();
  });

  it('enforces foreign keys on the opened handle', () => {
    const db = openDatabase(IN_MEMORY_DB_PATH);

    expect(() => createLibrary(db, 'personal', 999)).toThrow(/FOREIGN KEY/);
    db.close();
  });
});

describe('schema', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(IN_MEMORY_DB_PATH);
  });
  afterEach(() => {
    db.close();
  });

  describe('books_fts', () => {
    it('finds a book after insert, with a Cyrillic prefix in a different case', () => {
      const user = createUser(db, 1);
      const library = createLibrary(db, 'personal', user);
      addBook(db, library, 'Гаррі Поттер і келих вогню', 'Джоан Роулінг');

      expect(ftsSearch(db, '"гарр"*')).toEqual(['Гаррі Поттер і келих вогню']);
      expect(ftsSearch(db, '"ГАРР"*')).toEqual(['Гаррі Поттер і келих вогню']);
      expect(ftsSearch(db, '"роулін"*')).toEqual(['Гаррі Поттер і келих вогню']);
    });

    it('ignores diacritics', () => {
      const library = createLibrary(db, 'personal', createUser(db, 1));
      addBook(db, library, 'Café Society');

      expect(ftsSearch(db, '"cafe"*')).toEqual(['Café Society']);
    });

    it('re-indexes on update: the old text no longer matches and the new text does', () => {
      const library = createLibrary(db, 'personal', createUser(db, 1));
      const id = addBook(db, library, 'Гаррі Поттер', 'Роулінг');

      db.prepare('UPDATE books SET title = ?, authors = ? WHERE id = ?').run(
        'Володар перснів',
        'Толкін',
        id,
      );

      expect(ftsSearch(db, '"гарр"*')).toEqual([]);
      expect(ftsSearch(db, '"роулін"*')).toEqual([]);
      expect(ftsSearch(db, '"володар"*')).toEqual(['Володар перснів']);
      expect(ftsSearch(db, '"толк"*')).toEqual(['Володар перснів']);
    });

    it('removes the book from the index on delete', () => {
      const library = createLibrary(db, 'personal', createUser(db, 1));
      const id = addBook(db, library, 'Гаррі Поттер');

      db.prepare('DELETE FROM books WHERE id = ?').run(id);

      expect(ftsSearch(db, '"гарр"*')).toEqual([]);
      // The index entry itself is gone, not merely hidden by the join to books.
      expect(ftsRowids(db, '"гарр"*')).toEqual([]);
      // The index stays consistent with the (now empty) content table.
      expect(() => {
        checkFtsIntegrity(db);
      }).not.toThrow();
    });

    it('keeps the index consistent when only unrelated columns change', () => {
      const library = createLibrary(db, 'personal', createUser(db, 1));
      const id = addBook(db, library, 'Гаррі Поттер');

      db.prepare('UPDATE books SET deleted_at = ? WHERE id = ?').run(iso(), id);

      expect(ftsSearch(db, '"гарр"*')).toEqual(['Гаррі Поттер']);
      expect(() => {
        checkFtsIntegrity(db);
      }).not.toThrow();
    });

    it('stays consistent when INSERT OR REPLACE replaces a book with the same library and ISBN', () => {
      const library = createLibrary(db, 'personal', createUser(db, 1));
      const insert = db.prepare(
        "INSERT OR REPLACE INTO books (library_id, isbn13, title, source) VALUES (?, '9780306406157', ?, 'isbn')",
      );
      insert.run(library, 'Гаррі Поттер');

      insert.run(library, 'Володар перснів');

      expect(count(db, 'books')).toBe(1);
      expect(ftsSearch(db, '"володар"*')).toEqual(['Володар перснів']);
      expect(ftsRowids(db, '"гарр"*')).toEqual([]);
      expect(() => {
        checkFtsIntegrity(db);
      }).not.toThrow();
    });
  });

  describe('personal library uniqueness', () => {
    it('rejects a second personal library for the same owner', () => {
      const user = createUser(db, 1);
      createLibrary(db, 'personal', user);

      expect(() => createLibrary(db, 'personal', user)).toThrow(/UNIQUE/);
    });

    it('allows personal libraries for different owners and family libraries for the same owner', () => {
      const first = createUser(db, 1);
      const second = createUser(db, 2);
      createLibrary(db, 'personal', first);

      expect(() => {
        createLibrary(db, 'personal', second);
        createLibrary(db, 'family', first);
        createLibrary(db, 'family', first);
        createLibrary(db, 'family', first);
      }).not.toThrow();
    });
  });

  describe('enum and format constraints', () => {
    it('rejects unknown kind, role and source values', () => {
      const user = createUser(db, 1);
      expect(() =>
        db
          .prepare("INSERT INTO libraries (kind, name, owner_user_id) VALUES ('public', 'x', ?)")
          .run(user),
      ).toThrow(/CHECK/);
      const library = createLibrary(db, 'family', user);
      expect(() => {
        db.prepare(
          "INSERT INTO library_members (library_id, user_id, role) VALUES (?, ?, 'admin')",
        ).run(library, user);
      }).toThrow(/CHECK/);
      expect(() =>
        db
          .prepare("INSERT INTO books (library_id, title, source) VALUES (?, 't', 'scan')")
          .run(library),
      ).toThrow(/CHECK/);
    });

    it('rejects a timestamp that is not ISO-8601 UTC with milliseconds', () => {
      const user = createUser(db, 1);
      const library = createLibrary(db, 'family', user);

      expect(() => {
        db.prepare(
          "INSERT INTO invites (library_id, created_by, kind, token_hash, expires_at) VALUES (?, ?, 'link', 'h', ?)",
        ).run(library, user, '2030-01-01 00:00:00');
      }).toThrow(/CHECK/);
    });

    it('requires a token hash for link invites and a username for username invites', () => {
      const user = createUser(db, 1);
      const library = createLibrary(db, 'family', user);
      const insert = db.prepare(
        'INSERT INTO invites (library_id, created_by, kind, token_hash, username, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      );

      expect(() => insert.run(library, user, 'link', null, null, iso(HOUR_MS))).toThrow(/CHECK/);
      expect(() => insert.run(library, user, 'username', 'h', null, iso(HOUR_MS))).toThrow(/CHECK/);
      expect(() => insert.run(library, user, 'username', null, 'anna', iso(HOUR_MS))).not.toThrow();
    });
  });

  describe('genres and ISBNs', () => {
    it('treats genre names as unique per library, ignoring ASCII case', () => {
      const user = createUser(db, 1);
      const first = createLibrary(db, 'personal', user);
      const second = createLibrary(db, 'family', user);
      addGenre(db, first, 'Fantasy');

      expect(() => addGenre(db, first, 'fantasy')).toThrow(/UNIQUE/);
      expect(() => addGenre(db, second, 'fantasy')).not.toThrow();
    });

    it('allows the same ISBN in different libraries but not twice in one', () => {
      const user = createUser(db, 1);
      const first = createLibrary(db, 'personal', user);
      const second = createLibrary(db, 'family', user);
      const insert = db.prepare(
        "INSERT INTO books (library_id, isbn13, title, source) VALUES (?, '9780306406157', 't', 'isbn')",
      );
      insert.run(first);

      expect(() => insert.run(first)).toThrow(/UNIQUE/);
      expect(() => insert.run(second)).not.toThrow();
    });

    it('allows several books without an ISBN in one library', () => {
      const library = createLibrary(db, 'personal', createUser(db, 1));

      expect(() => {
        addBook(db, library, 'One');
        addBook(db, library, 'Two');
      }).not.toThrow();
    });
  });

  describe('family size trigger', () => {
    function familyWithOwner(): { library: number; owner: number } {
      const owner = createUser(db, 1);
      const library = createLibrary(db, 'family', owner);
      addMember(db, library, owner, 'owner');
      return { library, owner };
    }

    function addMembers(library: number, howMany: number, firstId: number): void {
      for (let id = firstId; id < firstId + howMany; id += 1) {
        createUser(db, id);
        addMember(db, library, id);
      }
    }

    it('allows 5 members and rejects the 6th', () => {
      const { library } = familyWithOwner();
      addMembers(library, FAMILY_LIMIT - 1, 10);
      createUser(db, 99);

      expect(count(db, 'library_members', `library_id = ${String(library)}`)).toBe(FAMILY_LIMIT);
      expect(() => {
        addMember(db, library, 99);
      }).toThrow(/family library is full/);
      expect(count(db, 'library_members', `library_id = ${String(library)}`)).toBe(FAMILY_LIMIT);
    });

    it('rejects a 5th member when 4 members + 1 pending invite already fill the library', () => {
      const { library, owner } = familyWithOwner();
      addMembers(library, 3, 10);
      addInvite(db, library, owner);
      createUser(db, 99);

      expect(() => {
        addMember(db, library, 99);
      }).toThrow(/family library is full/);
    });

    it('rejects a new pending invite when 5 members already fill the library', () => {
      const { library, owner } = familyWithOwner();
      addMembers(library, FAMILY_LIMIT - 1, 10);

      expect(() => {
        addInvite(db, library, owner);
      }).toThrow(/family library is full/);
    });

    it('rejects a pending invite when members + pending invites are already 5', () => {
      const { library, owner } = familyWithOwner();
      addMembers(library, 2, 10);
      addInvite(db, library, owner);
      addInvite(db, library, owner);

      expect(() => {
        addInvite(db, library, owner);
      }).toThrow(/family library is full/);
    });

    it('does not count expired, revoked or accepted invites', () => {
      const { library, owner } = familyWithOwner();
      addMembers(library, 3, 10);
      addInvite(db, library, owner, { expiresAt: iso(-HOUR_MS) });
      addInvite(db, library, owner, { revokedAt: iso() });
      addInvite(db, library, owner, { acceptedAt: iso() });
      createUser(db, 99);

      expect(() => {
        addMember(db, library, 99);
      }).not.toThrow();
      expect(count(db, 'library_members', `library_id = ${String(library)}`)).toBe(FAMILY_LIMIT);
    });

    it('lets a new invite that is already expired, revoked or accepted be stored in a full library', () => {
      const { library, owner } = familyWithOwner();
      addMembers(library, FAMILY_LIMIT - 1, 10);

      expect(() => {
        addInvite(db, library, owner, { expiresAt: iso(-HOUR_MS) });
        addInvite(db, library, owner, { revokedAt: iso() });
        addInvite(db, library, owner, { acceptedAt: iso() });
      }).not.toThrow();
    });

    it('counts an invite as pending until its expiry passes', () => {
      const { library, owner } = familyWithOwner();
      addMembers(library, FAMILY_LIMIT - 2, 10);
      addInvite(db, library, owner, { expiresAt: iso(HOUR_MS) });
      createUser(db, 99);

      expect(() => {
        addMember(db, library, 99);
      }).toThrow(/family library is full/);

      // Same invite, but the clock has passed its expiry.
      db.prepare('UPDATE invites SET expires_at = ?').run(iso(-1000));
      expect(() => {
        addMember(db, library, 99);
      }).not.toThrow();
    });

    it('accepting an invite works when the invite is marked accepted before the member is added', () => {
      const { library, owner } = familyWithOwner();
      addMembers(library, 3, 10);
      addInvite(db, library, owner);
      createUser(db, 99);

      db.transaction(() => {
        db.prepare('UPDATE invites SET accepted_at = ?, accepted_by = ?').run(iso(), 99);
        addMember(db, library, 99);
      })();

      expect(count(db, 'library_members', `library_id = ${String(library)}`)).toBe(FAMILY_LIMIT);
    });

    function pendingInvites(library: number): number {
      return count(
        db,
        'invites',
        `library_id = ${String(library)} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      );
    }

    it('accepts a new pending invite when only expired, revoked and accepted invites sit beside 4 members', () => {
      const { library, owner } = familyWithOwner();
      addMembers(library, 3, 10);
      addInvite(db, library, owner, { expiresAt: iso(-HOUR_MS) });
      addInvite(db, library, owner, { revokedAt: iso() });
      addInvite(db, library, owner, { acceptedAt: iso() });

      expect(() => {
        addInvite(db, library, owner);
      }).not.toThrow();

      const members = count(db, 'library_members', `library_id = ${String(library)}`);
      expect(members + pendingInvites(library)).toBe(FAMILY_LIMIT);
      expect(pendingInvites(library)).toBe(1);
    });

    it('counts members per library when checking a new invite', () => {
      const { library: full } = familyWithOwner();
      addMembers(full, FAMILY_LIMIT - 1, 10);
      const otherOwner = createUser(db, 2);
      const other = createLibrary(db, 'family', otherOwner);
      addMember(db, other, otherOwner, 'owner');

      expect(() => {
        addInvite(db, other, otherOwner);
      }).not.toThrow();
      expect(pendingInvites(other)).toBe(1);
    });

    it('counts pending invites per library when checking a new invite', () => {
      const busyOwner = createUser(db, 3);
      const busy = createLibrary(db, 'family', busyOwner);
      addMember(db, busy, busyOwner, 'owner');
      for (let i = 0; i < FAMILY_LIMIT - 1; i += 1) addInvite(db, busy, busyOwner);
      const otherOwner = createUser(db, 2);
      const other = createLibrary(db, 'family', otherOwner);
      addMember(db, other, otherOwner, 'owner');

      expect(pendingInvites(busy)).toBe(FAMILY_LIMIT - 1);
      expect(() => {
        addInvite(db, other, otherOwner);
      }).not.toThrow();
      expect(pendingInvites(other)).toBe(1);
    });

    it('does not limit personal libraries', () => {
      const owner = createUser(db, 1);
      const library = createLibrary(db, 'personal', owner);

      expect(() => {
        for (let id = 10; id < 10 + FAMILY_LIMIT + 3; id += 1) {
          createUser(db, id);
          addMember(db, library, id);
        }
        for (let i = 0; i < FAMILY_LIMIT + 3; i += 1) addInvite(db, library, owner);
      }).not.toThrow();
    });

    it('counts each family library separately', () => {
      const { library } = familyWithOwner();
      addMembers(library, FAMILY_LIMIT - 1, 10);
      const other = createLibrary(db, 'family', 1);

      expect(() => {
        addMember(db, other, 10);
      }).not.toThrow();
    });
  });

  describe('book_genres same-library trigger', () => {
    it('links a book and a genre of the same library', () => {
      const library = createLibrary(db, 'personal', createUser(db, 1));
      const book = addBook(db, library, 'Book');
      const genre = addGenre(db, library, 'Fantasy');

      db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)').run(book, genre);

      expect(count(db, 'book_genres')).toBe(1);
    });

    it('rejects a genre from another library on insert', () => {
      const user = createUser(db, 1);
      const mine = createLibrary(db, 'personal', user);
      const other = createLibrary(db, 'family', user);
      const book = addBook(db, mine, 'Book');
      const foreignGenre = addGenre(db, other, 'Fantasy');

      expect(() =>
        db
          .prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)')
          .run(book, foreignGenre),
      ).toThrow(/different libraries/);
      expect(count(db, 'book_genres')).toBe(0);
    });

    it('rejects re-pointing an existing link to a genre of another library', () => {
      const user = createUser(db, 1);
      const mine = createLibrary(db, 'personal', user);
      const other = createLibrary(db, 'family', user);
      const book = addBook(db, mine, 'Book');
      const genre = addGenre(db, mine, 'Fantasy');
      const foreignGenre = addGenre(db, other, 'Horror');
      db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)').run(book, genre);

      expect(() =>
        db.prepare('UPDATE book_genres SET genre_id = ? WHERE book_id = ?').run(foreignGenre, book),
      ).toThrow(/different libraries/);
    });
  });

  describe('book_reads', () => {
    it('keeps one row per (user, book): users may share a book, a user may read several books, no repeats', () => {
      const owner = createUser(db, 1);
      const reader = createUser(db, 2);
      const library = createLibrary(db, 'family', owner);
      const book = addBook(db, library, 'Book');
      const otherBook = addBook(db, library, 'Other book');
      const insert = db.prepare('INSERT INTO book_reads (user_id, book_id) VALUES (?, ?)');

      insert.run(owner, book);
      insert.run(reader, book);
      insert.run(owner, otherBook);

      expect(count(db, 'book_reads', `book_id = ${String(book)}`)).toBe(2);
      expect(count(db, 'book_reads', `user_id = ${String(owner)}`)).toBe(2);
      expect(count(db, 'book_reads', `user_id = ${String(reader)}`)).toBe(1);
      expect(() => insert.run(owner, book)).toThrow(/UNIQUE|PRIMARY KEY/);
      expect(count(db, 'book_reads')).toBe(3);
    });
  });

  describe('cascades', () => {
    it('deleting a library removes its members, invites, genres, books and their links', () => {
      const owner = createUser(db, 1);
      const reader = createUser(db, 2);
      const library = createLibrary(db, 'family', owner);
      addMember(db, library, owner, 'owner');
      addMember(db, library, reader);
      addInvite(db, library, owner);
      const genre = addGenre(db, library, 'Fantasy');
      const book = addBook(db, library, 'Гаррі Поттер');
      db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)').run(book, genre);
      db.prepare('INSERT INTO book_reads (user_id, book_id) VALUES (?, ?)').run(reader, book);
      db.prepare('UPDATE users SET active_library_id = ? WHERE id = ?').run(library, reader);

      db.prepare('DELETE FROM libraries WHERE id = ?').run(library);

      for (const table of [
        'library_members',
        'invites',
        'genres',
        'books',
        'book_genres',
        'book_reads',
      ]) {
        expect(count(db, table), table).toBe(0);
      }
      expect(ftsSearch(db, '"гарр"*')).toEqual([]);
      // Users survive, and the dangling active library is cleared.
      expect(count(db, 'users')).toBe(2);
      expect(
        db.prepare('SELECT active_library_id AS a FROM users WHERE id = ?').get(reader),
      ).toEqual({
        a: null,
      });
    });

    it('does not touch another library when one is deleted', () => {
      const user = createUser(db, 1);
      const doomed = createLibrary(db, 'family', user);
      const kept = createLibrary(db, 'personal', user);
      addBook(db, doomed, 'Doomed');
      const keptBook = addBook(db, kept, 'Kept');
      addGenre(db, kept, 'Fantasy');

      db.prepare('DELETE FROM libraries WHERE id = ?').run(doomed);

      expect(count(db, 'books')).toBe(1);
      expect(count(db, 'genres')).toBe(1);
      expect(db.prepare('SELECT id FROM books').get()).toEqual({ id: keptBook });
    });

    it('deleting a book removes its reads and genre links but keeps the genre and other reads', () => {
      const owner = createUser(db, 1);
      const reader = createUser(db, 2);
      const library = createLibrary(db, 'family', owner);
      const genre = addGenre(db, library, 'Fantasy');
      const doomed = addBook(db, library, 'Doomed');
      const kept = addBook(db, library, 'Kept');
      for (const book of [doomed, kept]) {
        db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)').run(book, genre);
        db.prepare('INSERT INTO book_reads (user_id, book_id) VALUES (?, ?)').run(reader, book);
      }

      db.prepare('DELETE FROM books WHERE id = ?').run(doomed);

      expect(count(db, 'book_genres', `book_id = ${String(doomed)}`)).toBe(0);
      expect(count(db, 'book_reads', `book_id = ${String(doomed)}`)).toBe(0);
      expect(count(db, 'book_genres', `book_id = ${String(kept)}`)).toBe(1);
      expect(count(db, 'book_reads', `book_id = ${String(kept)}`)).toBe(1);
      expect(count(db, 'genres')).toBe(1);
    });

    it('deleting a genre unlinks it from books but keeps the books', () => {
      const library = createLibrary(db, 'personal', createUser(db, 1));
      const genre = addGenre(db, library, 'Fantasy');
      const book = addBook(db, library, 'Book');
      db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)').run(book, genre);

      db.prepare('DELETE FROM genres WHERE id = ?').run(genre);

      expect(count(db, 'book_genres')).toBe(0);
      expect(count(db, 'books')).toBe(1);
    });

    it('refuses to delete a user who still owns a library', () => {
      const user = createUser(db, 1);
      createLibrary(db, 'personal', user);

      expect(() => db.prepare('DELETE FROM users WHERE id = ?').run(user)).toThrow(/FOREIGN KEY/);
    });
  });
});
