---
description: "After merge, stop the watcher and remove the worktree + branch. Usage: /rx-cleanup ENG-1234"
---

Stage 5 for `$1`: the PR is merged — tear down. Refuse unless actually merged. State via `rx_*` tools.

## 1. Verify merged

`rx_status` with `ticket: $1` — no pipeline → **stop**. No `pr_number` and not `self_delivered` →
never opened a PR: confirm the user is abandoning, then skip to §3; otherwise **stop**. Else
`rx_pr_state`: `merged` not true → **stop** (work may be unsaved).

## 2. Archive the OpenSpec change

`details.state.openspec_change` set → `rx_openspec op: archive, change: <CH>` (folds deltas into the
baseline; skips cleanly without the CLI; pass `skipSpecs: true` if it only MODIFIES a not-yet-existing
baseline). Empty → skip.

## 3. Tear down + close the record

`rx_teardown` with `ticket: $1` (watcher, worktree, branches, artifacts; state file stays as audit
record). Then `rx_transition to: cleaned, note: "PR #<pr_number> merged; torn down"` (self-hosted:
`"self-hosted merge to local main; torn down"`), `rx_log event: "cleanup"`, and show `rx_status`.

Report: pipeline `$1` complete — merged, cleaned, watcher stopped.
