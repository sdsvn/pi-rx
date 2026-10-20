---
description: "Start the pipeline for an issue, ticket, or ad-hoc task: worktree + test plan + pseudocode design contract (live HTML review). Usage: /rx-start ENG-1234 or gh-123 or #123 (or /task <free text>)"
---

Stage 1 of the pipeline for `$1` — design only, ending at a **human approval gate**. You do NOT
write implementation code. `$1` is the canonical ticket or task id (Linear `ENG-1234`, GitHub `gh-123`,
Jira `PROJ-56`, or ad-hoc `task-<slug>`); `$2` is the free-text requirement/note. State is owned by the
plugin: read/mutate ONLY via the `rx_*` tools; bash is for real work (`git`, `gh`, `openspec`).

Announce: "Starting pipeline for `$1`."

## 0. Guard

`rx_status` with `ticket: $1`. Existing pipeline → **stop**, show it, point at `/rx` or `/task`.

## 1. Requirement

- GitHub issue (`gh-123` / `#123`): fetch with `gh issue view <number>`.
- Linear ticket (`ENG-1234`): fetch with Linear MCP `get_issue` (or Linear CLI if available).
- Jira / GitLab / Generic ticket: fetch via configured issue tool/CLI or ask user if incomplete.
- Ad-hoc (`task-<slug>`): `$2` is the requirement; if thin, confirm scope with the user.
- Anything material beyond what's literally asked (incl. doc-only byproducts) → confirm with the user
  before folding it in.

## 2. Worktree

`rx_ground` (`status: error` → **stop**, never build on unverified main) → `rx_worktree` with
`ticket: $1` → `rx_init` with `branch: details.branch`, `worktree: details.path`. `cd` into the worktree.

## 3. Test plan — present it, invite pushback

Draft the test plan (what, which layer, explicit out-of-scope) and show the user. Record:
`rx_set {test_plan}` + `rx_log event: "test-plan"` with the full plan.

- New public surface (rpc/table/column/error-code) ⇒ name every fail-closed guard test it forces to
  update (frozen-surface list, trigger catalog, absent-tables checks).
- New field plausibly carrying PHI/PII/secrets ⇒ an explicit encrypt-per-repo-standard or
  documented-exception decision, inline in `## Design`.
- YAGNI applies to tests: plan the smallest set where each check fails on a plausible bug — no
  padding suites, no tests for trivial one-liners.

## 4. Pseudocode design — skill://pseudocode-design

The hierarchical tree IS the design contract.

- **Discovery:** call `rx_discovery` with `ticket: $1` FIRST. Delegate the blast-radius scan to ONE
  read-only `scout` subagent so bulk source/graph/bundle content never enters this turn; hand it the
  directive verbatim — `mustUseMap` true ⇒ it MUST use `skill://graphify` (when `graphify-out/`
  exists) and the `okf/` bundle, manual grep confirm-only, no task-shape exceptions; false ⇒
  `rg`/glob. Require a compact digest: `file:line` anchors + one-line notes, no source dumps. Verify
  the anchors against source yourself. Bypassing an existing map ⇒ `rx_deviation`
  (`self`/`ignored-instruction`).
- **Proportionality (fast path):** design effort scales with blast radius, not ceremony. When the
  requirement is small and the touched surface is already evident (roughly: a couple of files, no new
  public surface/schema/migration, no regulated data), run the map query inline yourself instead of
  spawning a scout — the delegation exists to keep bulk content out of this turn, and a tiny query
  has no bulk. Map-first stays binding either way; anchors still get verified. The pseudocode may be
  a short tree: a few `Context` lines, a handful of `Design` bullets, no `Diagrams`. Never pad a
  small design to look thorough — the gate reviews substance, not length.
- Reachability / only-path claims cite the proving `file:line`, verified before the gate.
- **Design the laziest solution that works.** Climb, stop at the first rung that holds: need to
  exist at all (YAGNI)? → existing helper/pattern in THIS repo? → stdlib? → native platform / DB
  constraint over app code? → already-installed dep? → one line? → only then new minimal code. No
  abstraction with one user, no scaffolding "for later", no new dependency the design can avoid.
  Deliberate corner-cut with a known ceiling → name the ceiling + upgrade path as a `## Design`
  bullet. Never simplify away trust-boundary validation, data-loss error handling, or security.
- Write `<details.paths.artifacts_dir>/$1.pseudocode.md` (never inside the repo tree);
  `rx_set {pseudocode}`.
- Structure contract: use ONLY `## Context`, `## Design`, `## Diagrams`, `## Open Questions`.
  `Context`, `Design`, and `Open Questions` are required; `Diagrams` only when it contains a
  ` ```mermaid ` fence. See `pseudocode-structure.md` beside this file.
- Run `rx_pseudocode_check` until ok. Drive every open `?` to resolution with the user.
- This stage overrides the skill's generic storage/review defaults: one artifact only, at the path
  above; no second repo-local copy. Review still happens via the plugin-owned surface — §6 opens it
  with `rx_review_open`.

## 5. OpenSpec deltas

`rx_openspec_ensure` (`installed: false` → skip this section). Derive a kebab change id;
`rx_set {openspec_change}`. Author under `<changesDir>/<CH>/`: `proposal.md`,
`specs/<capability>/spec.md` (ADDED/MODIFIED/REMOVED requirements with WHEN/THEN — only this change's
deltas), optional `design.md`. Then `rx_openspec op: validate, change: <CH>` and fix what it reports.

## 6. Gate — STOP

`rx_transition to: awaiting-approval`, then `rx_review_open ticket: $1` (Co-Review, or the HTML page when
it isn't installed — relay its result line, including any install recommendation). Show `rx_status`.
Tell the user the review is open; approve → `/rx-approve $1`; push back → `/rx-reject $1 "..."`.

Arm the idle nudge with the tool literally named `notify_if_idle` (afterIdleSec 300, wait true,
timeoutSec 1800, message "Approve $1? Reply 'approve' or 'reject <notes>'."). **Never `notify_device`
here** — it blocks synchronously and freezes the gate. Tool absent → skip.

## 7. Self-report

`rx_deviation` (`source: "self"`, kind `guessed|ignored-instruction|scope-miss|other`, with `context`
+ `reasoning`) for anything that went wrong in this stage — or skip if genuinely none. Never
fabricate or soften.

**No implementation code in this stage. End your turn.**
