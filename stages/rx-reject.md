---
description: "Record an objection at the approval gate and revise the design/test plan. Usage: /rx-reject ENG-1234 \"your objection\""
---

The human is pushing back at the approval gate for `$1`; objection: `$2`. Record it and revise —
never proceed to code from here. State via `rx_*` tools.

## 1. Gate + record

`rx_status` with `ticket: $1` — phase must be `awaiting-approval`, else **stop**. `$2` empty →
**stop**: usage `/rx-reject $1 "your objection"`.

- `rx_log event: "reject", note: $2`; `cd` into `details.state.worktree`.
- Ground-truth evidence: `rx_deviation` (`auto`/`rejected`, `note: $2`, `context:` the rejected
  design decision, `reasoning:` the human's stated reason + why you think you got it wrong).
- Objection about the PROCESS (a standing rule, not this design) → also `rx_decision` with
  `ticket: $1, note: $2`.

## 2. Revise

Fold the objection into the pseudocode tree (`details.state.pseudocode`) and/or the test plan. If the
Co-Review captured feedback, read `details.review` (`summary`, `verdict`, `openComments[]`) and
address each. Co-Review re-reads the doc on change; if the review was closed, the user re-runs `/rx-review $1`.

Stay in `awaiting-approval`. End by asking the user to re-review, then `/rx-approve $1` or
`/rx-reject $1 "..."`.
