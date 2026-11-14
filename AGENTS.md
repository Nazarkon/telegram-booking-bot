# AGENTS.md

Rules for any AI agent (or human) working in this repo. The full spec lives in
`nimbalyst-local/plans/telegram-book-library-bot.md`. Read it before starting a
phase. This file is the short checklist of things that are easy to get wrong or
to skip without noticing.

## Stack

- TypeScript on Node 24. Bot framework: **grammY** + `@grammyjs/conversations` +
  `@grammyjs/ratelimiter`.
- DB: **SQLite** via `better-sqlite3`, plain `.sql` migrations run through the
  `user_version` pragma (no ORM).
- Excel import: `exceljs`. Validation: `zod`. Tests: `vitest`. Logs: `pino`.
  Images: `sharp`.
- Hosting: **Fly.io** (one machine, volume mounted at `/data`), long polling.
- All bot-facing text is **Ukrainian** and lives in `src/i18n/uk.ts`. Never
  hardcode user-facing strings anywhere else.

## Non-negotiable rules

These rules are part of correctness. Reviewers check every diff against them.

### Access (allowlist + invites, not an open bot)

- A user may use the bot only if they are in `ALLOWED_USER_IDS`, are a member
  of at least one library, or have a pending, unexpired invite. This check runs
  as middleware **before** every handler, including invite handling.
- Everyone else gets the single «Доступ заборонено» reply (rate-limited) and
  nothing else.
- Only allowlisted users can create **family** libraries. Invited members can
  join and can create a personal library.

### Library isolation (personal and family libraries)

- Books, genres, reads and the Bin belong to a **library**, not a user. Every
  repository method that touches them takes `libraryId` as a required
  parameter, and every query filters on `library_id`.
- Every handler and callback that acts on library data calls
  `assertMember(userId, libraryId)` with `ctx.from.id` first. Never trust a
  `bookId` or `libraryId` from callback data on its own.
- Read status is per user: `book_reads` is keyed by `(user_id, book_id)`. A row
  means «Прочитано», no row means «Не прочитано». One member's status never
  changes another's.
- Books in the 🗑 Bin (`deleted_at IS NOT NULL`) are excluded through **one
  shared repository helper**, never a hand-written filter. Only the Bin's own
  queries see them.
- Family libraries: members + pending invites ≤ 5, enforced in code **and** by a
  DB trigger. Limits per user: 1 personal and up to 3 family libraries.
- Isolation tests must exist and pass: a non-member can't see, find or change
  another library's books, genres, reads or Bin, and one member's read status
  doesn't affect another's.

### Input & external calls

- Search text is capped at about 100 characters, and FTS query syntax is escaped
  before it reaches `MATCH`. Search uses FTS5, never `LIKE '%…%'`, because
  SQLite's `LIKE` only ignores case for ASCII, not Cyrillic.
- The ISBN checksum is validated **before** any network call.
- Open Library / Google Books: 5-second timeout, responses validated with `zod`,
  failures degrade to manual entry. A lookup must never crash a handler.
- Outbound ISBN lookups have their own rate limit, separate from the per-user
  bot rate limit.
- Cover downloads: only from Open Library / Google Books hosts, 5-second
  timeout, ≤ 5 MB, must decode as a real image (reject "no cover" stand-ins),
  resized with `sharp`. Any failure falls back to the placeholder and never
  fails the handler.
- Invite link tokens: ≥ 16 random bytes, single-use, expiring, compared in
  constant time. Username invites match the **current** username and are
  re-checked on accept.
- SQL is parameterized only. No string interpolation into queries.
- Callback data stays under Telegram's 64-byte limit.

### Secrets & data

- The bot token and IDs live only in `.env` locally and in **Fly secrets** in
  production. Commit `.env.example`, never `.env`. Nothing secret goes in
  `fly.toml`.
- Never commit or force-add `nimbalyst-local/Library.xlsx` (it has prices and
  purchase info), any `*.db` file, or `/data` (DB and covers). Keep them out of
  the Docker image via `.dockerignore`.

### Runtime

- SQLite pragmas: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`.
- Global error handler (`bot.catch`) with structured `pino` logs. Never swallow
  errors silently.
- Multi-step writes run in one transaction: import upserts, book + FTS updates,
  creating a library + memberships + invites, accepting an invite, leaving a
  library.
- Exactly **one** bot process polls Telegram (Fly: `fly scale count 1`). Two
  pollers conflict, and SQLite needs a single writer.
- Shutdown handles both `SIGINT` (Fly's default) and `SIGTERM`: stop polling,
  finish the current update, close the DB.

## Scope

- Build only what the current phase in the plan asks for. The plan's "Later"
  list is not a backlog to build ahead of time.
- Settled product decisions are in the plan's "Resolved decisions" table, and
  open ones are under "Open questions". Follow the first and ask about the
  second; don't guess. If the plan and this file disagree, stop and ask.

## Workflow

- Repo workflows live in `.claude/skills/` and `.claude/agents/`. Use them
  instead of improvising the same steps.
- A ticket is not done until an independent `senior-tester` run returns
  **PASS**. Only then is its checkbox ticked in the plan.
- Never commit directly on `main`. Stage files by name, not with `git add .`.
