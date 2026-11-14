---
name: changelog-update
description: Add an entry to this repo's CHANGELOG.md after a ticket, phase, or PR lands. Use when asked to update the changelog, write release notes, or record what shipped.
---
# Changelog Updates

Keep `CHANGELOG.md` at the repo root as a short, honest record of what shipped — for your own future reference, not marketing copy. There is no SDK, public API, or release schedule to communicate here.

Read [the detailed reference](references/detailed-reference.md) for format and examples. For a quick entry, the format below is enough.

## When to use

- After a ticket gets a `senior-tester` PASS (via `work-ticket`), or a phase of the plan `AGENTS.md` points to is finished.
- Before or after `create-pr` opens a PR, if the user wants the entry as part of that change.
- When the user asks to "update the changelog" or "write release notes."

## Format

```markdown
## [Unreleased]
### Added
- Short, specific description of the user-visible or developer-visible change. (#PR-number if there is one)

### Fixed
- What was broken and what now happens instead. (#issue or #PR)

### Security
- Access-control or data-handling changes. Always include these, even briefly.
```

Only use the categories that apply: `Added`, `Changed`, `Fixed`, `Security`. Skip `Deprecated` and `Removed` — nothing here has external consumers to deprecate for.

## Rules

- One line per change, specific enough that future-you understands it without the diff open. "Fixed bug" or "various improvements" is not an entry.
- Skip internal refactors, dependency bumps, and typo fixes unless they're security-relevant or actually affect behavior.
- Write it from the real diff or commit, not from the ticket title. If you haven't seen the diff, read it first.
- No placeholder links, fake issue numbers, or invented metrics. If there's no issue/PR number, omit the reference rather than making one up.
- This records what shipped. It does not announce a release or send anything.

## Limitations

- Don't invent a version number scheme (semver, etc.) unless the user asks for one. A single-deployment app doesn't need one.
- Don't draft external-facing communication (email, Twitter, Discord) — unless the project actually has such a channel.
- If asked for something this skill doesn't cover (e.g. a real public release process), say so rather than forcing the template to fit.
