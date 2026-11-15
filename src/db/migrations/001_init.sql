-- 001_init: initial schema (see "Data model" in nimbalyst-local/plans/telegram-book-library-bot.md).
--
-- TIMESTAMP FORMAT (applies to every *_at column, in this file and in all code that writes them):
--   ISO-8601 UTC text, fixed width, millisecond precision, trailing "Z":
--     YYYY-MM-DDTHH:MM:SS.sssZ        e.g. 2026-11-15T09:30:00.000Z
--   In TypeScript this is exactly `new Date().toISOString()`. In SQL it is
--   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'). Because the width is fixed, comparing the values as
--   plain strings orders them correctly; the triggers below rely on that when they compare
--   invites.expires_at with "now". Every timestamp column has a CHECK that rejects any other
--   shape (a NULL passes the CHECK, so nullable columns stay nullable).
--
-- Relationships: libraries <-> users reference each other (owner_user_id / active_library_id),
-- so create users first, then the library, then set users.active_library_id.

-- ---------------------------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------------------------
CREATE TABLE users (
  id                INTEGER PRIMARY KEY,                 -- Telegram user id
  username          TEXT,
  first_name        TEXT,
  active_library_id INTEGER REFERENCES libraries (id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);

-- ---------------------------------------------------------------------------------------------
-- libraries
-- ---------------------------------------------------------------------------------------------
CREATE TABLE libraries (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('personal', 'family')),
  name          TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);

-- One personal library per owner. (Up to 3 family libraries per user is checked in code.)
CREATE UNIQUE INDEX libraries_one_personal_per_owner
  ON libraries (owner_user_id)
  WHERE kind = 'personal';

-- ---------------------------------------------------------------------------------------------
-- library_members
-- ---------------------------------------------------------------------------------------------
CREATE TABLE library_members (
  library_id INTEGER NOT NULL REFERENCES libraries (id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (joined_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY (library_id, user_id)
) WITHOUT ROWID;

-- The access gate asks "is this user a member of any library?" on every update; the primary key
-- is led by library_id and does not cover that lookup.
CREATE INDEX library_members_user_id ON library_members (user_id);

-- ---------------------------------------------------------------------------------------------
-- invites
-- ---------------------------------------------------------------------------------------------
-- A PENDING invite has accepted_at IS NULL, revoked_at IS NULL and expires_at in the future.
CREATE TABLE invites (
  id          INTEGER PRIMARY KEY,
  library_id  INTEGER NOT NULL REFERENCES libraries (id) ON DELETE CASCADE,
  created_by  INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('link', 'username')),
  token_hash  TEXT,                                      -- link invites: sha-256 of the token
  username    TEXT,                                      -- username invites: lowercased
  expires_at  TEXT NOT NULL
    CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  accepted_at TEXT
    CHECK (accepted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  accepted_by INTEGER,                                   -- no FK: kept as a record of who joined
  revoked_at  TEXT
    CHECK (revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- A link invite carries a token hash and no username; a username invite is the opposite.
  CHECK (
    (kind = 'link' AND token_hash IS NOT NULL AND username IS NULL)
    OR (kind = 'username' AND username IS NOT NULL AND token_hash IS NULL)
  )
);

CREATE INDEX invites_token_hash ON invites (token_hash);
CREATE INDEX invites_library_id ON invites (library_id);

-- ---------------------------------------------------------------------------------------------
-- genres (per library)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE genres (
  id         INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries (id) ON DELETE CASCADE,
  -- NOCASE folds ASCII letters only, so "Fantasy" and "fantasy" collide but "Фентезі" and
  -- "фентезі" do not. Cyrillic case-folding has to be done in code before inserting.
  name       TEXT NOT NULL COLLATE NOCASE,
  UNIQUE (library_id, name)
);

-- ---------------------------------------------------------------------------------------------
-- books
-- ---------------------------------------------------------------------------------------------
CREATE TABLE books (
  id             INTEGER PRIMARY KEY,
  library_id     INTEGER NOT NULL REFERENCES libraries (id) ON DELETE CASCADE,
  isbn13         TEXT,                                   -- nullable; NULLs never collide
  title          TEXT NOT NULL,
  authors        TEXT NOT NULL DEFAULT '',
  published_year INTEGER,
  publisher      TEXT,
  cover_path     TEXT,
  source         TEXT NOT NULL CHECK (source IN ('isbn', 'excel', 'manual')),
  added_by       INTEGER REFERENCES users (id) ON DELETE SET NULL, -- NULL for CLI/Excel imports
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  deleted_at     TEXT                                    -- NULL unless the book is in the Bin
    CHECK (deleted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);

-- A binned book keeps its isbn13, so the same ISBN can't be added twice to one library.
CREATE UNIQUE INDEX books_library_isbn13 ON books (library_id, isbn13);
CREATE INDEX books_library_deleted_at ON books (library_id, deleted_at);

-- ---------------------------------------------------------------------------------------------
-- book_genres (several genres per book)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE book_genres (
  book_id  INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres (id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, genre_id)
) WITHOUT ROWID;

-- A book may only be tagged with genres of its own library.
CREATE TRIGGER book_genres_same_library_insert
BEFORE INSERT ON book_genres
WHEN (SELECT library_id FROM books WHERE id = NEW.book_id)
     IS NOT (SELECT library_id FROM genres WHERE id = NEW.genre_id)
BEGIN
  SELECT RAISE(ABORT, 'book_genres: book and genre belong to different libraries');
END;

CREATE TRIGGER book_genres_same_library_update
BEFORE UPDATE OF book_id, genre_id ON book_genres
WHEN (SELECT library_id FROM books WHERE id = NEW.book_id)
     IS NOT (SELECT library_id FROM genres WHERE id = NEW.genre_id)
BEGIN
  SELECT RAISE(ABORT, 'book_genres: book and genre belong to different libraries');
END;

-- ---------------------------------------------------------------------------------------------
-- book_reads (per user; a row means "read", no row means "not read")
-- ---------------------------------------------------------------------------------------------
CREATE TABLE book_reads (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  read_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (read_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY (user_id, book_id)
) WITHOUT ROWID;

CREATE INDEX book_reads_book_id ON book_reads (book_id);

-- ---------------------------------------------------------------------------------------------
-- isbn_cache (global public metadata, not library data)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE isbn_cache (
  isbn13       TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  provider     TEXT NOT NULL,
  fetched_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (fetched_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);

-- ---------------------------------------------------------------------------------------------
-- books_fts: FTS5 index over title and authors, external-content on books.
-- Binned books stay in the index (so restore needs no re-index); search excludes them through
-- the shared repository helper, not here.
-- ---------------------------------------------------------------------------------------------
CREATE VIRTUAL TABLE books_fts USING fts5(
  title,
  authors,
  content = 'books',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER books_fts_insert AFTER INSERT ON books
BEGIN
  INSERT INTO books_fts (rowid, title, authors) VALUES (NEW.id, NEW.title, NEW.authors);
END;

CREATE TRIGGER books_fts_delete AFTER DELETE ON books
BEGIN
  INSERT INTO books_fts (books_fts, rowid, title, authors)
  VALUES ('delete', OLD.id, OLD.title, OLD.authors);
END;

CREATE TRIGGER books_fts_update AFTER UPDATE OF title, authors ON books
BEGIN
  INSERT INTO books_fts (books_fts, rowid, title, authors)
  VALUES ('delete', OLD.id, OLD.title, OLD.authors);
  INSERT INTO books_fts (rowid, title, authors) VALUES (NEW.id, NEW.title, NEW.authors);
END;

-- ---------------------------------------------------------------------------------------------
-- Family-size limit: members + pending invites <= 5 for a family library.
-- Personal libraries are not limited here. The check is BEFORE INSERT, so it counts the rows
-- that already exist; the new row is rejected when they already add up to 5.
--
-- Accepting an invite must mark the invite accepted BEFORE inserting the member. Otherwise the
-- still-pending invite and the new member are both counted and a library with 4 members + that
-- invite is wrongly rejected.
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER library_members_family_limit
BEFORE INSERT ON library_members
WHEN (SELECT kind FROM libraries WHERE id = NEW.library_id) = 'family'
 AND (
   (SELECT COUNT(*) FROM library_members WHERE library_id = NEW.library_id)
   + (SELECT COUNT(*) FROM invites
        WHERE library_id = NEW.library_id
          AND accepted_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
 ) >= 5
BEGIN
  SELECT RAISE(ABORT, 'family library is full: members + pending invites would exceed 5');
END;

-- Only a new invite that is itself pending counts toward the limit.
CREATE TRIGGER invites_family_limit
BEFORE INSERT ON invites
WHEN NEW.accepted_at IS NULL
 AND NEW.revoked_at IS NULL
 AND NEW.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 AND (SELECT kind FROM libraries WHERE id = NEW.library_id) = 'family'
 AND (
   (SELECT COUNT(*) FROM library_members WHERE library_id = NEW.library_id)
   + (SELECT COUNT(*) FROM invites
        WHERE library_id = NEW.library_id
          AND accepted_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
 ) >= 5
BEGIN
  SELECT RAISE(ABORT, 'family library is full: members + pending invites would exceed 5');
END;
