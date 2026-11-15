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

### Security
- Config errors name the bad variable but never echo its value, and the logger
  redacts `token` / `botToken` / `BOT_TOKEN` fields, so the bot token can't leak
  through a startup error or a structured log field. Tokens embedded inside
  error message text are not scrubbed yet; that lands with the error handler.
- `.gitignore` keeps `.env`, `*.db` (and WAL/SHM files), `/data` and
  `nimbalyst-local/Library.xlsx` out of git; `.env.example` stays tracked.
