# Changelog Updates — Detailed Reference

> For an internal app with no SDK, public API, external developer audience, or release-communication channel. The parts of the general "changelog marketing" playbook that assume one have been removed. What's left is how to write a clear internal `CHANGELOG.md` entry. The examples below use a neutral domain (orders, invoices) on purpose.

## Who reads this changelog

Mainly you, the maintainer. Its job is: "what changed, and why does it matter," so that six months from now you can tell what shipped in which phase without re-reading every commit. It is not marketing copy and does not need to build excitement.

## Format

```markdown
# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]
### Added
- Export an order as PDF from the order page; falls back to a plain-text receipt if rendering fails.

### Fixed
- Order list no longer shows cancelled orders under "Active".

### Security
- Order actions now check that the caller may access the order; previously a forged request could cancel someone else's order.

## [Phase 1] - 2026-01-20
### Added
- Migration runner and initial schema.
- Owner-scoped repositories and the sign-in flow.
```

Group entries under `[Unreleased]` as they land; move them under a dated heading (a phase name and date, or a deploy date) when you actually ship that state to production.

### Categories

Use only what applies. For this project that's almost always:

| Category | Use for |
| --- | --- |
| **Added** | A new handler, flow, or field a user or you would notice. |
| **Changed** | A behavior change to something that already existed. |
| **Fixed** | A bug fix. |
| **Security** | Anything touching access control, data scoping, input handling, secrets, or what data is stored — always include these, even a one-liner. |

Skip **Deprecated** and **Removed** — there's no external consumer to warn before you change something. If a field or flow is dropped, a line under `Changed` or `Fixed` is enough.

### Good vs. bad entries

```markdown
✅ Fixed timeout when fetching exchange rates on a slow connection; the request
   now retries once before falling back to the cached rate. (#42)

✅ Security: search input is now escaped and capped at 100 characters, so
   crafted queries can't break the search syntax.

❌ Fixed bug.
❌ Various improvements.
❌ Updated dependencies.
```

Be specific enough that you don't need the diff open to know what changed. Include the issue/PR number only if one actually exists — don't invent one.

### What to include

- Anything a user would notice: a new menu item, a changed flow, a fixed annoyance.
- Any change to access control, data scoping, input handling, or what data is stored or shown (the `Security` category).
- A phase or ticket completing, if it shipped real behavior.

### What to skip

- Internal refactors with no behavior change.
- Dependency bumps, unless they fix a security issue.
- Typo fixes to user-facing strings — batch several into one line if they add up, otherwise skip.
- Anything from the plan's "Phases" checklist that hasn't actually been merged yet.

## Workflow

1. Read the actual diff or commit(s) for the ticket/phase, not just its title.
2. Pick the category (`Added`/`Changed`/`Fixed`/`Security`); use more than one if the change genuinely spans them.
3. Write one line per distinct change, in the format above, under `[Unreleased]`.
4. If this is the last ticket in a phase, you may also move the relevant `[Unreleased]` lines under a new phase heading with today's date — only do this when the phase's "Done when" criteria in the plan are actually met.
5. Don't touch anything else in the file.

## Evidence limits

Write entries from the diff and the plan's own "Done when" criteria, not from what a ticket was supposed to do. If you haven't verified a change works (see `senior-tester`), say so in the PR/ticket discussion rather than writing it into the changelog as if it's confirmed.
