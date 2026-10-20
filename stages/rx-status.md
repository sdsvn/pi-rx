---
description: "Show the Rx pipeline state for a ticket (or list all). Usage: /rx-status [ENG-1234]"
---

Read-only. State via the `rx_status` tool.

- `$1` given: `rx_status ticket: $1` — no pipeline → say so, stop. Otherwise show
  `details.state` (phase, branch, worktree, test_plan, pseudocode, openspec_change, pr_number,
  herdr_watch_tab), `details.review` when present, then the audit log (`details.state.log`).
- `$1` empty: `rx_status` with no ticket — list every pipeline (phase, PR, last-updated) or say
  `no pipelines yet`.

End with the next command per phase: `started` → finish `/rx-start`; `awaiting-approval` →
`/rx-approve` / `/rx-reject`; `approved` → re-run `/rx-approve` (resumes at §3); `implemented` →
`/rx-pr`; `pr-open` → watcher runs, trivial → fix & push, substantive → `/rx-rework $1 "summary"`,
merged → `/rx-cleanup`; `cleaned`/`aborted` → done.
