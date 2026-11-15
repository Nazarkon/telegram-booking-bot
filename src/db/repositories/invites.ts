import type { Database } from 'better-sqlite3';

import { nowIso } from '../time.js';

/**
 * Read side of invites. Creating, accepting and revoking are owned by the invite service.
 *
 * "Pending" is defined once here, identically to the family-limit triggers in 001_init.sql:
 * not accepted, not revoked, and `expires_at` strictly in the future.
 */
const PENDING_INVITE = 'accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?';

export interface PendingLinkInvite {
  readonly id: number;
  readonly libraryId: number;
  readonly createdBy: number;
  readonly expiresAt: string;
}

/**
 * Whether a pending username invite matches the user's CURRENT Telegram username. Usernames are
 * stored lowercased and Telegram usernames are case-insensitive, so the match is too. A user
 * without a username never matches.
 */
export function hasPendingUsernameInvite(db: Database, username: string | null): boolean {
  if (username === null || username === '') return false;
  const row = db
    .prepare(`SELECT 1 AS present FROM invites WHERE username = ? AND ${PENDING_INVITE} LIMIT 1`)
    .get(username.toLowerCase(), nowIso());
  return row !== undefined;
}

/** The pending link invite with this token hash (sha-256 hex), or null if none is pending. */
export function findPendingLinkInvite(db: Database, tokenHash: string): PendingLinkInvite | null {
  const row = db
    .prepare(
      `SELECT id, library_id, created_by, expires_at FROM invites
       WHERE token_hash = ? AND ${PENDING_INVITE}`,
    )
    .get(tokenHash, nowIso()) as
    { id: number; library_id: number; created_by: number; expires_at: string } | undefined;
  if (row === undefined) return null;
  return {
    id: row.id,
    libraryId: row.library_id,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
  };
}
