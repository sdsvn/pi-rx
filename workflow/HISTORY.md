# Rx — workflow history (closed backlog + learnings log)

Archive split out of [`WORKFLOW.md`](./WORKFLOW.md) on 2026-10-02 so the orientation file stays one
screen. Entries are historical: names they mention as live at the time — `rx-lib.sh`, `commands/rx-*.md`,
PRPs / `PRPs/`, the in-repo `reviewapp` for rx — have since been retired (see WORKFLOW.md's
Invariants for what exists now). Append closed items and new learnings here, newest first.

## Learnings log (durable insights; git has the commit detail)

- **2026-10-21** — Writing a source file just to say "we use Jira" was too much: added `.rx/config.yml`
  (`tickets:` default system, `ticket_shape:` bare-id regex) and bundled Jira and GitLab. Bare ids now
  belong to the default system instead of being hard-wired into the Linear source. Ordering mattered: a
  shape the user configured must beat other sources' patterns (`#123` as GitLab), but the built-in
  `KEY-123` shape must come after them, or `gh-123` turns into a Linear ticket.
- **2026-10-21** — Free-text tasks were second-class: the id was the whole sentence behind a `task-`
  prefix (branch, worktree, Space label), the requirement lived only in the one `/rx-start` turn (lost on
  an interrupted start), `/rx approve` started a task called "approve", and a reworded request started a
  duplicate. Fixed with short kebab ids, an intake file folded in by `rx_init`, stage words, and
  `sameTask` matching. Then made the ticket system pluggable: a **ticket source** is a markdown file
  (match regexes + id template + fetch prompt), so Linear is just the bundled default and a team commits
  `.rx/sources/jira.md` instead of forking the playbook. Lesson: anything the user typed must be
  persisted the moment it's interpreted, not left in a prompt.
- **2026-10-20** — `/rx-review` no longer hard-requires Co-Review: with no `co-review` on PATH (and no
  `RX_REVIEW_BIN`/`CO_REVIEW_CLI`) it serves the pseudocode-design live HTML page instead, polling its
  `feedback.jsonl` into the same `handleFeedback`/`deliverComments` gate, and its notice recommends
  installing Co-Review. The HTML page has no threads, so `rx_review_reply` refuses and the agent answers in chat.
- **2026-10-20** — The human no longer types `/rx-review`: the agent can't run slash commands, so the
  stages used to end with "run /rx-review". Added `rx_review_open` (the tool form), called at the end of
  `/rx-start` and `/rx-rework` once the design is final. Kept it an explicit tool rather than an
  `rx_transition` side effect: transitions stay pure state, and the agent sees why a review didn't open.
  `rx_transition` into the gate reminds the agent to call it; headless sessions skip it.
- **2026-10-13** — Co-Review became a native app (0.6.x) and dropped server mode (`co-review-server`,
  the `-store` poll contract's bridge HTTP API, the phone view), so `/rx-review` failed with "Executable not
  found: co-review-server". Ported it to Co-Review's MCP tools over `co-review mcp <repo>` (plain JSON-RPC
  lines, no dependency — the same shape as Co-Review's own Pi integration): `open_review` with
  `storePath` (the `<ticket>.review.json` file format is unchanged, so `rx_status` still reads it),
  an `await_reviewer` loop instead of the 1.5s store poll, `reply` instead of the bridge POST, and a
  persisted `review_id` instead of `review_url`. Gone with the server: per-ticket port hashing,
  `RX_REVIEW_ADDR`, the bridge reuse/health-check, the phone/Tailscale notes. Co-Review reuses one review
  per directory, so a re-review rejoins it; the approved-design snapshot + design-changes diff are
  unchanged. Lesson: bind to a tool's published agent interface (its MCP tools), not its server's
  private files and ports — the latter vanished in a rewrite.

- **2026-10-12** — `/rx-review` kept popping a browser tab: pi-rx's own `openBrowser(uiUrl)` (left over
  from the in-repo reviewapp) fired on every launch/reuse. `co-review-server` calls Co-Review's
  `open_review` with `open: false` and prints the backend URL, which is a browser URL under the desktop app,
  so it was never meant to auto-open. Removed it; the notification still gives the URL to open when needed.

- **2026-10-05** — Second watcher-miss fix (first: 2026-09-10). A per-tick cursor in the agent's head
  is not a work queue: it moved past threads the watcher had escalated (notify timed out), and one
  numeric cursor across GitHub endpoints (issue comments ~5.99e9 vs review comments ~4.18e9) hid a
  whole surface. Owed-ness now comes from GitHub state joined with a durable ledger the *driver*
  writes (`reply`/`record` subcommands), and the loop — not the model — checks after each tick that
  every owed item got a reply or a disposition. Make the deterministic layer own bookkeeping; let the
  model only decide.

- **2026-10-02** — Plugin review pass. Split closed backlog + this log out of WORKFLOW.md (895 → ~100
  lines) because `/rx-improve` reads WORKFLOW.md whole and was paying for months of post-mortems.
  Code fixes: state read-modify-writes now hold a per-file `wx` lock (`withStateLock`) so the
  watcher's cursor patch can't drop a concurrent session write; self-hosted `rx_pr` refuses to merge
  unless the root checkout is on `main` (worktrees never move it); `rx_init` validates the ticket id
  like the other tools, and the `owner/repo#N` id form rejects `.`/`..` segments; the lock poll no
  longer spawns `sleep`. Lesson: every tool that turns a ticket into a path must validate it — one
  unguarded entry point undoes the rest.

- **2026-09-25** — Swapped the in-repo `reviewapp` server for Co-Review (`co-review-server`), which
  keeps the exact rx contract: `review server on <url>` startup line, `/api/context`, thread-reply
  POST, and the same `review.json` store (threads/messages/`review.count`). Lesson: when the review
  surface moves, keep the store file as the seam — the watcher, comment delivery and gate logic
  didn't change at all. The UI URL now comes from the startup line's `Co-Review: <url>` suffix (the
  bridge's `/` only redirects to 127.0.0.1), so the old tailscale-expose-the-bridge path was dropped.

- **2026-09-21** — Latency in a gated workflow comes from fixed ceremony, not the gate itself. The
  scout delegation in `/rx-start` §4 exists to keep bulk discovery content out of the design turn —
  for a tiny blast radius there is no bulk, so the round-trip is pure overhead. Lesson: scale the
  mechanism to its reason (context protection), not to the stage; keep the binding parts (map-first,
  verified anchors, human gate) invariant and let effort be proportional.

- **2026-09-16** — When an agent edits a doc per incoming comment, the token cost is the whole-doc
  RE-READ to find line numbers, not the write — and the anchor already carries the reviewer's exact
  selection. Lesson: resolve the anchor to a fresh line range server-side and hand the agent
  `file:Lx-Ly` so it reads/edits only that region. That beats a "virtual markdown" node tree, which
  would add a parser + serializer + shadow artifact and risk lossy markdown round-trips — reuse the
  surgical Edit + a grep-for-`exact`, keep the .md as the single source of truth.

- **2026-09-15** — A per-ticket review store that outlives one review round leaks stale state into the
  next one. `/rx-review` on the rework loop re-opened the same `<ticket>.review.json`, showing the
  approved round's resolved threads instead of the reworked design. Lesson: scope the review store to a
  single round and end it at the round boundary (`→ approved`), letting the design-changes diff carry
  the what-changed view — don't let cursors/threads accumulate across the whole ticket.

- **2026-09-14** — A generic skill can silently resurrect a retired workflow concept. Rx killed PRPs
  two weeks ago, but `skill://pseudocode-design` still mentioned `PRPs/` and generic self-hosted
  review, so real runs could bypass the stage-local artifact/review contract. Lesson: when a
  workflow retires a concept, scrub the shared skill that taught it too — but keep the canonical
  review path explicit (`/rx-review` here). The fix is “no PRP, one artifact, review through the
  workflow surface,” not “skip review.”
- **2026-09-14** — If a workflow retires a contract, block its old artifact shape at the gate.
  Prompt cleanup removed PRP guidance, but a saved `PRPs/...` path could still steer review and the
  next implementation turn back onto the dead contract. Lesson: don't just teach the new path —
  reject the old one where the run enters review/implementation.
- **2026-09-10** — GitHub splits PR discussion across two surfaces: `gh pr view --json
  comments,reviews` covers top-level conversation + review objects, but NOT line-level review-thread
  comments; those live under `repos/:owner/:repo/pulls/$PR/comments`. Any PR watcher that wants “all
  human review activity” must sum both or it silently misses inline feedback. `writeWatchDriver` now
  does, and `demo()` freezes the generated-script contract so the gap can't quietly regress.
- **2026-09-10** — First real reviewer feedback batch on the review surface (user-reported, logged
  above as four backlog items): chat-with-agent absent (suspect stale installed binary), Q&A should
  be inline/hover on anchors not a sidebar, comments should batch into one Submit, and every addition
  must respect a no-clutter constraint. Two things were plugin-fixable immediately: `rx_review_reply`
  + the comment-delivery prompt now demand human-toned 1–2 sentence replies (detail only on request),
  and `/rx-review` infers the ticket from the session/Herdr-Space binding (`currentTicket`) before
  falling back to the lone gated ticket, listing candidates when ambiguous — no more retyping the id
  each re-review.
- **2026-09-09** — Rebuilt the review surface's frontend as Svelte 5 + Vite (`reviewapp/frontend/` →
  built assets checked into `server/web/`, still one embedded Go binary; `go build` alone stays
  sufficient) and fixed the two worst UX trust-breakers the audit found: every mutation now surfaces
  errors (toasts + SSE reconnect banner — previously all `api()` failures were silent, "Submit did
  nothing"), and unsent review text persists in `localStorage` across reload/crash. `/rx-review` also
  stopped burning the review URL on every re-run: deterministic per-ticket port (FNV-1a of
  repo-key+ticket → 41000–44999; `RX_REVIEW_ADDR` pins, busy port falls back to `:0` once) plus
  reuse-if-alive (health-check `review_url`, match doc slug) means open tabs, bookmarks, and an
  installed PWA survive re-reviews — the server already live-reloads artifacts off disk, so
  kill+respawn was pure loss.

- **2026-09-09** — Compressed all 10 stage playbooks into gate-checklists (−61%) on the user's
  directive that a strong model + skills don't need spoon-feeding. The keep/drop rule that made it
  safe: a line survives only if it is a **gate** (stop condition), a **tool contract** (name +
  required fields), or a **learned hard rule** distilled to one imperative line; rationale, incident
  history, and evidence counts move here — the playbook states *what must hold*, WORKFLOW.md states
  *why*. Two coupling hazards to respect on any future rewrite: `src/index.ts`'s `rx_discovery`
  description names `/rx-start §4` and `/rx-approve §3` verbatim, and stages cross-reference each
  other's section numbers (`§7` self-report, approve-resume `§3`) — renumbering sections is a code
  change, not just prose.

- **2026-09-09** — Embedded ponytail as stage rules rather than a skill dependency: the ladder is a
  per-decision reflex, so it belongs inline where the decision is made (design §4, implementation
  §3), not behind a skill the agent may not load. Key transplants: "small diff in the wrong place is
  a second bug" (laziness never shortens *reading*), root-cause fix = the lazy fix (one shared guard
  < per-caller patches), and machine-findable `ponytail:` comments for deliberate ceilings.

- **2026-09-09** — Diagnosed a user-reported ~80-min `/rx T14` design turn from the omp logs
  alone: not a hang but **compaction thrash** — 13 sequential mid-run compactions, the working set
  bouncing 160k–175k against the harness's *fixed* 160k mid-run threshold (post-compact floor ~130k,
  so ~30k headroom → re-crossed almost every step) inside a 1M window it barely used. The threshold
  is a hardcoded harness default (not exposed under `~/.omp`), so rather than chase a number, fixed the
  root cause in the prompt: rx-start §4 now pushes the blast-radius scan into a read-only `scout`
  subagent that returns only a `file:line` digest, keeping raw source / `graphify` / `okf` content out
  of the design turn's context entirely. Two calls worth keeping: (1) the scout must be handed the
  `rx_discovery` directive *verbatim* — a subagent starts blank and silently defaults to `rg`, so
  "be aware of graphify/okf" has to be an explicit instruction, not an assumption; (2) the main turn
  still verifies the digest's anchors against source (maps *and* scouts drift), so delegation moves
  the bulk tokens out without giving up ground-truth. Keeps the design turn near the ~130k floor, so
  the threshold choice stops mattering — the better lever than raising the threshold toward 1M (which
  would just make every provider call maximally expensive).

- **2026-09-09** — Ran `/rx-retro` on the deviation log (59 entries) and fixed the four highest-value
  clusters, all prompt-only edits to `stages/{rx-start,rx-approve,rx-pr}.md`: (1) an agent can judge a
  task "the wrong shape" for the discovery gate ("this is really a grep/audit job") and skip a `true`
  `mustUseMap` directive entirely — closing that needs naming the specific rationalization, not just
  restating the rule; (2) a design's reachability/exclusivity claims need a `file:line` citation to
  the actual handler branch, not an inference from the request shape, since that's exactly where
  approved-design vs. real-handler drift hid until implement time; (3) a prose "worktree paths, not
  `cd`" reminder had already failed to prevent wrong-tree edits twice and failed a third time — the
  fix that actually holds is a checkpoint (`pwd && git rev-parse --show-toplevel` compared to
  `details.state.worktree`, right after `cd`, before the first edit) run at *every* entry point
  including the resumed-session path that skips the stage's own §1; (4) an armed autonomous
  watcher only prevents duplicate/bypassing work if the foreground session is explicitly told it's
  hands-off once the watcher exists — "the mechanism exists" doesn't imply "don't also do it
  yourself" without saying so. Common thread across all four: a rule stated once as prose is not
  self-enforcing against a plausible-sounding local justification; the fix in each case was to name
  the specific justification that recurred and foreclose it, or replace "remember to check" with an
  actual command that asserts the invariant.
- **2026-09-09** — Added the **early-abort** path (`/rx-abort` → terminal `aborted` phase) so a ticket
  can be abandoned + torn down at ANY phase, not only after a merged PR. Two design calls worth
  keeping: (1) `aborted` is a *separate* terminal phase from `cleaned`, not a reuse — the audit log
  must distinguish "abandoned" from "delivered", and a single terminal would blur `/rx-retro`'s
  by-phase counts. (2) Replaced the four scattered `phase !== "cleaned"` active-filters with one
  `TERMINAL`/`isActive` helper so adding a terminal phase can never again mean hunting every filter —
  the panel, `currentTicket`, the `/rx` fan-out, and `resolveStageTicket` all agree by construction.
  Also bounded the plugin's last unbounded blocking shell-outs (`rx_ground`'s network `git fetch`,
  the `openspec` CLI calls) with explicit `timeout`s — `runCli` already capped at 20s, but these raw
  `execFileSync` calls could hang a tool forever on an SSH prompt / unreachable remote; now they fail
  fast into the existing "refuse to ground on a stale base" path instead of freezing the session.
- **2026-09-08** — Caught my own verification gap on the `withSpaceLock` fail-closed rewrite: I first
  chased `bunx tsc` (no project tsconfig exists — AGENTS.md is explicit there's no build/typecheck
  harness) into a dead end of dependency `.d.ts` version skew (`bun-types`/`@types/node` mismatches in
  `@oh-my-pi/*` packages resolved from outside this repo), none of it attributable to `src/index.ts`,
  then nearly finalized on `demo()` alone even though `demo()` never called the changed function.
  Fixed for real: extracted `withSpaceLock` from `piRx`'s closure to module scope (it only ever closed
  over `pi.logger` for one debug line — now an injected optional `log` callback) with an `opts` param
  (`deadlineMs`/`pollMs`) that defaults to production values but lets a test shrink them, and added four
  assertions to `demo()`: a held/foreign lock never runs `fn` and never touches the lockfile; a
  successful holder releases it; a **thrown** `fn` still releases it (and the throw still propagates);
  and a released lock is re-acquirable. Lesson: for a concurrency/fail-closed rewrite, "the repo's one
  prescribed check passes" and "I read the diff carefully" are each necessary but neither is sufficient
  — if the changed function isn't reachable from the prescribed check, extend the check to reach it
  before calling the work verified, and prefer that over inventing ad-hoc tooling the repo's own
  AGENTS.md says doesn't exist.

- **2026-09-08** — User reported three live defects in one session, all fixed within existing invariants
  (no new tool surface, no state-shape break): (1) rx still named/labeled different Herdr Spaces for the
  same ticket — `ensureSpace`'s check-then-create had no cross-process guard, so two panes racing a bare
  `/rx` fan-out at the same instant could both see "no existing Space" and both create one; fixed with
  `withSpaceLock`, an exclusive-create lockfile per ticket, token-stamped so only the acquirer's `finally`
  removes it, wrapping the whole check-then-create body. Deliberately fails closed on contention timeout
  rather than ever stealing/reaping another lock — any liveness/staleness check used to justify
  auto-deleting one is itself unlink-then-recreate and reintroduces the identical race one level down —
  the same "serialize the race, don't just narrow the guess" shape as the
  2026-09-07 `guessLoneActive` fix, but for space creation instead of session labeling. (2) `/rx-start`
  was fetching Linear parent/related tickets unconditionally, slowing down pseudocode design on tickets
  whose own body was already sufficient — narrowed §1 to fetch the ticket's own fields by default, parent
  traversal only when the body is genuinely incomplete or the user asks. (3) review-browser comments
  "not always understood correctly" traced to two compounding causes: comments delivered as isolated
  per-comment turns (no shared context for a comment that only makes sense next to the one above it), and
  delivery text that presumed every comment was a fold-worthy decision with no signal to distinguish a
  QUESTION from a DIRECTIVE. Fixed by batching same-tick comments into one message (`deliverComments`)
  that requires classifying each one before acting. Lesson: "delivery" bugs (space naming, comment
  understanding) are as often a *batching/race* defect as a wording defect — check for a missing mutex or
  a missing shared-context batch before rewriting prose.

- **2026-09-08** — Ran a slow-model pass over the backlog and closed six items in one session: push-time
  migration/anchor re-check (`rx-pr.md` §2d, next to the existing race-prone-anchor re-verify at
  `rx-approve.md` step 3 — grounding is point-in-time, siblings keep merging until you actually push),
  the "self-hosting" sanction (new `RxState.self_delivered`; `rx_worktree`/`rx_ground` fall back to
  local `main` with a loud warning when there's no `origin`; `rx_pr` merges straight into local `main`
  and marks the ticket self-delivered instead of hard-stopping or improvising a bare-`main` commit;
  `rx_pr_state`/`rx_cleanup`/`rx-pr.md`'s rework-round check all branch on `self_delivered` the same way
  they already branch on `pr_number`), the worktree file-tool path warning, the `make generate` footprint
  discipline, and the verification-scope fallback sanction — all as explicit stage-prompt steps, per this
  backlog's established pattern of encoding a deterministic mechanic at the exact stage step where it's
  cheap rather than adding new tool surface where the check is prompt-judgment, not code. Also
  re-verified the `rx_status` `details.paths`-for-ticketed-call item against current `src/index.ts`:
  already fixed (the 2026-09-02 commit that introduced the artifact dir), not reproducible today — the
  2026-09-07 retro's live repro was likely against a build predating that commit, or the second of two
  `rx_status` calls in that session hit a stale cache; closed as verified rather than re-implemented.
  Lesson: before implementing a backlog item that claims a tool bug, re-check the tool's *current*
  source — a retro can lag the fix that already landed for an unrelated reason.
- **2026-09-07** — A live gate deadlock traced to tool confusion, not plugin logic: `notify_device`
  and `notify_if_idle` share almost the same parameter shape (`message`/`title`/`wait`/`timeoutSec`),
  but one blocks the calling turn immediately and the other arms a background timer and returns at
  once. An agent at the `T12` gate called the blocking one where the playbook meant the
  non-blocking one, freezing the session against both incoming review-server events and slash-command
  re-entries for the full timeout. Lesson: when two tools are near-identical in signature but opposite
  in blocking behavior, naming the tool once in prose isn't enough — the playbook must say which one
  NOT to use and why, in the same breath, especially at a step whose entire job is to keep the session
  responsive to external events.

- **2026-09-07** — Fixed a live user-reported bug: rx was renaming multiple unrelated Herdr
  sessions/Spaces. `STATE_ROOT`'s recursive `fs.watch` + `session_start` fire in every open session for
  a repo, and `currentTicket`'s "lone active ticket" fallback let a session with no real binding claim
  ownership whenever the repo had exactly one active pipeline. Lesson: a convenience guess that's safe
  for an EXPLICIT user action (typing `/rx` — ambiguity is fine to resolve in the user's favor) is
  unsafe for an AUTOMATIC background action (labeling triggered by someone else's state write) — the
  two need different confidence thresholds even when they share a helper; added a `guessLoneActive`
  flag rather than forking the function so the contract stays in one place.

- **2026-09-07** — `/rx-retro` on the full 47-entry deviation log: nearly every recurring pattern
  (stale-main grounding, guard-test ripple, worktree file-tool paths, `make generate` churn, disk/Docker
  verification fallback) is already tracked or fixed in this backlog — confirms the evidence loop is
  working. Three genuinely new, well-evidenced gaps: (1) PHI/PII protections (column encryption,
  telemetry exclusion) are checked nowhere in the design/implement gate and were only caught by
  human/Copilot review twice (T2, T9) — same "deterministic ripple, not judgment call"
  shape as the guard-test fix, just for HIPAA instead of frozen-surface tests. (2) The stale-main fix
  closes freshness *at re-ground time* but not at push time — a sibling can still claim a migration
  number in the gap (T10, post-fix). (3) `rx_status` per-ticket calls don't return `details.paths`
  despite a learnings entry claiming they do — a self-report (T11) and this session's own two
  `rx_status` calls both confirm the gap live.

- **2026-09-07** — Closed the PHI/PII gate gap the same way the guard-test-ripple fix worked: named the
  concrete, deterministic checklist item at the exact stage step where it's cheap (design gate, and
  post-codegen in implement) rather than adding a new tool or state field. Both PHI misses
  (T2's plaintext jsonb, T9's PHI in a generated tracing wrapper) were only caught by a
  *human/Copilot reviewer after the PR opened* — the review round-trip Rx's design gate exists to avoid.
  Lesson: a repo's explicit compliance rule (here, "encrypt PHI at rest" / "never log PHI") is exactly
  as foreseeable as a fail-closed guard test once you've seen it violated twice — encode it as a named
  checklist line at the stage that produces the risk (new column at design time, new generated wrapper
  at codegen time), don't wait for a third incident.

- **2026-09-05** — Closed the discovery-adherence gap: session-log audit showed Graphify was actually
  invoked in only ~13% of sessions and the OKF bundle read in ~5%, despite a standing "use Graphify/OKF
  for blast-radius" instruction — the agent *mentions* the maps constantly but defaults to manual
  grep/glob. Fix: made discovery a deterministic gate instead of prose. New `rx_discovery` tool checks
  the ticket worktree for `graphify-out/` and/or `okf/` and returns a binding directive
  (`details.mustUseMap`); `/rx-start` §4 and `/rx-approve` §3 now MUST call it before locating anything,
  with manual grep demoted to confirm-only and a required `rx_deviation` (ignored-instruction) when a
  present map is bypassed. Cheap existence check reusing `repoRoot`/`readStates`; `demo()` stays OK.

- **2026-09-04** — `/rx-review` now shows a **design diff on top of what was approved**, not the whole
  plan re-rendered. Key reuse: the `review` server's `-dir` mode already auto-discovers `*.diff`/`*.patch`
  and labels the tab from a `<slug>.md` sidecar's `title:` — so this is a pure rx-plugin change (no Go
  rebuild): snapshot the pseudocode on the → approved transition, then before each render emit a unified
  diff (approved → current) + sidecar into the served artifact dir. Details that matter: (1) markdown
  bullets survive a unified diff cleanly (a `- item` line becomes ` - item`/`+- item`/`-- item`; the
  server's ParsePatch reads `line[0]` for the +/-/space marker and `line[1:]` as content). (2) `diff -u
  -L a/X -L b/X approved current` yields a clean SINGLE-file diff (BSD/GNU both honor `-L`); `diff` exits
  1 when files differ, so its stdout IS the payload — catch it, don't treat the exit code as failure.
  (3) The delta is generated at `/rx-review` LAUNCH, not live — during an at-gate revise loop the doc
  live-reloads but the delta lags until the next `/rx-review`; that's fine, the delta is a review-time
  snapshot. (4) No approved baseline (first review / pre-approval revise loop) → no tab, just the plan.

- **2026-09-04** — Dropped Paseo from the PR watcher: it's now a Herdr **pane loop**, not a `paseo
  schedule`. Herd has NO scheduler primitive (only detach-surviving panes + `pane run`), so the scheduler
  IS a `while :; …; sleep; done` loop in a pane — the loop persists (Herd never reaps a pane based on agent
  state), and `omp -p` is the disposable per-tick worker that correctly **exits when its task is done**
  (that's the design, not a bug — the loop re-invokes it next cadence). omp headless autonomy =
  `omp -p --approval-mode yolo --max-time 8m --cwd <worktree>` (verified via `omp --help`; `-p` =
  process-and-exit). Cost control: a cheap no-LLM `gh` pre-check (state / checks / mergeable / comment+review
  count vs a cursor file) **gates** the omp tick, so the model only wakes on a real event. Self-stop: the
  tick agent can't kill its parent loop, so it drops a `{{WORKTREE}}/.rx-watch-stop` sentinel the loop
  checks (replaces `paseo schedule delete`); a 14-day deadline is the backstop (replaces `--expires-in`).
  The one real regression vs Paseo: the loop dies on `herdr server stop`/reboot (Paseo's daemon survived)
  — covered by making `ensureWatch` idempotent + reconciling it on every `/rx` pr-open landing and `/rx-pr`
  rerun, so re-entry restores a dead watcher. Wrote the loop as a driver **script** in the artifact dir
  (not an inline `pane run` string) to dodge shell-quoting hazards. Aliveness of a watcher = the tab is
  still in `herdr tab list --workspace <ws>` (mirrors the Space's workspace-id liveness check).

- **2026-09-04** — Added one-Space-per-RX. Herd's `workspace create` returns `.result.workspace.workspace_id`
  + `.result.root_pane.pane_id`; `workspace get` on a dead id exits non-zero (aliveness check); `--env`
  on create seeds the pane's shell so the omp launched there inherits `RX_LAND`. That flag makes
  `/rx <ticket>` **land** — bind the fresh session + show status, no drive/gate — instead of the normal
  phase drive, which is what let `/rx-resume` retire. Hard-won spawn lessons from live runs: (1) `herdr agent start … && agent
  prompt` RACES omp's splash — a slower instance is still booting when the prompt fires and drops it
  silently (one ticket landed, its sibling sat on the splash). (2) `agent start … -- <arg>` breaks Herd's
  agent-name registration ("cannot use null as iterable") when omp starts straight into work. The fix that
  works: **`herdr pane run <root> "omp '/rx <ticket>'"`** — omp runs the command as its INITIAL MESSAGE
  only after full init (commands registered), so no race, no splash drop; registered slash commands
  execute from the initial message (verified: `/rx-panel` ran silently; unregistered `/help` fell to the
  model). (3) Open the Space at the **repo root**, not the worktree — `/rx` is worktree-aware and resolves
  `.worktrees/<ticket>` itself. (4) After a relaunch the process's `HERDR_WORKSPACE_ID` env is stale —
  read ids from CLI JSON, and label the Space after the ticket THIS pane drives (bound session → owned
  Space → lone active), not "the only active". (5) The landing must NOT `switchSession` into the ticket's
  old transcript: omp namespaces session files by the cwd they were recorded in, so a worktree-recorded
  session won't resume from a repo-root launch (one ticket jumped into a stale session, its sibling showed
  nothing). Deterministic landing = bind THIS session + `dispatch("status")`; the audit log carries history.

- **2026-09-03** — `/rx-retro` on 5 deviations (all `rx-improve-the-plugin`): the recurring defect is
  Rx running **against its own loaded checkout**. 3× branch/PR-flow drift (1 auto) — no `origin`
  remote → can't branch off `origin/main`; and because omp loads the plugins from the main checkout,
  the worktree/PR indirection strands the edits off the live path, so the agent commits to `main`
  every run and self-logs drift. Root cause: the worktree+`origin/main`+PR mechanics assume a
  remote-backed *shared* repo; self-hosting (target root == loaded plugin root, or no `origin`) needs a
  sanctioned in-place mode, not a hard stop or a per-run improvisation. The other 2 (review-app
  text-selection request-changes; deferring explicitly-optional design items) are one-offs, not mined.

- **2026-09-02** — Continued the "deterministic mechanics in the plugin" push: added `rx_pr` (open PR /
  push rework → `pr-open`), `rx_pr_state` (merge gate), `rx_openspec` (validate/archive/show against the
  personal store), and `rx_decision` (DECISIONS.md append). Rewired rx-pr/rx-cleanup/rx-reject/rx-rework
  to call them — the fragile PR-body heredoc-with-placeholder-guards, the `gh pr view` merge check, the
  `openspec` CLI lines, and the `printf >> DECISIONS.md` are gone from the prompts. Grounded openspec
  against the installed v1.9.0 binary: there is **no `openspec new change`** (only show/list/validate +
  top-level archive/show/validate, all `--store <id>`) — the old rx-start scaffold command was stale, so
  changes are now authored as files then validated. Open item flagged to the user: confirm the exact
  v1.9.0 required artifact set for `validate --strict` (proposal + spec deltas + tasks.md?).

- **2026-09-02** — Moved worktree **creation** into the plugin as `rx_worktree` (teardown already lived
  in `rx_teardown`), per `skill://using-git-worktrees`. `/rx-start` step 2 was ~5 lines of bash that
  ran `git worktree add` relative to CWD and only *asserted* `.worktrees/` was ignored. The tool now
  resolves the MAIN repo root (so it works even when run from another worktree), *verifies* `.worktrees/`
  is git-ignored and adds + commits it if not, creates `.worktrees/<ticket>` on branch `<ticket>` off
  `origin/main`, and is idempotent (reuses a match, refuses a conflict). Lesson: "isolate the workspace"
  is a deterministic mechanic with real safety steps (ignore-verification, root resolution) — it belongs
  in the plugin, not as bash the prompt hopes the agent reproduces correctly.

- **2026-09-02** — Fixed a real bug: **`rx_transition` refused every ad-hoc `rx-<slug>` pipeline**
  ("rx: invalid ticket") because its guard was `VALID_TICKET = /^[A-Z]+-[0-9]+$/` (ENG-style only),
  while `slugId`/`rx_init`/`/rx` all mint and drive `rx-...` ids. Added a shared `PIPELINE_ID` accepting
  both forms, applied it to `rx_transition` and the same-bug `/rx-review` arg parse, and pinned it in
  `demo()`. Lesson: an input guard must match the id grammar the rest of the system actually produces —
  a stricter-than-reality regex silently breaks a whole class of pipelines. (User-reported.)

- **2026-09-02** — Moved the watcher/cleanup/retro **mechanics out of the stage prompts into pure-TS
  plugin tools** — `rx_watch_start`, `rx_watch_stop`, `rx_teardown`, `rx_deviations` — so the playbooks
  call one tool instead of re-emitting ~70 lines of `paseo`/`herdr`/`git` bash every run. The plugin
  shells out via `execFileSync` (best-effort, short timeouts), reads the bundled `watcher.md`, resolves
  the `watch`→`impl` provider role, and — since pi-rx labels the Herdr workspace, it now also *persists*
  that workspace id (`herdr_workspace`) so the watcher-log tab is wired without re-discovery. Lesson:
  plugin-ownable mechanics belong in the plugin as TS, not as bash the LLM reproduces — the prompt
  should carry judgement, the plugin the determinism. Considered bundled shell scripts first but plugin
  code runs TS directly, so a tool is cleaner (typed, records state itself, no shell-quoting).

- **2026-09-02** — Gave the CI/comment watcher a **merge-conflict** step: it detects base conflicts via
  `gh pr view --json mergeable,mergeStateStatus` and clears them by merging `main` **into** the branch
  (never a force-pushing rebase from an unattended agent). It auto-resolves only *mechanical* conflicts
  (regenerate lockfiles/generated code, take both independent additions, absorb import/format churn),
  gated by the full verify loop before pushing; anything where both sides edited the same logic is
  `git merge --abort` + escalate (`notify_device`, or `/rx-rework` for a real design clash). Lesson:
  an autonomous agent may do *convergent* git work (merge to clear a conflict) but must never make a
  *judgement-call* resolution unreviewed — same safe/escalate split as its CI and comment handling.

- **2026-09-02** — Corrected a watcher regression I introduced the same day: an earlier pass read an
  *incomplete* Paseo docs page and concluded `paseo schedule create` had no `--mode`, then deleted the
  provider→mode mapping. The installed CLI (0.7.2) DOES have `--mode` (`claude bypassPermissions`,
  `opencode build`) — verified with `paseo schedule create --help` + `paseo provider ls --json`. Restored
  `--mode "$MODE"` (with a retry that drops it if a provider rejects the value) so the watcher's fresh
  agents push without approval prompts. Lesson: verify a CLI against the installed binary's `--help`, not
  a docs page that may lag the release.

- **2026-09-02** — Made Rx a self-contained pi-rx plugin: deleted the repo `commands/rx-*.md` +
  `workflow/` layers, bundling the stage playbooks and the three runtime-read docs into the plugin and
  wiring a `$RX_PLUGIN` dispatch token so playbooks read their bundled assets with zero `~/.claude`
  dependency. Also made the watcher's schedule id-capture robust via `paseo schedule ls`. Lesson: when a
  plugin "owns" a workflow, its bundled prompts must resolve their own assets — an absolute
  `~/.claude/...` path baked into a bundled playbook is a hidden external dependency, not self-containment.

- **2026-09-02** — Killed the last in-repo write: `/rx-start` used to drop the design artifact at
  `PRPs/<ticket>.pseudocode.md` **inside the target worktree** (violating invariant #1 and carrying the
  dead "PRP" name). Now the pseudocode + any diffs live in a plugin-owned disposable artifact dir
  (`~/.claude/workflow/artifacts/<repo-key>/<ticket>/`, exposed via `rx_status` `details.paths.artifacts_dir`,
  swept at `/rx-cleanup`), and `/rx-review` serves it with the server's existing `-dir` review-directory
  mode instead of `-md <file>`. Dropped the unused `prp` state field; OpenSpec is the durable spec.
  Considered rewriting the Go `review` server in TS for "self-containment" but declined — it's a
  dependency-free binary that's *also* an MCP server backing live harness tools, with correctness-critical
  re-anchoring/diff-parsing logic and a 70KB JS UI; the language was never the coupling, and its `-dir`
  mode already delivered the disposable-artifact-dir goal. Lesson: reach for a component's existing
  extension point before porting it; "self-contained" means no in-repo writes + owned paths, not one language.

- **2026-09-01** — Fixed a phase-panel defect: `pi-rx`'s `readStates` globbed every `*.json` in the
  state dir, so the review server's `<ticket>.review.json` sidecar (no `ticket`/`phase`) rendered as
  a phantom `rx undefined ▸ undefined` row — during any live `/rx-review`, not just after cleanup.
  Now it skips `.review.json` and requires a string `ticket`+`phase` before treating a file as a
  pipeline (regression pinned in `demo()`). Also closed the leftover-artifact gap: `/rx-cleanup`
  step 5 now `rm -f`s the `.review.json`/`.review.log` run details (state file stays as the audit
  record). Plugin + command-doc; bash unaffected (it addresses states by exact name, never globs),
  so inv. #2 untouched. Lesson: a dir that mixes canonical records with transient sidecars needs a
  shape/name filter at the reader, and teardown must sweep the run artifacts it spawned.

- **2026-09-01** — Encoded the repo's fail-closed guard tests into `/rx-start`'s test-plan step: any
  new public surface (rpc/table/column/error-code) must be paired in the plan with the guards it
  necessarily trips (frozen-surface list, trigger catalog, absent-tables). These ripples are
  deterministic, not judgment calls, yet were "discovered" 3× only at the `-short` failure. Lesson:
  fold known fail-closed guards into the design checklist so they're planned, not rediscovered per
  ticket. Command-doc only — portable, no lockstep.

- **2026-09-01** — Implemented the fix for the incomplete stale-main gate: `rx_base_status` (rx-lib.sh)
  measures the *branch* against `origin/main`'s tip via `git merge-base HEAD origin/main`, not just
  whether origin/main moved during the fetch — the exact gap that let T5 (38 commits behind, no
  local commits) read as "already fresh." It returns fresh / fetch-failed / behind-ff / diverged with
  a commit-count and ff-vs-rebase guidance; `/rx-approve` step 3 now reconciles + re-verifies
  sibling-merged surface when behind. Lesson: a freshness gate must check the thing you'll build ON
  (the branch's merge-base), not a proxy (did the remote ref move) — the proxy passes precisely when
  the branch is stalest. Bash-only, no pi-rx lockstep (inv. #2 untouched); verified against fresh /
  behind-ff / diverged fixtures.
- **2026-09-01** — `/rx-retro` on 36 deviations: the 2026-08-29 stale-main fix is *incomplete*.
  `rx_fetch_main` measures freshness against a **cached baseline**, so a worktree branched at an old
  main reads "unchanged" even when `origin/main` advanced — T5 was 38 commits behind with a
  merged sibling (T3) and the gate said nothing. Result: the whole feature cluster
  (6236/6238/6242/6243/6251) drifted at implement time on siblings that merged concurrently — 5×
  `auto/contract-drift` plus `auto/reworked`/`scope-miss`. Root cause: freshness must be measured
  against `git merge-base HEAD origin/main` vs `origin/main`'s tip, never a cached snapshot.
  Concurrent sibling merges on a shared surface (a shared proto/RBAC/store) are the norm here, not the
  exception; the re-ground must detect and reconcile them, not just notice "did main move since I last
  cached it."
- **2026-09-01** — Two deterministic, foreseeable ripples keep surfacing only at the `-short` failure,
  never in the design: (1) fail-closed guard tests (`TestPublicSurface_is_frozen`, trigger catalog,
  absent-tables) that any new public surface trips (3×), and (2) worktree file-tool path resolution —
  the edit/read/write tools resolve against the main checkout, so worktree edits mis-land (2×, one
  cost a full codegen cycle). Both are cheap to prevent with a checklist/invariant and expensive to
  discover late. Lesson: encode the repo's known fail-closed guards and the worktree path rule into
  the plan; don't rediscover them per ticket.

- **2026-08-29** — Closed the stale-main defect at its root: grounding freshness must be *enforced*,
  not hoped for. New `rx_fetch_main` (rx-lib.sh) replaces the silent `git fetch origin main --quiet`
  in `/rx-start`; it never uses `--quiet` and returns non-zero so the caller stops rather than
  building a worktree/design on an unverified-fresh base. `/rx-approve` also re-grounds before
  implementing — main can advance between branch time and implement time, so race-prone anchors
  (migration numbers) get re-verified against current main, not trusted from design time. Lesson: any
  step whose correctness depends on a fetch must treat a failed/no-op fetch as a hard stop; a silent
  fetch is a silent lie about how fresh your base is. (Bash-only helper — no pi-rx lockstep needed,
  inv. #2 untouched; `demo()` still green.)

- **2026-08-28** — HTML `/rx-review` comments went unaddressed until the human called them out. Root
  cause: `handleFeedback`'s plain-comment branch (the 💬 buttons + general chat box, no `kind`) built
  an FYI "Design review note" message instead of an instruction, so the agent read it as context and
  moved on; only the "Request changes" button emitted an actionable directive. HTML-VIEW.md already
  mandates "treat a comment exactly like a chat instruction" — the plugin didn't. Fix: the plain-comment
  branch now emits the same directive as the `revise` path (fold into canonical pseudocode → re-render
  `--live` to the same path → stay at the gate; resolve judgment calls as open questions). Lesson: any
  channel that carries reviewer intent must inject an *act-on-it* message, never a passive note.

- **2026-08-26** — Portability gap closed: the `/rx` plugin's URL/free-text normalization now lives in
  `rx-lib.sh` too, so `/rx-start <url|free text>` works with no plugin. Key subtleties: every re-sourced
  block must re-derive `$T` via `rx_normalize_id` (state doesn't persist, inv. #6), the resolver must
  pass already-canonical `rx-<slug>` ids through unchanged (else plugin-dispatched ad-hoc ids get
  double-slugged), and free text needs the full `$ARGUMENTS`, not `$1`. Cross-language dup is guarded
  by a `demo()` parity check that shells into rx-lib.sh (inv. #2).

- **2026-08-25** — A silent `git fetch origin main --quiet` failure (SSH) let `/rx-start` ground the
  design on a **stale main** → a colliding migration number (`000021`), caught only at implement
  (T1). Root cause: grounding is only as fresh as the fetch, and `--quiet` + no error check hid
  the failure. Lesson: a failed fetch must **stop** the pipeline, not pass quietly — stale grounding
  silently corrupts numbering/`file:line` anchors. (Deviation log proved its worth on run #1.)

- **2026-08-19** — Paseo's sandboxed webview blocks inline `<script>` (CSP): the `/rx-review` toggle
  and `/feedback` fetch silently no-op there. Root cause of "toggle dead + comments never arrive."
  Fix path: view in a real browser. Page JS is correct otherwise (toggle now event-delegated).
- **2026-08-19** — Injecting into an **idle** session from a raw callback doesn't wake it; marshal via
  `ctx.setTimeout` (the managed loop) — same primitive pi-notify's idle nudge uses. Also: deliver
  every review comment immediately (don't buffer) so nothing is silently dropped.
- **2026-08-18** — Plugin/bash repo-key diverged on **symlinked paths** because the plugin used
  `path.resolve` where bash uses `pwd -P`; use `fs.realpathSync`. Cross-language duplication needs a
  parity check (`demo()` cksum test).
- **2026-08-18** — `STORE`/`CH` set in one bash block are gone in the next (no shell persistence);
  every block must re-derive. Bit the OpenSpec step (silent no-op) until fixed.
- **2026-08-18** — OpenSpec archive closes the durable loop: on `/rx-cleanup` the change folds into the
  store's baseline `specs/`. Keep it a **personal out-of-repo store** to honor invariant #1.
- **2026-08-17** — PRP removed: the pseudocode tree is the single design contract (reviewed *and*
  implemented against). OpenSpec carries the durable requirement deltas instead.

## Closed backlog items

- [x] **Paseo-webview support for `/rx-review`** (2026-10-13, obsolete) — the CSP-blocked inline-JS
  page is gone: Co-Review is now a native app that `/rx-review` drives over MCP, so there is no web page
  to embed.

- [x] **Watcher drops review comments it escalated, and hides one id space** (2026-10-05,
  user-reported, on a live PR) — root cause: the 11:04 tick asked about the Copilot
  dedup-race/OKF threads, got no ntfy reply, then advanced `.rx-watch-cursor` past them; the count-only
  pre-check never woke for them again. The cursor was also a single id compared across issue- and
  review-comment endpoints. Fixed: `workflow/watch-items.jq` builds one keyed item list (threads,
  comments, review bodies) from a GraphQL snapshot × `<state>/<ticket>.watch.jsonl`; the driver wakes on
  owed items, re-asks `human`/`unhandled` hourly, records `unhandled` for anything a tick leaves
  untouched, and prints the items table in the pane; the tick answers only via `watch.sh reply|record`.
  `demo()` pins the status rules.

- [~] **Review UI: inline Q&A on the plan, not a side panel** (2026-09-10, user-reported) — the
  reviewer wants to ask a question on a node and see the agent's answer in place (hover/popover on
  the anchored node), instead of tracking a sidebar thread. Reviewapp change: render thread replies
  as hover/inline affordances on their anchors; keep the page uncluttered (below).
  *Superseded 2026-10-02: rx reviews designs in Co-Review since 2026-09-25, so these are no longer
  rx work; the in-repo `reviewapp` now serves only pi-cr — re-file there if still wanted.*
- [~] **Review UI: batch comments, single submit** (2026-09-10, user-reported) — comments currently
  deliver one-by-one as they're typed (the store poll picks up each new comment immediately). The
  reviewer wants a GitHub-style pending review: accumulate comments locally, deliver the batch on
  Submit. Reviewapp holds pending comments; plugin side already consolidates per poll tick, so a
  batched POST arrives as one delivery for free.
  *Superseded 2026-10-02: rx reviews designs in Co-Review since 2026-09-25, so these are no longer
  rx work; the in-repo `reviewapp` now serves only pi-cr — re-file there if still wanted.*
- [~] **Review UI: keep it uncluttered** (2026-09-10, user-reported) — standing constraint on the
  three items above: new affordances (chat, inline answers, pending queue) must not crowd the plan
  view; prefer hover/collapsed states over always-visible panels.
  *Superseded 2026-10-02: rx reviews designs in Co-Review since 2026-09-25, so these are no longer
  rx work; the in-repo `reviewapp` now serves only pi-cr — re-file there if still wanted.*
- [x] **First pseudocode phase too slow on one-shot-sized tickets** (2026-09-21, user-reported) —
  `/rx-start` §4 mandated scout-delegated discovery + full design ceremony regardless of scope, so a
  ticket the agent could one-shot still paid a subagent round-trip and a padded tree before the gate.
  Fixed: §4 gained a **proportionality fast path** — when the touched surface is already evident
  (couple of files, no new public surface/schema/migration, no regulated data), the map query runs
  inline (map-first stays binding, anchors still verified) and the pseudocode is a deliberately short
  tree. Gate, out-of-repo artifact, and structure contract unchanged.
- [x] **Pseudocode skill drifted back to PRP-era defaults** (2026-09-14, user-reported) —
  `skills/pseudocode-design/SKILL.md` still suggested repo-local planning dirs like `PRPs/` and
  generic self-hosted review, conflicting with Rx's load-bearing out-of-repo artifact dir +
  plugin-owned `/rx-review`. In a real project run this pulled the design flow back toward PRP
  copies / wrong review plumbing. Fixed: the skill now says caller/workflow-specified artifact path
  and review transport win, removes PRP wording entirely, `rx-start.md` states that override
  explicitly, and `validatePseudocode()` now requires `Context` + `Open Questions` so malformed
  artifacts fail at the gate instead of drifting into review.
- [x] **Review and implementation must reject retired PRP artifacts** (2026-09-14) — prompt cleanup
  alone is not enough: a stale state path like `PRPs/<ticket>.pseudocode.md` can still steer the
  run back onto the dead contract. Fixed: `rx_pseudocode_check` and `/rx-review` now hard-fail on
  PRP-shaped pseudocode paths, and `rx-approve.md` explicitly says implementation uses only the
  approved pseudocode artifact + OpenSpec deltas.
- [x] **PR watcher missed GitHub line-level review comments** (2026-09-10, user-reported) — root
  cause: `writeWatchDriver`'s `should_tick()` counted only `gh pr view --json comments,reviews`, but
  GitHub serves inline review-thread comments from `repos/:owner/:repo/pulls/$PR/comments`. New
  line-level feedback therefore left `.rx-watch-count` unchanged, so the watcher never woke `/rx-rework`.
  Fixed: the generated watcher script now sums both sources, and `demo()` freezes that emitted-driver
  contract so the regression fails before runtime.
- [x] **Review UI: ask-agent chat missing in the user's installed `review` binary** (2026-09-10,
  user-reported; closed same day) — root cause confirmed: `~/.local/bin/review` was built Sep 4,
  predating the 2026-09-09 Svelte rebuild that added the "Ask Agent" draft intent. Rebuilt from
  `reviewapp/server` (`go build`), reinstalled, and smoke-verified the served bundle contains the
  Ask Agent UI. `reviewapp/Makefile` now makes staying current one command — `make -C reviewapp
  install` (`make frontend` first only when `frontend/` changed). Remaining hardening idea: have
  `/rx-review` surface the binary's version/build stamp so "old binary" is diagnosable, not guessed.
- [x] **Close the "task-shape exception" loophole in the discovery gate** (2026-09-09) — evidence:
  1× `self/ignored-instruction` (T13: skipped `graphify`/`okf` entirely for a precise
  RPC-vs-e2e-coverage cross-reference, reasoning it was "better served" by direct `grep`/`read` than
  a graph traversal, even though `mustUseMap` was true). The binding directive already said manual
  search is confirm-only when a map exists, but said nothing about *why* an agent might reach for the
  exception anyway. Fixed: `rx-start.md` §4 now names the rationalization directly — "this is really
  a line-level/audit job" is not a valid reason to skip the map — right where the directive is
  introduced, and the scout-delegation section already in place still applies (the map gives the
  anchor set to diff against, manual reads stay confirm-only against it).
- [x] **Reachability claims in a design need a citation, not an inference** (2026-09-09) — evidence:
  1× `auto/contract-drift` (T13: the approved pseudocode asserted a request-shape check was
  reachable without a real row; the handler actually validated the row's existence first, so the
  approved claim held for a different rule than the one named, surfacing only at implement time).
  Fixed: `rx-start.md` §4 now requires any design bullet asserting reachability/exclusivity of a
  code path to name the exact `file:line` of the handler branch that proves it, verified against
  source before the gate — the same discipline already required for blast-radius anchors, extended to
  reachability assertions specifically since those are the ones that silently drift between "design
  intent" and "what the handler actually checks first".
- [x] **Worktree-path checkpoint: verify, don't just remember** (2026-09-09) — evidence: 1×
  `auto/contract-drift`-class incident (T13, a *third* recurrence after the same prose warning
  was already in `rx-approve.md` §1 twice before) — all edits + a new file landed in the main
  checkout instead of the worktree, caught only by a peer diffing `git status` in both trees. A prose
  reminder to "prefix every path" is necessary but not sufficient once an agent has already drifted
  into the wrong cwd. Fixed: §1 (and, since the `approved`-exception path skips §1 entirely, §3 too)
  now requires a concrete checkpoint — `pwd && git rev-parse --show-toplevel` in the same bash call
  right after `cd`, asserted equal to `details.state.worktree` before the first edit — not just a
  rule to keep in mind throughout the stage.
- [x] **PR watcher: foreground session is hands-off once armed** (2026-09-09) — evidence: 1×
  `auto/ignored-instruction` (T14: a foreground session fixed a Copilot review comment on the PR
  directly — correctly and verified, but bypassing the armed `rx-watch` tab that exists precisely to
  detect and drive new review comments through `/rx-rework`). The user's stated expectation was that
  the watcher, not the session that happened to be open, owns post-`pr-open` PR activity. Fixed:
  `rx-pr.md` §3 now states this explicitly after the watcher is armed — no self-triggering into a
  manual fix/push for new PR activity unless the user explicitly asks for direct intervention.
- [x] **Early-abort + cleanup path for any phase** (2026-09-09) — before this, the only teardown was
  `/rx-cleanup`, gated on a *merged* PR (`pr-open → cleaned`); a ticket that was wrong, superseded, or
  blocked at `started`/`awaiting-approval`/`approved`/`implemented` had no sanctioned way to be
  abandoned — its worktree, branch, watcher, and artifacts leaked, and a manual `rx_transition` to
  `cleaned` was refused by the state machine. Fixed: new terminal phase `aborted` + an early-abort edge
  from every non-terminal phase (`TRANSITIONS`), a `TERMINAL`/`isActive` helper (replacing the four
  scattered `phase !== "cleaned"` filters so `aborted` also drops off the panel/dispatch lists), a new
  `stages/rx-abort.md` playbook (confirm → close an open PR → `rx_teardown` → `rx_transition aborted`)
  wired as `/rx-abort`, and an abort option in the `awaiting-approval` and `pr-open` gate menus.
  `aborted` is deliberately distinct from `cleaned` (merged) so the audit log reads truthfully.
  `demo()` pins the abort edges, terminal-ness, and `approved→aborted`.
- [x] **/rx-review shows design changes since approved** (2026-09-04) — on a re-review the reviewer now
  sees WHAT CHANGED on top of the approved design, not the whole plan again. `snapshotApprovedDesign`
  copies the pseudocode to `<ticket>.pseudocode.approved.md` on the → approved transition;
  `refreshDesignDelta` writes a unified diff (approved → current) as `<ticket>.design-changes.diff` +
  a titled sidecar into the served artifact dir before each `/rx-review`, so the review server shows a
  **"Design changes since approved"** diff tab beside the plan (no baseline / no change → no tab). Pure
  rx-plugin change; reuses the review server's existing `-dir` *.diff discovery — no reviewapp rebuild.
- [x] **Herd-native PR watcher — drop Paseo** (2026-09-04) — the watcher is now a self-scheduling loop
  in a Herdr pane in the ticket's Space, not a `paseo schedule`. `ensureWatch`/`writeWatchDriver`/
  `watchTabAlive` in `src/index.ts`: `rx_watch_start` renders `watcher.md` + a driver script into the
  artifact dir, opens the `rx-watch <ticket>` tab, and runs the loop — a cheap `gh` pre-check each cadence
  that only then wakes a fresh `omp -p --approval-mode yolo` tick. Idempotent + self-healing: reconciled
  on `/rx-pr` rerun and when `/rx` lands a `pr-open` ticket. Self-stop via a `.rx-watch-stop` sentinel + a
  14-day deadline; `/rx-cleanup` closes the tab. Removed `watchProvider`/`scheduleIdByName`/the
  `watcher_schedule*` state fields.
- [x] **Rx is a self-contained plugin — no portable bash layer** (2026-09-02) — retired
  `~/.claude/commands/rx-*.md` and `workflow/rx-lib.sh`; pi-rx now bundles the stage playbooks
  (`stages/`) and the docs they read (`workflow/{WORKFLOW,pr-description-style,watcher}.md`), resolved
  via the `$RX_PLUGIN` dispatch token. Invariants #2/#3 rewritten: the plugin is the single source of
  state and is load-bearing, not a "pure upgrade".
- [x] **HTML review comments must be actionable, not FYI** — the 💬 per-node buttons and the general
  chat box (the *primary* review channel, POSTed with no `kind`) were delivered as a passive "Design
  review note", so the agent acknowledged them but didn't fold them in; only "Request changes"
  (`kind:"revise"`) carried a directive. Fixed: `pi-rx handleFeedback`'s plain-comment branch now
  injects the same act-on-it directive as the revise path (fold into the canonical pseudocode →
  re-render `--live` → stay at the gate). Evidence: 1× `auto` human correction (had to explicitly ask
  the agent to address the review comments). *(n=1 but systemic — every non-button comment hit the
  passive path.)*
- [x] **rx-start must not design against a stale `origin/main`** — evidence: 1× `auto/migration-number`
  @implemented (T1). `git fetch origin main --quiet` (step 2) failed on SSH and the pipeline
  proceeded anyway, so the design grounded on stale main and chose a colliding migration number
  (`000021` already taken by `roi_contacts`); caught only at implement time. Fixed: new
  `rx_fetch_main` helper in `rx-lib.sh` does a **loud** (never `--quiet`) fetch and returns non-zero —
  caller stops — when the fetch fails or `origin/main` can't resolve; it prints whether main advanced.
  `/rx-start` step 2 now `rx_fetch_main || exit 1` (no worktree built on an unverified base), and
  `/rx-approve` step 3 re-grounds before implementing, warning to re-verify race-prone anchors
  (migration numbers) when main advanced since branch time.
- [x] **Re-ground must compare to `origin/main`'s tip, not a cached baseline** — the 2026-08-29
  `rx_fetch_main` fix is *incomplete*: 7× post-fix, mostly `auto`. Smoking gun: T5
  `auto/scope-miss` @implemented — `rx_fetch_main` reported main "unchanged vs its cached baseline"
  while HEAD was **38 commits behind `origin/main`** (sibling T3's `owner_id` / `assigned` /
  migration `000016` already merged). Ripple across the feature cluster: `auto/contract-drift` ×3
  (T5 `owner_id` is the provider entity id not the user id; T8 group SELECT
  is full-row after rebase; T6 gocyclo from a sibling reject case), `auto/reworked` (T4
  collided with merged T7), `auto/scope-miss` (T8 sibling `ErrNotFound` +
  frozen-surface guard). Root cause: freshness is measured against a **cached baseline snapshot**, so a
  worktree branched at an older main reads as fresh. Fixed (2026-09-01): new `rx_base_status`
  (rx-lib.sh) runs `rx_fetch_main` then checks the branch via `git merge-base HEAD origin/main` vs the
  tip — returns 0 fresh / 1 fetch-failed / 2 behind-ff / 3 diverged with commit-count + reconcile
  guidance; `/rx-approve` step 3 calls it, hard-stops on fetch failure, and reconciles (ff/rebase) +
  re-verifies sibling-merged surface when behind. *(n≈7, mostly auto — highest value)*
- [x] **Test plan must enumerate the repo's fail-closed guard tests** — evidence: 3× `scope-miss`
  (1 `auto`): T2, T8 (`auto`), T6 each added a new rpc/table/error-code and only
  discovered the frozen-surface guard (`TestPublicSurface_is_frozen`), trigger catalog, and
  foundation-scope absent-tables when the `-short` suite failed. Root cause: the pseudocode test-plan
  step has no checklist for the deterministic fail-closed guards that ANY new public surface trips.
  Fixed (2026-09-01): `/rx-start` step 3 now carries a checklist line — a new
  rpc/table/column/error-code must list the fail-closed guards it forces to update (public-surface
  freeze, trigger catalog, absent-tables), with a grep hint for the service's `*_test.go`.
- [x] **PHI/PII checks are missing from the design + implementation gate, so they're only caught by
  human/Copilot review** (2026-09-07 retro; closed 2026-09-07) — evidence: 2× `auto/reworked`
  (human-verified, `awaiting-approval`): T2 shipped a new sensitive column as plaintext
  jsonb (should be an encrypted column per the repo's PHI-at-rest standard, only caught by self-review
  after the PR opened); T9's generated otel tracing wrapper logged a caller-supplied
  identifier (PHI/PII) into telemetry params, only caught by Copilot review. Root cause: neither the
  design test-plan checklist nor the post-`make generate` step verifies new sensitive-data columns or
  newly-generated tracing wrappers against the repo's explicit "encrypt PHI at rest" / "never log PHI"
  rules — the same "deterministic ripple, not judgment call" shape as the guard-test fix below, just
  for regulated data. Fixed: `rx-start.md` §3 now carries a checklist line — a new column/field
  plausibly carrying PHI/PII/secrets must state an explicit encrypt-or-documented-exception decision
  inline in `## Design` before the gate; `rx-approve.md` §3 now checks post-codegen tracing/logging
  wrappers for newly-added regulated fields before finishing.
- [x] **Migration number can still collide after a fresh re-ground, because grounding is a point-in-time
  check and siblings keep merging** (2026-09-07 retro; closed 2026-09-08) — evidence: 1× post-fix
  `self/scope-miss` @implemented (T10, 2026-09-04): `rx_ground` reported fresh, yet a sibling
  ticket (adding a new table) claimed migration `000017` before T10 pushed, forcing a
  last-minute `000017`→`000018` renumber — the same failure class the 2026-08-29/09-01 stale-main
  fixes closed for T1/feature-cluster, but that fix re-grounds once at `/rx-approve` step 3, not
  again immediately before the migration file is committed. Root cause: concurrent long-running
  worktrees can claim a migration number *between* your re-ground and your push — matches this repo's
  own documented hazard (AGENTS.md "Migration numbering vs. open PRs": check every open PR, not just
  `main`). Fixed: new `stages/rx-pr.md` §2d re-checks the reserved anchor against current `origin/main`
  **and** every open PR branch immediately before `rx_pr` pushes/opens, not only at the earlier
  `rx_ground` snapshot — a prompt-level fix (the anchor grammar is repo-specific, so the plugin can't
  own the check itself).
- [x] **`rx_status` doesn't expose `details.paths` for a ticketed call, contradicting its own learnings-
  log claim** (2026-09-07 retro; closed 2026-09-08) — evidence: 1× `self/guessed` (T11,
  2026-09-03) plus reproduced live in this session: two `rx_status(ticket: T10)` calls today
  returned only state fields, no `paths` block. The 2026-09-02 learnings entry says the artifact dir is
  "exposed via `rx_status` `details.paths.artifacts_dir`," but that's only true for the no-ticket/bulk
  listing. Re-verified 2026-09-08: `src/index.ts`'s ticketed branch (line ~909) DOES return
  `details: { state, paths: { ...paths, artifacts_dir: artifactsDir(dir, params.ticket) }, review }` —
  the code already carries the field per-ticket (git blame: fixed 2026-09-02, same day as the learnings
  entry). The gap was real at the time but is not reproducible against current `src/index.ts`; closing
  as verified-fixed rather than re-implementing. If this regresses, check for a second `rx_status`
  registration shadowing the fixed one (there was exactly one at audit time).
- [x] **Sanction "self-hosting / no-origin" Rx runs** (closed 2026-09-08) — evidence: 3× branch/PR-flow
  drift, all ticket `rx-improve-the-plugin` (1× `auto/contract-drift` @implemented — implemented on
  `main`, not the worktree; 1× `self/contract-drift` @implemented — committed+pushed straight to
  `origin/main`, bypassing the PR gate; 1× `self/scope-miss` @awaiting-approval — branched off local
  `main` because the repo has no `origin`). Root cause: the worktree + `origin/main` + PR mechanics
  assume a remote-backed *shared* repo, but when Rx runs against the very checkout omp loads its
  plugins from live (no `origin`, or `origin/main`==local `main`), the indirection either hard-stops or
  strands the edits off the path omp actually loads. Fixed: `RxState` gained `self_delivered?: boolean`;
  `rx_worktree`/`rx_ground` detect no-`origin` via `hasOriginRemote()` and fall back to branching
  off/comparing against local `main` with a loud warning instead of hard-stopping; `rx_pr` detects the
  same condition and, instead of push+`gh pr create`, merges the ticket branch straight into local
  `main` at the repo root and sets `self_delivered: true` (title used as the merge-commit summary, body
  optional); `rx_pr_state`/`rx_cleanup` treat `self_delivered` as already-merged, skipping the `gh`
  round-trip. `stages/rx-pr.md` and `stages/rx-cleanup.md` updated to branch on `self_delivered` the
  same way they branch on `pr_number`. `demo()` pins the `baseRef` fallback (no origin → `main`, origin
  present → `origin/main`).
- [x] **Worktree file-tool paths must be prefixed** (closed 2026-09-08) — evidence: 2× `self`
  (T4 cost a full failed codegen cycle; T8 had every edit rejected). Root cause: the
  edit/read/write tools resolve relative paths against the workspace root (the MAIN checkout), NOT the
  `cd`'d worktree, so edits silently land in / read from the wrong tree. Fixed: `stages/rx-approve.md`
  §2 (gate check) now states the rule explicitly — every file-tool path in this stage is prefixed with
  `.worktrees/<TICKET>/` or the absolute `details.state.worktree` path; a bash `cd` does not scope the
  file tools.
- [x] **`make generate` footprint discipline** (closed 2026-09-08) — evidence: 2× `self/other` (+1
  deferred proto-doc regen): T6 (~60 unrelated regenerated files), T9 (import-reorder drift
  in 6 gen files); the local codegen toolchain differs from CI's pinned tools. Fixed:
  `stages/rx-approve.md` §3 now instructs — after `make generate`, restore all generated files to
  `origin/main` except the N carrying the new RPC/iface method (match the sibling PR's footprint); never
  hand-edit generated files, splice only when regen is impossible and mirror the committed block
  exactly.
- [x] **Sanction the verification-scope fallback** (closed 2026-09-08) — evidence: 3× `self`
  (T3, T9, T6) all hit workstation disk-100% / Docker-down and improvised the same
  recovery. Fixed: `stages/rx-approve.md` §3 now codifies the protocol — when full-repo/Docker
  verification is env-blocked, clear the go build cache, verify the changed service end-to-end
  (build/vet/lint/short+integration), name in the PR Test Plan which checks were deferred to CI; using
  this documented fallback is not itself a deviation, only skipping a check *without* naming the
  deferral is.
- [x] **`/rx-review` after `/rx-rework` showed the previous round's review items** (2026-09-15,
  user-reported) — root cause: the review store (`<ticket>.review.json`) and the per-ticket delivery
  cursors (`review_delivered`/`review_round`) persist for the whole ticket, so a re-review on the
  rework loop (`pr-open → awaiting-approval`) reopened the *same* store and rendered the prior round's
  resolved threads + approve decision instead of a clean slate for the reworked design. Fixed:
  `applyTransition` now ends the review round on `→ approved` (symmetric with `snapshotApprovedDesign`)
  — deletes the review store and resets the cursors — so the next `/rx-review` starts fresh with only
  the "design changes since approved" diff as the what-changed view.
- [x] **Review comment delivery re-read the whole design per comment** (2026-09-16, user-reported) —
  each delivered comment told the agent to "fold it into the canonical pseudocode markdown" with no
  location, so it read the entire design (and often rewrote it) every time — O(doc) tokens per
  comment. Fixed WITHOUT a virtual-markdown/AST layer (the anchor already carries the reviewer's
  `exact` selection): new pure `locateAnchor` resolves each anchor to a FRESH line range in the
  current pseudocode (ignoring markdown markers), `deliverComments` appends `→ edit <path>:Lx-Ly in
  place` per comment and the DECISION/DIRECTIVE instruction now says read ONLY that range, never the
  whole doc. Ranges are matched against the file as it stands at delivery, so they never point at a
  stale earlier round. `demo()` pins single-line, multi-line, and unlocatable→null.
- [x] **URL/free-text entry in the no-plugin path** — `rx-lib.sh` now has `rx_extract_ticket` /
  `rx_slug_id` / `rx_normalize_id` (mirroring the plugin), and `/rx-start` normalizes `$1` +
  `$ARGUMENTS` into the canonical `$T` at entry; `demo()` cross-checks bash↔JS parity.
- [x] **Regenerate this repo's `okf/`** (closed 2026-09-08) — was materially stale after the standalone
  migration: it still documented `commands/rx-*.md` + `workflow/rx-lib.sh` as live "copies". Regenerated
  with the `okf-repo` skill: removed `okf/commands/` and `okf/workflow/rx-lib.md` (the retired portable-
  bash layer), rewrote `okf/workflow/rx-*.md` as playbook docs for `pi/plugins/rx/stages/*.md`, added
  docs for the previously-undocumented `rx-improve`/`rx-retro` loop, the self-hosting fallback, and the
  `pi-cr`/`pi-trace` plugins, and refreshed `pi-rx.md`'s tool surface to the current `rx_*` set.
  `scripts/validate_okf.py okf` → 0 errors, 0 warnings.
- [x] **One Herd Space per active RX** (2026-09-04) — pi-rx now creates a dedicated Herd Space per
  active (non-`cleaned`) ticket, not just labels the enclosing one. `ensureSpace`/`spaceForTicket`/
  `spawnOmpInSpace` in `src/index.ts`: bare `/rx` inside Herdr reconciles the project (each space-less
  ticket gets a `herdr workspace create` at the **repo root** + omp launched via `herdr pane run "omp
  '/rx <ticket>'"`, which — via a seeded `RX_LAND` env — LANDS on the ticket: binds the fresh session +
  shows status, no resume, no gate), while the current pane's ticket is driven in place. Dedup = persisted
  `herdr_workspace` (via `workspace get`) then `<ticket> · ` label scan. Retired the standalone
  `/rx-resume` command — an interactive `/rx <ticket>` still offers a reopen when bound elsewhere.
- [x] **`currentTicket`'s lone-active fallback mislabeled unrelated Herdr sessions** (2026-09-07) —
  user-reported: rx was renaming multiple, unrelated Herdr Spaces/sessions to the same ticket. Root
  cause: `STATE_ROOT` is watched recursively and shared per repo across every worktree/pane, so
  `refresh()` (state-watch) and `session_start` fire in EVERY open session for that repo on ANY state
  change; `currentTicket`'s "else the lone active ticket" fallback then let a session with NO real
  binding (not its session id, not its Herdr workspace) claim ownership whenever the repo happened to
  have exactly one active pipeline — auto-renaming that session's/Space's label even for unrelated
  work. Fixed: `currentTicket` takes a `guessLoneActive` flag (default `false`); the two automatic
  background callers (`refresh`, `session_start` → `nameHerdrWorkspace`) now require an actual binding
  and stay silent when ambiguous, while the interactive bare-`/rx` dispatch (where the user explicitly
  typed `/rx` in this pane) still opts in — that guess is intentional there.
- [x] **Approval-gate nudge could deadlock the session on the wrong notify tool** (2026-09-07) —
  user-reported live incident: at the `T12` gate, review comments delivered via `/rx-review`'s
  events and a follow-up `/rx-approve` both sat queued (Herdr showed them stuck in "Steering"/"After
  yield") and were never acted on. Root cause: `rx-start.md` §6 asks for `notify_if_idle` (pi-notify;
  returns immediately, waits for a reply in the *background* after real idle) but the transcript
  showed the agent invoked `notify_device` instead (pi-notify's other tool; same
  `message`/`title`/`wait`/`timeoutSec` shape, but fires and blocks *synchronously* for up to
  `timeoutSec`) — freezing the whole session, so nothing else (review events, slash-command
  re-entries) could be processed until the 30-minute wait resolved. Fixed: `rx-start.md` §6 now names
  `notify_if_idle` as the literal required tool, explicitly forbids `notify_device` as a substitute,
  and states the concrete failure mode so the distinction survives paraphrasing. No plugin/tool code
  change — `notify_if_idle` already behaves correctly (fire-and-forget `setTimeout`, confirmed in
  `pi/plugins/notify/src/index.ts`); this was purely an instruction-following gap.
- [x] **Duplicate/stale Herdr Spaces for the same ticket** (closed 2026-09-08) — user-reported: rx
  still named different Herdr Spaces for one ticket and left some with a stale label, even after the
  2026-09-07 `guessLoneActive` fix. Root cause: `ensureSpace`'s check-then-create (`spaceForTicket` →
  `workspace create` → `patchState`) had no cross-process guard, so two panes racing a bare `/rx`
  fan-out at the same instant could both see "no existing Space" and both `workspace create` one for
  the same ticket — the loser's Space is now permanently orphaned: state's `herdr_workspace` points at
  the winner's id, so the loser's own `currentTicket` ws-ownership check fails forever and nothing ever
  relabels it again. Fixed: `withSpaceLock` — exclusive-create lockfile per ticket in the state dir,
  token-stamped so only the actual acquirer's `finally` can remove it — now wraps `ensureSpace`'s
  whole check-then-create body, serializing concurrent creators per ticket. Deliberately has NO
  steal/reap of another lock, including one left by a crashed process: any liveness/staleness check
  used to justify auto-deleting a lock is itself unlink-then-recreate and reintroduces the exact same
  race one level down (two contenders can both judge the same lock abandoned; whichever acts second
  destroys the other's fresh, live lock — a nested "reaper" mutex just moves the identical race onto
  itself, since no wall-clock heuristic soundly proves a paused-but-alive process is dead). On
  contention timeout it FAILS CLOSED — returns without creating — rather than ever proceeding
  unsynchronized or auto-deleting; a crash-abandoned lock permanently no-ops that ticket's
  auto-Space-creation until removed by hand (or a future startup maintenance pass), which is a
  strictly safer failure than ever risking a duplicate `workspace create`.
- [x] **rx-start fetched Linear parent/related tickets even for self-sufficient tickets, slowing down
  pseudocode design** (closed 2026-09-08) — user-reported. `stages/rx-start.md` §1 told the agent to
  fetch "title, description, acceptance criteria, parent/related, comments" unconditionally, so a
  ticket whose own body was already sufficient still triggered parent-ticket traversal. Fixed: §1 now
  fetches only the ticket's own fields by default; parent/related is followed only when the ticket's
  own body is genuinely incomplete without it or the user explicitly asks.
- [x] **Review-browser comments not always understood correctly** (closed 2026-09-08) — user-reported.
  Two causes, both fixed without touching the `review` Go binary: (1) each newly-posted comment was
  delivered as its OWN `sendUserMessage` turn (`for (const c of fresh) setTimeout(() => deliverComment(...))`),
  so several comments left in one pass (e.g. "same as above", or a question only meaningful next to
  the comment above it) were split across isolated turns with no shared context. Fixed: `deliverComments`
  now sends every comment that landed since the last poll tick as ONE consolidated message. (2) the
  delivery text presumed every comment was a decision to fold ("fold the decision into the pseudocode"),
  giving the agent no signal to distinguish a QUESTION from a DIRECTIVE — a question folded as if it
  were a decision is a real misunderstanding, not just an unanswered question. Fixed: the message now
  requires classifying each comment (question → answer via `rx_review_reply` first; directive → fold +
  confirm; ambiguous → ask back) before acting on it.
- [x] **rx-start's discovery reads ballooned the design turn into compaction thrash** (closed
  2026-09-09) — user-reported. A single `/rx T14` design turn ran ~80 min: the omp log shows 13
  back-to-back "Mid-run compaction ran between provider calls" events, the working set oscillating
  160k–175k against the harness's fixed 160k mid-run threshold (in a 1M window — only 16%), each
  compaction crushing 45–89 messages → 3 only for the next step's repo read to re-cross it. Root
  cause: §4 had the main design turn do the whole blast-radius scan itself — `graphify` query output,
  `okf` bundle text, and raw source all landing inline. Fixed (prompt-only, no harness/threshold
  change): §4 now delegates the scan to ONE read-only `scout` subagent that returns a compact digest
  (`file:line` anchors + one-line notes, no source dumps), so bulk content stays in the scout's
  context, not the design turn's. The `rx_discovery` binding directive is echoed to the scout verbatim
  so it is explicitly aware of the map — MUST use `skill://graphify` + the `okf/` bundle when
  `mustUseMap` is true (it starts blank and would otherwise default to `rg`); the main turn only
  verifies the returned anchors against source.
- [x] **Stage playbooks act as gates, not tutorials** (closed 2026-09-09) — user directive: minimize
  the stage text, maximize the result; the model + skills own the *how*. All 10 `stages/rx-*.md`
  rewritten as terse gate-checklists (875 → 344 lines, −61%): every hard rule kept as one line
  (guard tests, PHI decision, cwd/worktree-path checkpoint, codegen footprint, verification
  fallback, anchor re-check, notify_if_idle-never-notify_device, scout delegation with the
  graphify/okf directive, strict 4-section pseudocode); all rationale, incident narrative, and
  deviation citations dropped — this file and git hold the why. Section anchors referenced from
  `src/index.ts` (`/rx-start §4`, `/rx-approve §3`) and cross-stage refs (`§7` self-report,
  approve-resume `§3`) preserved.
- [x] **Embed the ponytail (lazy-senior-dev) ladder into design + implementation** (closed
  2026-09-09) — user provided the ponytail skill; its load-bearing rules were distilled into the two
  stages that create artifacts: `rx-start` §3 (YAGNI on tests: smallest set that fails on a
  plausible bug) and §4 (design ladder: YAGNI → repo helper → stdlib → native/DB constraint →
  installed dep → one line → new code; named-ceiling corner-cuts; never simplify security/validation
  /data-loss handling); `rx-approve` §3 (same ladder for the diff, root-cause-where-all-callers-route
  bug fixes, `ponytail:` ceiling comments). Other stages are state-mechanics — nothing to embed.
