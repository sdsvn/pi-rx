---
description: "Approve the pseudocode gate and implement the code from the approved pseudocode contract. Usage: /rx-approve ENG-1234"
---

Stage 2 for `$1`: the human approved the gate — now implement. State via the `rx_*` tools only; bash
is for real work (git, builds, tests).

## 1. Gate

`rx_status` with `ticket: $1` — phase must be `awaiting-approval` (already `approved` → resume at
§3), else **stop**. Read `details.state.worktree` and `details.state.pseudocode`. `cd` into the
worktree and, **in the same bash call**, verify `pwd && git rev-parse --show-toplevel` both equal it.
File tools ignore `cd`: prefix EVERY file-tool path with `.worktrees/$1/` or the absolute worktree
path for the whole stage.

## 2. Record approval

`details.review.verdict` = `request-changes` → **stop** ("run /rx-reject to fold in feedback").
Otherwise `rx_transition to: approved` + `rx_log event: "approve"` (include the verdict if present).

## 3. Implement

Resumed here from `approved`? Re-run the §1 cwd check first — it does not carry over between turns.

- Re-ground: `rx_ground`. `error` → **stop** (no unverifiable main). `behind`/`diverged` → reconcile
  (ff-only / rebase), then re-verify reserved anchors (migration numbers) AND any sibling-merged
  surface the design didn't anticipate.
- Implement end-to-end against the approved pseudocode tree + this ticket's OpenSpec deltas. Never
  use a PRP / `PRPs/` artifact or any PRP-implementation workflow here. A forced material design
  change → stop, update the tree, re-confirm with the user.
- **Shortest working diff, in the right place.** Before writing: existing helper in this repo →
  stdlib → native platform / DB constraint → already-installed dep → one line → minimal new code.
  Never add a dependency for what a few lines do; no interface with one implementation; boring over
  clever; deletion over addition. Small-diff-in-the-wrong-place is a second bug — trace the flow
  first, then be lazy.
- Bug-shaped work fixes the **root cause where all callers route through**, not the reported path —
  check every caller of the function you touch; one shared guard beats per-caller patches.
- Deliberate corner-cut with a known ceiling → `ponytail:` comment naming the ceiling + upgrade path
  (e.g. `# ponytail: global lock, per-account locks if throughput matters`). Never simplify away
  trust-boundary validation, data-loss error handling, security, or anything the approved design
  explicitly requires.
- Unfamiliar code → `rx_discovery` and obey its directive (graphify/okf when `mustUseMap`; bypassing
  a map ⇒ `rx_deviation`).
- Full verify loop with the repo's own targets: codegen → format → build → lint → test. Never finish
  red.
- Codegen footprint: diff generated files vs `origin/main`; restore all except those carrying your
  change. Never hand-edit a generated file.
- Newly generated tracing/logging wrappers must not log PHI/PII/secrets — check and exclude before
  finishing.
- Env-blocked verification (disk full, Docker down): verify the changed service with what works and
  name the deferred checks in the PR Test Plan — that documented fallback is sanctioned; skipping a
  check WITHOUT naming the deferral is a deviation.

## 4. Done

`rx_transition to: implemented`; show `rx_status`. Implementation diverged from the approved tree →
`rx_deviation` (`auto`/`contract-drift`, tree-said-X vs code-required-Y, with reasoning). Then the
same self-report pass as `/rx-start` §7. Tell the user: run `/rx-pr $1`.
