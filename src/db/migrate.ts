import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Database } from 'better-sqlite3';

// Resolved relative to this file, so it works under tsx (src/db/migrations) and after
// `npm run build` (dist/db/migrations, copied by the build script).
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

// "001_init.sql" -> version 1. The numeric prefix is the schema version stored in user_version.
const MIGRATION_FILE_PATTERN = /^(\d+)_[A-Za-z0-9_-]+\.sql$/;

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

interface Migration {
  readonly version: number;
  readonly file: string;
}

function listMigrations(dir: string): Migration[] {
  const migrations: Migration[] = [];
  for (const file of readdirSync(dir)) {
    const match = MIGRATION_FILE_PATTERN.exec(file);
    if (match === null) continue;
    migrations.push({ version: Number(match[1]), file });
  }
  migrations.sort((a, b) => a.version - b.version);

  // Versions must be 1, 2, 3, ... so that user_version always means "migrations 1..N applied".
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(
        `Migration versions must be contiguous from 1: found ${migration.file} at position ${String(index + 1)}`,
      );
    }
  });
  return migrations;
}

function readUserVersion(db: Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Applies every `NNN_name.sql` file in `dir` whose version is above the database's
 * `user_version`, in order. Each file runs in one transaction together with its `user_version`
 * bump, so a failing migration leaves the database at the previous version. Calling it again
 * when everything is applied does nothing. Returns the versions applied by this call.
 */
export function runMigrations(db: Database, dir: string = DEFAULT_MIGRATIONS_DIR): number[] {
  const migrations = listMigrations(dir);
  const current = readUserVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new MigrationError(
      `Database schema version ${String(current)} is newer than the latest known migration ${String(latest)}`,
    );
  }

  const applied: number[] = [];
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    const sql = readFileSync(join(dir, migration.file), 'utf8');
    // PRAGMA can't take bound parameters; the value is an integer parsed from the file name.
    const bump = `PRAGMA user_version = ${String(migration.version)}`;
    const apply = db.transaction(() => {
      db.exec(sql);
      db.exec(bump);
    });
    try {
      apply();
    } catch (error) {
      throw new MigrationError(`Migration ${migration.file} failed`, { cause: error });
    }
    applied.push(migration.version);
  }
  return applied;
}
