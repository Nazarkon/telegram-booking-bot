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
- Data-access repositories for users, libraries, invites (pending lookups),
  books, the Bin (list, restore, permanent delete), genres (several per book,
  «Фентезі»/«фентезі» treated as one), per-user read status and the ISBN cache.
  Creating a personal library adds its owner membership in the same transaction.
- Bot runtime on grammY with long polling: per-user rate limit (5 updates per
  3 s, extra updates dropped), user records saved for allowed users, a global
  error handler with structured logs, and clean shutdown on SIGINT and SIGTERM
  (stop polling, finish the current update, close the database, exit once).

### Security
- Access gate before every handler: only allowlisted users, library members,
  users with a pending username invite matching their current username, or a
  valid `/start inv_<token>` link get through. Tokens are format-checked before
  any lookup and compared by SHA-256 hash in constant time. Everyone else gets
  a single «Доступ заборонено» (at most once per 10 minutes), identical for
  every reason, and nothing about them is stored.
- The bot token is now scrubbed from all log output, including inside error
  messages, stacks and Telegram API URLs.
- Library isolation in the data layer: every book, genre, read-status and Bin
  query requires a `libraryId` and filters on it, so an id from another library
  returns nothing and changes nothing. Binned books are excluded through one
  shared helper (a test forbids hand-written filters). `assertMember` rejects
  non-members, and one member's read status never touches another's.
- The database itself enforces library limits: one personal library per user,
  and a family library can't exceed 5 members + pending invites (expired,
  revoked and accepted invites don't count). Genres can only be linked to books
  of the same library.
- Config errors name the bad variable but never echo its value, and the logger
  redacts `token` / `botToken` / `BOT_TOKEN` fields, so the bot token can't leak
  through a startup error or a structured log field.
- `.gitignore` keeps `.env`, `*.db` (and WAL/SHM files), `/data` and
  `nimbalyst-local/Library.xlsx` out of git; `.env.example` stays tracked.
