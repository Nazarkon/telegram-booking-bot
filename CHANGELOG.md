# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]
### Added
- Project tooling on Node 24: strict TypeScript, `tsx` dev runner, ESLint
  (typescript-eslint strict, type-aware) with Prettier, and Vitest.
- Startup config validated with zod: `BOT_TOKEN`, `ALLOWED_USER_IDS`, `DB_PATH`,
  `COVERS_DIR`, `LOG_LEVEL`. The bot refuses to start on a malformed token, an
  empty or invalid allowlist, or an unknown log level. `.env.example` lists every
  variable with placeholder values.
- Pino logger factory and `src/i18n/uk.ts`, the single home for Ukrainian bot
  text (seeded with «Доступ заборонено» and the main keyboard labels).
- SQLite database layer (`better-sqlite3`): `openDatabase` creates the data
  directory, sets WAL, `foreign_keys`, `recursive_triggers` and a 5 s busy
  timeout, and runs numbered `.sql` migrations tracked by `user_version`, each
  in one transaction. Refuses a database newer than the code.
- Initial schema (`001_init.sql`): users, personal/family libraries, members,
  invites, genres (several per book), books with a Bin `deleted_at`, per-user
  `book_reads` and a global ISBN cache. Timestamps are ISO-8601 UTC and checked
  by the schema.
- `books_fts` full-text index on title and authors, kept in sync by triggers;
  case-insensitive Cyrillic prefix search («гарр» finds «Гаррі Поттер»).

### Security
- The database itself enforces library limits: one personal library per user,
  and a family library can't exceed 5 members + pending invites (expired,
  revoked and accepted invites don't count). Genres can only be linked to books
  of the same library.
- Config errors name the bad variable but never echo its value, and the logger
  redacts `token` / `botToken` / `BOT_TOKEN` fields, so the bot token can't leak
  through a startup error or a structured log field. Tokens embedded inside
  error message text are not scrubbed yet; that lands with the error handler.
- `.gitignore` keeps `.env`, `*.db` (and WAL/SHM files), `/data` and
  `nimbalyst-local/Library.xlsx` out of git; `.env.example` stays tracked.
