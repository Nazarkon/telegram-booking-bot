import type { Database } from 'better-sqlite3';

import { nowIso } from '../time.js';
import { assertMember } from './scope.js';

export interface User {
  readonly id: number;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly activeLibraryId: number | null;
}

export interface TelegramUserData {
  readonly id: number;
  readonly username: string | null;
  readonly firstName: string | null;
}

interface UserRow {
  id: number;
  username: string | null;
  first_name: string | null;
  active_library_id: number | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    firstName: row.first_name,
    activeLibraryId: row.active_library_id,
  };
}

const USER_COLUMNS = 'id, username, first_name, active_library_id';

/**
 * Creates the user or refreshes their username and first name from Telegram (the user may have
 * renamed). The active library is left untouched.
 */
export function upsertUser(db: Database, data: TelegramUserData): User {
  const now = nowIso();
  db.prepare(
    `INSERT INTO users (id, username, first_name, created_at, updated_at)
     VALUES (@id, @username, @firstName, @now, @now)
     ON CONFLICT (id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       updated_at = excluded.updated_at`,
  ).run({ id: data.id, username: data.username, firstName: data.firstName, now });
  const user = getUser(db, data.id);
  if (user === null) {
    throw new Error(`User ${String(data.id)} missing right after upsert`);
  }
  return user;
}

export function getUser(db: Database, userId: number): User | null {
  const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(userId) as
    UserRow | undefined;
  return row === undefined ? null : toUser(row);
}

/**
 * Stores the user's active library. Throws `NotAMemberError` if the user is not a member, so
 * the active library can never point at someone else's library.
 */
export function setActiveLibrary(db: Database, userId: number, libraryId: number): void {
  assertMember(db, userId, libraryId);
  db.prepare('UPDATE users SET active_library_id = ?, updated_at = ? WHERE id = ?').run(
    libraryId,
    nowIso(),
    userId,
  );
}

/**
 * The user's active library, or null when none is set or it is stale (the user has since left
 * it): membership is checked here, so callers can fall back to the personal library.
 */
export function getActiveLibraryId(db: Database, userId: number): number | null {
  const row = db
    .prepare(
      `SELECT u.active_library_id AS library_id
       FROM users u
       JOIN library_members m ON m.library_id = u.active_library_id AND m.user_id = u.id
       WHERE u.id = ?`,
    )
    .get(userId) as { library_id: number } | undefined;
  return row === undefined ? null : row.library_id;
}
