/**
 * Current time in the one format every `*_at` column accepts: ISO-8601 UTC, millisecond
 * precision, trailing "Z" (see the header of migrations/001_init.sql; the schema CHECKs it).
 * Every repository writes timestamps through this function and never formats its own.
 */
export function nowIso(): string {
  return new Date().toISOString();
}
