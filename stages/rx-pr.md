---
description: "Push the branch, open a PR from the repo template, and start the Herdr PR watcher. Usage: /rx-pr ENG-1234"
---

Stage 3 for `$1`: open the PR and arm the autonomous Herdr watcher. State via the `rx_*` tools only;
bash for real work (git, `gh`); OpenSpec only via `rx_openspec` (it adds `--store`).

## 1. Gate

`rx_status` with `ticket: $1` — phase must be `implemented`, else **stop**. `cd` into
`details.state.worktree`.

**Rework round** (`pr_number` set, or `self_delivered` true): skip §2 — call `rx_pr` with a one-line
`comment` summarizing the change (it pushes + comments / self-hosted re-merges, returns to
`pr-open`), `rx_log event: "pr-update"`, then go to §3.

## 2. PR body + open

1. `read` `$RX_PLUGIN/workflow/pr-description-style.md` (a failed read → **stop**; never improvise a
   body) and `<repo_root>/.github/pull_request_template.md` (absent → use the style doc's skeleton headings).
2. Reproduce the template's headings verbatim (emoji, order). Never rename, merge, or invent a
   heading; `(optional)` sections omitted only when empty; extra material (seed, curl, logs) goes
   inside the relevant section.
3. Content per the style doc: `## 🔖 Title` = `$1: concise description` (also the `rx_pr` title);
   Test Plan = the real verification run (recorded `test_plan` + §3 of `/rx-approve`), never the CI
   baseline; Additional Context summarizes the OpenSpec deltas (`rx_openspec op: show`) when a change
   exists. Terse — median body ~200 chars.
4. Immediately before opening: re-check race-prone anchors (migration numbers etc.) against current
   `origin/main` AND every open PR branch — siblings merge in the gap; renumber before pushing.
5. Call `rx_pr` with `ticket: $1`, `title`, `body`. Self-hosted (no `origin`) is auto-detected: it
   merges into local `main` and marks `self_delivered` instead of opening a PR.

## 3. Watcher

`rx_watch_start` with `ticket: $1` — idempotent (reuses a live watcher, heals a dead one);
Herdr-only, a reported no-op elsewhere. Once armed, this session is **hands-off the PR**: new
comments/CI/conflicts belong to the watcher or `/rx-rework` — intervene directly only on the user's
explicit ask, and say you're overriding.

## 4. Report

Show `rx_status`. Tell the user: PR `#<PR>` open, watcher running (pings via `notify_device` only on
a genuine decision); after merge run `/rx-cleanup $1`.
