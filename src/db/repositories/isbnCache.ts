import type { Database } from 'better-sqlite3';

import { nowIso } from '../time.js';

/**
 * Cache of public ISBN metadata. It is global by design (not library data), so unlike every
 * other repository it takes no `libraryId`.
 */
export interface CachedIsbn {
  readonly isbn13: string;
  readonly payloadJson: string;
  readonly provider: string;
  readonly fetchedAt: string;
}

export function getCachedIsbn(db: Database, isbn13: string): CachedIsbn | null {
  const row = db
    .prepare('SELECT isbn13, payload_json, provider, fetched_at FROM isbn_cache WHERE isbn13 = ?')
    .get(isbn13) as
    { isbn13: string; payload_json: string; provider: string; fetched_at: string } | undefined;
  if (row === undefined) return null;
  return {
    isbn13: row.isbn13,
    payloadJson: row.payload_json,
    provider: row.provider,
    fetchedAt: row.fetched_at,
  };
}

/** Stores or replaces the cached payload for an ISBN and stamps it with the current time. */
export function putCachedIsbn(
  db: Database,
  entry: { isbn13: string; payloadJson: string; provider: string },
): void {
  db.prepare(
    `INSERT INTO isbn_cache (isbn13, payload_json, provider, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (isbn13) DO UPDATE SET
       payload_json = excluded.payload_json,
       provider = excluded.provider,
       fetched_at = excluded.fetched_at`,
  ).run(entry.isbn13, entry.payloadJson, entry.provider, nowIso());
}
