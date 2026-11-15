import type { Database } from 'better-sqlite3';

import { nowIso } from '../time.js';

export type LibraryKind = 'personal' | 'family';
export type MemberRole = 'owner' | 'member';

export interface Library {
  readonly id: number;
  readonly kind: LibraryKind;
  readonly name: string;
  readonly ownerUserId: number;
}

export interface MemberLibrary extends Library {
  readonly role: MemberRole;
}

interface LibraryRow {
  id: number;
  kind: LibraryKind;
  name: string;
  owner_user_id: number;
}

interface MemberLibraryRow extends LibraryRow {
  role: MemberRole;
}

function toLibrary(row: LibraryRow): Library {
  return { id: row.id, kind: row.kind, name: row.name, ownerUserId: row.owner_user_id };
}

function toMemberLibrary(row: MemberLibraryRow): MemberLibrary {
  return { ...toLibrary(row), role: row.role };
}

/**
 * Creates the user's personal library and their owner membership in one transaction, so a
 * failure never leaves a library without an owner member. The user row must already exist.
 * The one-personal-library rule is enforced by a unique index and surfaces as a SQLite error.
 */
export function createPersonalLibrary(db: Database, ownerUserId: number, name: string): Library {
  const create = db.transaction((): Library => {
    const now = nowIso();
    const result = db
      .prepare(
        "INSERT INTO libraries (kind, name, owner_user_id, created_at) VALUES ('personal', ?, ?, ?)",
      )
      .run(name, ownerUserId, now);
    const libraryId = Number(result.lastInsertRowid);
    db.prepare(
      "INSERT INTO library_members (library_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
    ).run(libraryId, ownerUserId, now);
    return { id: libraryId, kind: 'personal', name, ownerUserId };
  });
  return create();
}

/** The user's own personal library, or null before `/start` created it. */
export function getPersonalLibrary(db: Database, userId: number): MemberLibrary | null {
  const row = db
    .prepare(
      `SELECT l.id, l.kind, l.name, l.owner_user_id, m.role
       FROM libraries l
       JOIN library_members m ON m.library_id = l.id AND m.user_id = ?
       WHERE l.kind = 'personal' AND l.owner_user_id = ?`,
    )
    .get(userId, userId) as MemberLibraryRow | undefined;
  return row === undefined ? null : toMemberLibrary(row);
}

/** Every library the user is a member of: personal first, then family libraries by id. */
export function listUserLibraries(db: Database, userId: number): MemberLibrary[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.kind, l.name, l.owner_user_id, m.role
       FROM library_members m
       JOIN libraries l ON l.id = m.library_id
       WHERE m.user_id = ?
       ORDER BY (l.kind = 'personal') DESC, l.id`,
    )
    .all(userId) as MemberLibraryRow[];
  return rows.map(toMemberLibrary);
}

/** The library, only if `userId` is a member of it; null otherwise (same as "not found"). */
export function getLibraryForMember(
  db: Database,
  userId: number,
  libraryId: number,
): MemberLibrary | null {
  const row = db
    .prepare(
      `SELECT l.id, l.kind, l.name, l.owner_user_id, m.role
       FROM libraries l
       JOIN library_members m ON m.library_id = l.id
       WHERE l.id = ? AND m.user_id = ?`,
    )
    .get(libraryId, userId) as MemberLibraryRow | undefined;
  return row === undefined ? null : toMemberLibrary(row);
}

/** Whether the user belongs to at least one library (one input of the access gate). */
export function isMemberOfAnyLibrary(db: Database, userId: number): boolean {
  const row = db
    .prepare('SELECT 1 AS present FROM library_members WHERE user_id = ? LIMIT 1')
    .get(userId);
  return row !== undefined;
}
