---
name: work-ticket
description: Pick up the next open ticket (or one the user names), implement it with the senior-developer agent, then verify it with the senior-tester agent, retrying on failure. Use when asked to "pick up the next ticket", "work on ticket X", or "implement and verify" something from the plan.
---

# Work Ticket

Take one ticket through implementation and independent verification, end to end, without the user having to call each agent by hand.

## Steps

1. **Identify the ticket.** If the user named one, use it. Otherwise open the plan that `AGENTS.md` points to and take the first open item (e.g. the first unchecked `- [ ]` in the first unfinished phase). If it depends on something the plan lists as an open question, ask the user before starting.

2. **Implement.** Call the `Agent` tool with `subagent_type: "senior-developer"` in the foreground, since the next step depends on its result. Give it the exact ticket text and phase. Wait for its report: branch, commit hash, files changed, tests run.

   If it reports it couldn't proceed (an open question, a missing decision), stop and pass that on to the user. Don't guess on its behalf.

3. **Verify.** Call `Agent` with `subagent_type: "senior-tester"` in the foreground. Pass it the same ticket, the branch and commit from step 2, and the developer's full report. Tell it to check the diff itself rather than trust the summary. Wait for its PASS / FAIL / BLOCKED verdict.

4. **On FAIL:** call `senior-developer` again on the same branch. Give it the ticket plus the tester's "Next step" list word for word as the task. Then run `senior-tester` again on the new commit. Repeat at most **twice** (three attempts in total). If it still isn't PASS, stop and give the user the tester's latest full report. Don't keep looping silently.

5. **On BLOCKED:** stop and report what blocked the tester (missing tooling, an environment problem). Don't fix the blocker yourself unless the user asks.

6. **On PASS:**
   - Tick the ticket's checkbox in the plan (`- [ ]` → `- [x]`). This is the only plan edit you make. If it was the last item in its phase, list the phase's "Done when" conditions and note which ones the tester marked "not verified here" (those need the user to check manually).
   - Report the result and ask the user whether to:
     - add a changelog entry (`changelog-update` skill), and/or
     - open a PR (`create-pr` skill).

     Don't run either one automatically.

## Rules

- Never skip step 3. A developer report alone is not verification.
- Tick a checkbox only after a PASS, never before.
- If the user interrupts between attempts, stop looping and wait for them.
- Report plainly after every attempt: ticket, branch, commit, verdict, and (on FAIL) what's left to fix. Don't bury a failed attempt inside a success-sounding summary.
