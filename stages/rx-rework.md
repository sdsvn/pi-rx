---
description: "PR review requires real work: loop back to the design gate. Usage: /rx-rework ENG-1234 \"what the comments ask for\""
---

The open PR for `$1` needs more than a trivial push: loop back to the approval gate (plan → approve →
`/rx-pr` pushes to the SAME PR). Trivial fixes the reviewer spelled out do NOT need this — commit,
push, reply. State via `rx_*` tools.

## 1. Gate

`rx_status` with `ticket: $1` — phase must be `pr-open`, else **stop**. `$2` empty → **stop**:
`rx: describe the rework: /rx-rework $1 "summary"`.

Then: `rx_transition to: awaiting-approval, note: $2` (PR stays open), `rx_log event: "rework"`, and
log the evidence — `rx_deviation` (`auto`/`reworked`, `note: $2`, `context:` what the PR shipped that
drew the pushback, `reasoning:` why the original design/impl missed it).

## 2. Fold the comments into the design

Work in `details.state.worktree`. Re-read the PR comments (`gh pr view <pr_number> --comments`) plus
`$2`. Unfamiliar code → re-ground via the repo's maps first (`okf/`, `skill://graphify`). Update the
canonical artifacts the comments touch:
- the pseudocode tree (`details.state.pseudocode`) and/or test plan; optionally drop a `*.diff` in
  the artifacts dir.
- requirement changes with an OpenSpec change → update its deltas, then `rx_openspec op: validate`.
- a standing process objection → `rx_decision`.

## 3. Back to the gate

Call `rx_review_open ticket: $1` to open the re-review on the updated design (relay its result line),
then present the updated design and STOP. Human re-reviews: `/rx-approve $1` → implement → `/rx-pr $1`
pushes to the existing PR; `/rx-reject $1 "..."` works as usual.
