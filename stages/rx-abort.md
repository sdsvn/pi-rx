---
description: "Early abort: abandon a ticket at ANY phase and tear its runtime down. Usage: /rx-abort ENG-1234 [reason]"
---

Abandon `$1` before merge: tear down worktree, branch, watcher, artifacts → terminal `aborted`.
Merged PR → wrong command, use `/rx-cleanup`. `$2` is the reason. State via `rx_*` tools.

## 1. Refuse the wrong cases

`rx_status` with `ticket: $1` — no pipeline → **stop**. Phase already `cleaned`/`aborted` → **stop**,
terminal. `pr_number` set → `rx_pr_state`: `merged` true (or `self_delivered`) → **stop**, point at
`/rx-cleanup`.

## 2. Confirm — destructive

Tell the user exactly what is removed (worktree + branch local/remote — deleting an open PR's remote
branch closes it; watcher tab; disposable artifacts) and that uncommitted/unpushed work is lost. Get
explicit confirmation; if `$2` is empty, ask for a one-line reason. Declined → **stop**, change
nothing.

## 3. Close an open PR

Only if `pr_number` set and not merged:
`gh pr close <pr_number> --comment "Abandoned via /rx-abort: <reason>"` — best-effort; on failure
continue (teardown's branch delete closes it anyway).

## 4. Tear down + close the record

`rx_teardown` with `ticket: $1` (idempotent: watcher, worktree, branches, artifacts; state file stays
as audit record; an OpenSpec draft stays unarchived). Then `rx_transition to: aborted, note:` the
reason, `rx_log event: "abort"` with what was removed, and show `rx_status`.

Report: pipeline `$1` aborted at `<phase>`, runtime torn down.
