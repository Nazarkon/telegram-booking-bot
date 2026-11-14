---
name: code-standards
description: "Coding standards for this repo: TypeScript on Node.js with grammY (Telegram) handlers, SQLite (better-sqlite3) repositories, zod validation, Excel import, and vitest tests. Use when writing, reviewing, or refactoring code in this repo."
---

# Code Standards

How code in this repo is written. The project's hard rules (access, data scoping, input handling, secrets) are in `AGENTS.md`. If anything here conflicts with `AGENTS.md`, **`AGENTS.md` wins**.

Read [the detailed reference](references/detailed-reference.md) for examples. For a quick check, this list is enough:

## Checklist

- **Layers**: handlers only parse input, call a service, and render a reply. Business rules go in `services/`. SQL goes only in `db/repositories/`.
- **Scoping**: mandatory filters and authorization checks live in repository/service helpers with required parameters, never re-typed in handlers. The project's actual scoping rules are in `AGENTS.md`.
- **Text**: all user-facing strings come from the single strings module named in `AGENTS.md`.
- **SQL**: parameterized statements only; select only the columns you need; use transactions for multi-step writes; use FTS5 for search, never `LIKE '%…%'`.
- **External calls**: 5-second timeout, `zod`-validated response, return `null` on failure so the caller can fall back.
- **Types**: no `any`; use `unknown` and narrow it. Use `as` only at the DB boundary, after a check.
- **Errors**: typed errors for expected failures; let unexpected ones reach `bot.catch`; never use an empty `catch`.
- **Naming**: functions are verb + noun; files are `camelCase.ts`; constants get names, no magic numbers.
- **Tests**: vitest, Arrange/Act/Assert, named by behavior. Tests must fail if the behavior breaks.
- **Scope**: build only what the current phase asks for.
