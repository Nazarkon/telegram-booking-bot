import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from './migrate.js';

export const IN_MEMORY_DB_PATH = ':memory:';
const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens the SQLite database at `path` (or `:memory:` for tests), applies the required pragmas,
 * runs pending migrations and returns the handle. A missing parent directory of a file
 * database is created. If anything fails after opening, the handle is closed before the error
 * is rethrown.
 */
export function openDatabase(path: string): Database.Database {
  if (path !== IN_MEMORY_DB_PATH) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  try {
    // WAL is not available for :memory: (SQLite keeps reporting "memory"); that is fine for tests.
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // INSERT OR REPLACE deletes the old row through REPLACE; without this the books_fts_delete
    // trigger would not fire for it and the FTS index would keep a stale entry.
    db.pragma('recursive_triggers = ON');
    db.pragma(`busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
    runMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
