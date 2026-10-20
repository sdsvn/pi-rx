# Rx — living workflow summary & improvement log

The one-screen map of the Rx workflow, the invariants that must not break, and the **open
improvement backlog**. Closed backlog items and the **learnings log** live in
[`HISTORY.md`](./HISTORY.md) — read it when an item touches an area with past fixes. Purpose: let a human *and* the LLM iterate on the workflow over
time without re-deriving it each session.

## How to use this file (the iterate protocol)

- **Read this first** before changing anything about Rx (the `pi-rx` plugin — its `stages/`, `src/index.ts`, and bundled `workflow/` docs — or the
  skills it leans on). It's the fastest orientation and it lists what's deliberately load-bearing.
- **When you change the workflow**: update the Summary if structure changed, append new items to
  the **open Backlog** here, and when you close one, **move it** (ticked, with its fix) to
  [`HISTORY.md`](./HISTORY.md) and add one dated line to HISTORY's **Learnings log**. Keep this file
  to orientation + what's next; HISTORY holds the closed post-mortems. Git holds the diff.
- **To improve it deliberately**: run `/rx-improve` (or `/rx-improve <topic>`). It reads this file,
  picks the highest-value backlog item (or your topic), implements it *within the invariants*,
  verifies (tsc / `demo()` / `bash -n`), and logs a learnings entry.
- **Invariants are a contract**: don't violate the ones below to close a backlog item. If an item
  genuinely requires breaking one, that's a decision to raise explicitly, not do silently.

### The evidence loop (where improvements come from)

The backlog isn't only hand-curated — it's fed by **real run failures**:

- Every run logs **deviations** to `~/.claude/workflow/deviations/<repo-key>.jsonl` (out of the repo).
  Each entry has `source`, `kind`, `note`, **`context`**, and **`reasoning`** — the *why*, not just the
  what. Two sources:
  - **`auto`** (reliable ground truth): human corrections — `/rx-reject`, `/rx-rework`, `/rx-review`
    Request-changes, and implementation `contract-drift` — logged automatically.
  - **`self`** (best-effort): each substantive command's close asks the agent to honestly log where it
    guessed, ignored an explicit instruction, or made an unsure scope call. Trust `auto` over `self`.
- **`/rx-retro [ticket]`** aggregates the log, finds recurring (kind, phase, root-cause) patterns —
  weighting `auto` above `self` — and turns them into backlog items + learnings. One deviation is
  noise; a repeated pattern is a defect worth fixing.
- Flow: **runs → deviation log → `/rx-retro` (evidence → backlog) → `/rx-improve` (backlog →
  implementation, within invariants) → learnings.** The log is never erased; it's the historical record.

## Summary at a glance

Deterministic **Linear-ticket (or ad-hoc task) → merged PR** pipeline, with a human design gate.

```
/rx <id | linear-url | free text>        # dispatcher: picks the next stage
  start ──▶ awaiting-approval ⇄ (design-revise, design_rev++) ──▶ approved
        ──▶ implemented ──▶ pr-open ──▶ cleaned
               ▲                  │
               └──── rework ──────┘        (merge = a gh-detected PR state, not a phase)

  any non-terminal phase ──▶ aborted        # /rx-abort: abandon + tear the runtime down
```

- **Entry forms** (`/rx`): anything a **ticket source** recognises (`sources/*.md` — Linear, Jira, GitHub,
  GitLab bundled; teams add `.rx/sources/*.md` and pick a default with `tickets:` / `ticket_shape:` in
  `.rx/config.yml`), or free text (a short kebab id whose text *is* the
  requirement). Linear is just the bundled default, not a dependency.
- **Layers**: the `pi-rx` plugin *is* the workflow — bundled stage playbooks (`stages/rx-*.md`, injected
  by `/rx`) over the plugin's own state machine + `rx_*` tools (`src/index.ts`), with the docs the
  stages read bundled in `workflow/`. Companions (optional): `pi-notify` (push via ntfy). No portable bash layer.
- **Truth**: Linear = the *what* (read live); **pseudocode** = the *how* (reviewed at the gate, no
  PRP); **OpenSpec deltas** = the durable *what* (personal out-of-repo store).
- **Everything is out-of-repo**, namespaced per repo-key: state `~/.claude/workflow/state/<key>/`,
  disposable per-ticket artifacts `~/.claude/workflow/artifacts/<key>/<ticket>/` (the `*.pseudocode.md`
  design doc + any `*.diff` Co-Review shows), OpenSpec `~/.claude/workflow/openspec/<key>/`.
  Nothing lands in the project tree.
- **Review**: the stages open it at the gate with `rx_review_open` (tool form of `/rx-review`); it opens the artifact dir in **Co-Review** (github.com/sdsvn/co-review) through its MCP
  tools (`co-review mcp`): `open_review`, then an `await_reviewer` loop delivers comments and turns the Submit
  (approve / request changes) into the gate; `rx_review_reply` uses `reply`. Review state lands in `<ticket>.review.json`.
  Co-Review not installed → falls back to the pseudocode-design live HTML page (same gate, no reply threads) and recommends installing Co-Review.
- **Early abort** (`/rx-abort`): abandon a ticket at ANY non-terminal phase (`started`…`pr-open`) →
  terminal `aborted` (distinct from `cleaned` = merged). Confirms, closes an open PR, then `rx_teardown`
  removes the worktree + local/remote branch + watcher + artifacts. The state file stays as the record.

Overview: [`README.md`](../README.md); full reference: [`REFERENCE.md`](./REFERENCE.md).

## Invariants (don't break these to close a backlog item)

1. **Nothing in the target project tree** — state, specs, design artifacts, and decisions all live under `~/.claude/`.
2. **Plugin is the single source of state** — the phase machine (`TRANSITIONS`), repo-key derivation
   (`posixCksum`), and the `RxState` shape live only in `pi-rx`'s `src/index.ts`; every state write goes
   through the `rx_*` tools. `posixCksum` must match the system `cksum` binary; `demo()` guards it. There
   is no bash `rx-lib.sh`.
3. **The plugin is self-contained and load-bearing** — it bundles its stage playbooks and the
   `workflow/` docs they read (resolved via `$RX_PLUGIN`); there is no `~/.claude/commands/rx-*.md` or
   `rx-lib.sh` fallback. Edits in this repo are live on reload.
4. **Human gate is real** — `/rx-start` writes no code; only `/rx-approve` implements.
5. **PR body follows the repo template headings verbatim** (content stays terse — see
   `pr-description-style.md`).
6. **Shell state doesn't persist between bash blocks** — a stage's bash blocks that share a var must run in one call; nothing carries across tool calls.

## Improvement backlog (open, highest value first)

- [ ] **notify transport unconfigured** — `PI_NOTIFY_URL` points at non-working endpoints; set a real
  ntfy server + topic your device subscribes to, and `PI_NOTIFY_AUTO=1` for job-done pings. Then
  drop the dead LAN-first default. *(blocks all device notifications)*
- [ ] **Exercise the event-driven gate for real** — every real run so far used `rx_log`, not the
  `design_rev` self-edge / `/rx-review`. Do one ticket end-to-end through `/rx-review` in Co-Review.
- [ ] **ntfy remote-approve bridge** for `/rx-review` — needed if the agent runs remotely (localhost
  unreachable). Reuse pi-notify's subscribe→inject into `handleFeedback`.
- [ ] **Revisit OpenSpec personal-vs-shared** — specs are a private ledger; decide if the team wants
  them committed/shared.

Closed items: see [`HISTORY.md`](./HISTORY.md).
