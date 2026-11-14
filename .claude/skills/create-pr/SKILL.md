---
name: create-pr
description: Open a pull request for the current branch using this repo's PR templates (feature or bug fix). Use when the user asks to create/open a PR, "ship this", or "push and make a PR".
---
# Create PR

Hand this to the `pr-creator` agent via the `Agent` tool (`subagent_type: "pr-creator"`), in the foreground, since the user is waiting on the result. Don't run the PR steps yourself. `pr-creator` owns that procedure.

## Before delegating

`pr-creator` only handles mechanics. It stops rather than deciding anything. Sort these out first, with the user if needed:

- **Branch**: if the current branch is `main`, or there's nothing committed, sort that out first.
- **Uncommitted changes**: decide with the user whether they belong in this PR, and commit them if so.
- **Template**: if it's unclear whether this is a feature or a bug fix, ask.

## What to pass it

- the branch and the ticket this PR is for
- whether the user wants a draft
- the `senior-tester` verdict, if this ticket went through `work-ticket`
- anything else about scope you already know, so it doesn't have to work it out again

## After

Pass its report on to the user. If it returned a PR URL, give that exact URL. Never make one up. If it stopped (failing checks, uncommitted changes, an unclear template), explain why and what's needed. Don't work around it silently.
