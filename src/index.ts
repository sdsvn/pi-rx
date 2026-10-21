import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pi-rx — gated Rx workflow companion.
 *
 * Self-contained: the plugin owns the state files (schema + paths under
 * ~/.claude/workflow/state/) and bundles the stage playbooks (stages/) and the
 * docs they read (workflow/). No bash rx-lib.sh, no ~/.claude/commands/rx-*.md. Adds:
 *   - tool `rx_status`      read a ticket's state (or list all for this repo)
 *   - tool `rx_transition`  guarded phase moves — refuses invalid jumps
 *   - live phase panel      widget listing active tickets, refreshed on
 *                           fs.watch of the state dir (every rx_* write included)
 *   - command `/rx-review`  host the pseudocode HTML review in-process; the page's
 *                           Approve / Request-changes actions POST back as events
 *                           that drive the gate — no feedback temp file, no polling
 *
 * State machine (phases + the rework loop + the design-revise self-loop):
 *   started → awaiting-approval ⇄ (revise, design_rev++) → approved →
 *             implemented → pr-open → cleaned
 *                    ↑                   │
 *                    └────── rework ─────┘
 * (merge is a PR state detected via `gh`, not a phase — /rx-cleanup goes pr-open → cleaned.)
 * Any non-terminal phase can early-abort → aborted (/rx-abort): abandon + tear the runtime down.
 */

const PHASES = [
  "started",
  "awaiting-approval",
  "approved",
  "implemented",
  "pr-open",
  "cleaned",
  "aborted",
] as const;
type Phase = (typeof PHASES)[number];

/** Allowed transitions. The awaiting-approval self-edge is a design revision
 *  (pseudocode reviewed → changes requested → rewritten → re-reviewed);
 *  pr-open → awaiting-approval is the rework loop. Merge is a PR state (detected
 *  via `gh`), not a pipeline phase — /rx-cleanup goes pr-open → cleaned directly.
 *  Every non-terminal phase can also go straight to `aborted` — an EARLY ABORT that
 *  abandons the ticket and tears its runtime down (/rx-abort). */
const TRANSITIONS: Record<Phase, Phase[]> = {
  started: ["awaiting-approval", "aborted"],
  "awaiting-approval": ["approved", "awaiting-approval", "aborted"],
  approved: ["implemented", "aborted"],
  implemented: ["pr-open", "aborted"],
  "pr-open": ["cleaned", "awaiting-approval", "aborted"],
  cleaned: [],
  aborted: [],
};

/** What the human runs next in each phase — shown in the panel. */
const NEXT_CMD: Record<Phase, string> = {
  started: "(finish /rx-start)",
  "awaiting-approval": "/rx-approve | /rx-reject",
  approved: "(implementing…)",
  implemented: "/rx-pr",
  "pr-open": "/rx-rework | /rx-cleanup",
  cleaned: "done",
  aborted: "abandoned",
};

/** Terminal phases: the pipeline is finished — delivered (`cleaned`) or abandoned (`aborted`) — so it
 *  drops off the active panel/dispatch lists. */
const TERMINAL: Partial<Record<Phase, true>> = { cleaned: true, aborted: true };
const isActive = (s: RxState) => !TERMINAL[s.phase];

/** Pure transition decision + in-place mutation (no IO), shared by applyTransition
 *  and demo(). The awaiting-approval self-edge is a design revision, not a phase move. */
function computeTransition(s: RxState, to: Phase, note: string, now: string): { ok: boolean; text: string; state?: RxState } {
  const allowed = TRANSITIONS[s.phase] ?? [];
  if (!allowed.includes(to))
    return { ok: false, text: `rx: ${s.ticket} is '${s.phase}'; valid next: ${allowed.join(", ") || "(terminal)"}. Refusing '${to}'.` };
  const revision = to === s.phase && s.phase === "awaiting-approval";
  if (revision) {
    s.design_rev = (s.design_rev ?? 0) + 1;
    s.log = [...(s.log ?? []), { at: now, event: "design-revise", note }];
  } else {
    s.phase = to;
    s.log = [...(s.log ?? []), { at: now, event: `phase:${to}`, note }];
  }
  s.updated_at = now;
  const tail = revision ? `revision ${s.design_rev} logged (still at the gate)` : `→ ${to}. Next: ${NEXT_CMD[to]}`;
  return { ok: true, text: `rx: ${s.ticket} ${tail}`, state: s };
}

const STATE_ROOT = path.join(os.homedir(), ".claude", "workflow", "state");

type RxState = {
  ticket: string;
  branch: string;
  worktree: string;
  phase: Phase;
  pseudocode: string | null;
  openspec_change?: string | null; // the OpenSpec change id carrying this ticket's durable spec deltas
  test_plan: string | null;
  pr_number: string | number | null;
  self_delivered?: boolean | null; // true when delivered via a self-hosted direct merge to local main (rx_pr, no origin remote) — rx_pr_state/rx-cleanup treat it as already merged, no gh round-trip
  herdr_workspace?: string | null; // Herdr workspace hosting this ticket (when launched from Herdr)
  herdr_watch_tab?: string | null; // Herdr tab running the PR-watcher loop; closed at /rx-cleanup
  herdr_watch_pane?: string | null; // the watcher loop's pane (aliveness check for reconciliation)
  design_rev?: number; // count of pseudocode revisions at the approval gate
  // Where the work came from and what it is, persisted at intake so resume, labels and the PR title never
  // depend on re-reading the ticket: `source` = "text" for a free-text task (else the ticket system),
  // `source_ref` = what the user typed, `title`/`requirement` = the story as fetched (or the text itself).
  source?: string | null;
  source_ref?: string | null;
  title?: string | null;
  requirement?: string | null;
  // omp session bound to this ticket (plugin-managed). A fan-out-spawned Space binds this field to its
  // own fresh session and shows status; an interactive /rx on a ticket bound elsewhere offers to reopen it.
  session_id?: string | null;
  session_file?: string | null;
  // Co-Review binding (plugin-managed): the review id (rejoined on re-review / reply after a restart),
  // the review-state file Co-Review writes, the delivered-comment cursor and the last-consumed submit
  // round — persisted so a restart neither drops nor replays.
  review_id?: string | null;
  review_store?: string | null;
  review_delivered?: string[];
  review_round?: number;
  created_at: string;
  updated_at: string;
  log: { at: string; event: string; note: string }[];
};

/** Pure resume decision: a ticket is resumable iff it is bound to a session file that exists and
 *  differs from the session we're currently in. Extracted so demo() can test it without a runtime. */
export function canResumeSession(
  state: Pick<RxState, "session_id" | "session_file"> | undefined,
  currentSessionId: string | undefined,
  fileExists: boolean,
): boolean {
  return Boolean(state?.session_file) && fileExists && state?.session_id !== currentSessionId;
}


type ReviewAnchor = {
  type?: string; path?: string; line?: number; startLine?: number; endLine?: number;
  side?: string; nodeId?: string; exact?: string; source?: string; blockId?: string;
};

type ReviewThread = { id: string; anchor?: ReviewAnchor; status?: string; severity?: string; messages?: { body?: string; role?: string }[] };
type ReviewStore = { threads?: ReviewThread[]; review?: { count?: number; decision?: string; summary?: string } };
type ReviewComment = { threadId: string; anchor?: ReviewAnchor; body: string };

/** A thread as Co-Review's `await_reviewer` returns it with status "comment". */
type CoReviewThread = {
  threadId: string;
  number?: number;
  location?: { kind?: string; path?: string; startLine?: number; endLine?: number; symbol?: string };
  messages?: { author?: string; role?: string; body?: string }[];
};
/** `await_reviewer`'s result: "comment" (threads to answer), "submitted" (the verdict), "closed", "pending". */
type CoReviewWait = { status: string; threads?: CoReviewThread[]; decision?: string; summary?: string; round?: number; hint?: string };

/** The reviewer's new messages in `await_reviewer` threads, as comments to deliver — skipping keys
 *  (`<threadId>#<message index>`) already delivered. Each comment's anchor comes from the matching
 *  thread in the review-state file when there is one (it carries the selected text, so locateAnchor
 *  can point at the exact pseudocode lines), else from the thread's location. Pure; tested in demo(). */
export function reviewComments(
  threads: CoReviewThread[],
  store: ReviewStore | null,
  delivered: Set<string>,
): Array<ReviewComment & { keys: string[] }> {
  const out: Array<ReviewComment & { keys: string[] }> = [];
  for (const t of threads) {
    const keys: string[] = [];
    const bodies: string[] = [];
    (t.messages ?? []).forEach((m, i) => {
      const key = `${t.threadId}#${i}`;
      if (m.role === "agent" || m.role === "system" || delivered.has(key)) return;
      keys.push(key);
      bodies.push(String(m.body ?? ""));
    });
    if (!keys.length) continue;
    const stored = store?.threads?.find((s) => s.id === t.threadId || (t.number != null && s.id === `t${t.number}`));
    const l = t.location;
    const anchor: ReviewAnchor | undefined =
      stored?.anchor ??
      (l?.path
        ? l.startLine
          ? { type: "code-range", path: l.path, startLine: l.startLine, endLine: l.endLine ?? l.startLine }
          : { type: "code-file", path: l.path }
        : undefined);
    out.push({ threadId: t.threadId, anchor, body: bodies.join("\n"), keys });
  }
  return out;
}

/** Map a Co-Review Submit decision onto the gate: approve, request changes (revise), or a plain comment. */
export function reviewVerdict(decision: string | undefined): "approve" | "revise" | "comment" {
  const d = String(decision ?? "").toLowerCase();
  if (d.includes("approve")) return "approve";
  if (d.includes("request") || d.includes("change")) return "revise";
  return "comment";
}

/** One MCP session with Co-Review through `co-review mcp <root>` — the stdio bridge every harness
 *  uses; it starts Co-Review on the first tool call and reconnects when the app restarts. Plain
 *  JSON-RPC lines, so no MCP dependency (mirrors Co-Review's own Pi integration). `RX_REVIEW_BIN`
 *  (or `CO_REVIEW_CLI`) overrides the `co-review` command. Closing it ends the MCP session. */
export class CoReview {
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, { ok: (r: any) => void; fail: (e: Error) => void }>();
  private nextId = 0;
  private stderr = "";

  constructor(readonly root: string) {}

  private start(): Promise<void> {
    const bin = process.env.RX_REVIEW_BIN || process.env.CO_REVIEW_CLI || "co-review";
    const proc = spawn(bin, ["mcp", this.root], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stderr?.on("data", (d) => (this.stderr = (this.stderr + d).slice(-2000)));
    proc.on("error", (e) => this.drop(proc, new Error(`'${bin} mcp' did not start: ${e.message} — install Co-Review (https://sdsvn.github.io/co-review/) or set RX_REVIEW_BIN`)));
    proc.on("exit", (code) => this.drop(proc, new Error(`co-review mcp ended (exit ${code})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`)));
    let buf = "";
    proc.stdout?.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.receive(line);
      }
    });
    return this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-rx", version: "1.0.0" } }, 120_000).then(() =>
      this.write({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
  }

  /** The bridge is gone: fail every waiting call; the next call starts a new one. */
  private drop(proc: ChildProcess, err: Error) {
    if (proc !== this.proc) return;
    this.proc = null;
    this.ready = null;
    for (const p of this.pending.values()) p.fail(err);
    this.pending.clear();
  }

  private write(msg: unknown) {
    this.proc?.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  private receive(line: string) {
    let m: { id?: number; result?: any; error?: { message?: string } };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
    if (!p) return; // notifications (e.g. Claude Code channels) aren't for us — we wait with await_reviewer
    this.pending.delete(m.id!);
    if (m.error) p.fail(new Error(m.error.message ?? "Co-Review failed"));
    else p.ok(m.result ?? {});
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (!this.proc) return Promise.reject(new Error("co-review mcp is not running"));
    const id = ++this.nextId;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "timeout" } });
        fail(new Error(`Co-Review did not answer ${method} in ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, {
        ok: (r) => (clearTimeout(timer), ok(r)),
        fail: (e) => (clearTimeout(timer), fail(e)),
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  get connected(): boolean {
    return this.proc !== null;
  }

  /** Call a Co-Review MCP tool; returns its JSON answer (or text), throws on a tool error. */
  async call<T = any>(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    this.ready ??= this.start().catch((e: Error) => {
      const p = this.proc;
      if (p) {
        this.drop(p, e);
        p.kill();
      }
      throw e;
    });
    await this.ready;
    const r = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const text = ((r.content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("");
    if (r.isError) throw new Error(text || `${name} failed`);
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  close() {
    const proc = this.proc;
    if (proc) this.drop(proc, new Error("left the review"));
    proc?.stdin?.end(); // ends the MCP session; Co-Review hands this agent's threads back
  }
}

/** The Co-Review CLI to run, or null when it isn't installed — then /rx-review falls back to the
 *  pseudocode-design HTML page. `RX_REVIEW_BIN` / `CO_REVIEW_CLI` are taken as given. */
function coReviewBin(): string | null {
  const set = process.env.RX_REVIEW_BIN || process.env.CO_REVIEW_CLI;
  if (set) return set;
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(d, "co-review");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** The pseudocode-design skill dir holding scripts/render_html.py + live_review.py: `RX_PSEUDOCODE_SKILL`,
 *  then bundled in the plugin, then this monorepo's skills/, then the user's installed skill. */
function pseudocodeSkillDir(pluginRoot: string): string | null {
  const candidates = [
    process.env.RX_PSEUDOCODE_SKILL,
    path.join(pluginRoot, "skills", "pseudocode-design"),
    path.join(pluginRoot, "..", "..", "..", "skills", "pseudocode-design"),
    path.join(os.homedir(), ".claude", "skills", "pseudocode-design"),
  ];
  for (const c of candidates) if (c && fs.existsSync(path.join(c, "scripts", "live_review.py"))) return c;
  return null;
}

/** A free localhost port for the HTML review server. */
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => ok(port));
    });
  });
}

/** One-line location for a review anchor — file:line(s)/side, tree/mermaid node, or document —
 *  plus the quoted selection, so a delivered comment tells the agent exactly what was commented on.
 *  Pure; tested in demo(). */
export function describeAnchor(a: ReviewAnchor | undefined): string {
  if (!a) return "document";
  const raw = (a.exact ?? a.source ?? "").replace(/\s+/g, " ").trim();
  const q = raw ? ` — “${raw.length > 160 ? raw.slice(0, 160) + "…" : raw}”` : "";
  const side = a.side ? ` (${a.side})` : "";
  switch (a.type) {
    case "code-line": return `${a.path}:${a.line}${side}${q}`;
    case "code-range": return `${a.path}:${a.startLine}-${a.endLine}${side}${q}`;
    case "code-file": return `${a.path} (whole file)`;
    case "tree-node": return `step “${a.nodeId ?? ""}”${q}`;
    case "mermaid-node": return `diagram node ${a.nodeId ?? ""}${q}`;
    case "mermaid-edge": return `diagram edge ${a.blockId ?? ""}`;
    case "mermaid-block": return `diagram ${a.blockId ?? ""}`;
    case "text": return `document text${q}`;
    case "patch": return "whole patch";
    default: return (a.path ? `${a.path}${a.line ? `:${a.line}` : ""}` : a.nodeId ?? "document") + q;
  }
}

/** Resolve a review anchor to a 1-based line range in the CURRENT pseudocode markdown, so a delivered
 *  comment points the agent at the exact region to edit IN PLACE — no whole-doc read/rewrite, and the
 *  numbers are fresh (matched against the file as it stands now, never a stale earlier round). Matches
 *  the anchor's quoted selection (`exact`/`source`) against the source, ignoring markdown list/heading
 *  markers and inline emphasis, since the reviewer selects RENDERED text. Returns null when it can't
 *  confidently locate it (the agent falls back to a normal read). Pure; tested in demo(). */
export function locateAnchor(content: string, anchor: ReviewAnchor | undefined): { start: number; end: number } | null {
  const sel = (anchor?.exact ?? anchor?.source ?? "").trim();
  if (!sel) return null;
  const norm = (s: string) => s.replace(/^[\s>#*\-+.\d)]+/, "").replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const fileLines = content.split("\n").map(norm);
  const selLines = sel.split("\n").map(norm).filter((l) => l.length >= 4);
  if (!selLines.length) return null;
  const first = selLines[0];
  let start = -1;
  for (let i = 0; i < fileLines.length; i++) {
    const l = fileLines[i];
    if (l.length >= 4 && (l.includes(first) || first.includes(l))) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = start; // extend forward for a multi-line selection
  for (let k = 1; k < selLines.length && end + 1 < fileLines.length; k++) {
    const nxt = fileLines[end + 1];
    if (nxt.length >= 4 && (nxt.includes(selLines[k]) || selLines[k].includes(nxt))) end++;
    else break;
  }
  return { start: start + 1, end: end + 1 };
}

/** The four `## ` sections the review renderer (Co-Review's design-doc format) recognizes, matched on
 *  the EXACT lowercased heading. Anything else — a different heading, a parenthetical suffix
 *  (`## Design (notes)` !== `design`) — is SILENTLY DROPPED along with the prose/mermaid beneath it,
 *  so a non-conforming artifact renders as an empty tree with no diagrams. Keep in lockstep with
 *  Co-Review's design-doc section keys (Context, Design, Diagrams, Open Questions). */
const PSEUDO_SECTIONS: Record<string, true> = { context: true, design: true, diagrams: true, "open questions": true };

/** Verify a `.pseudocode.md` will actually render in the review view. Pure; tested in demo().
 *  Hard-fails on: no H1 title; missing/empty `## Context`, `## Design`, or `## Open Questions`;
 *  a `## Diagrams` with no mermaid fence; or ANY heading outside the recognized four (the renderer
 *  drops it). Returns every problem so the human sees exactly what to fix instead of a blank page. */
export function validatePseudocode(md: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const lines = md.split("\n");

  if (!lines.some((l) => /^#[ \t]+\S/.test(l)))
    problems.push("missing an H1 title (e.g. '# Feature: <name>')");

  // Collect ## headings (exact, lowercased) and their bodies.
  const sections = new Map<string, string[]>();
  let cur: string | null = null;
  const unknown: string[] = [];
  for (const line of lines) {
    const m = line.match(/^##[ \t]+(.+?)[ \t]*$/);
    if (m) {
      const key = m[1].toLowerCase();
      cur = key;
      sections.set(key, []);
      if (!PSEUDO_SECTIONS[key]) unknown.push(m[1].trim());
    } else if (cur !== null) {
      sections.get(cur)!.push(line);
    }
  }

  if (unknown.length)
    problems.push(
      "section(s) the renderer DROPS (it shows only Context/Design/Diagrams/Open Questions, matched exactly): " +
        unknown.map((h) => `\"## ${h}\"`).join(", ") +
        " — fold their content INLINE into the Design list (decisions as ✎/?/⚠ bullets) or rename to a recognized section (no parenthetical suffix)",
    );

  const context = sections.get("context");
  if (!context) problems.push("no '## Context' section — the review page needs the domain summary above the tree");
  else if (!context.some((l) => /\S/.test(l))) problems.push("'## Context' is empty — add a short domain summary");

  const design = sections.get("design");
  if (!design) problems.push("no '## Design' section — the altitude tree will be empty");
  else if (!design.some((l) => /^[ \t]*-[ \t]+\S/.test(l)))
    problems.push("'## Design' has no '- ' bullets — it must be a nested markdown list (L1→L3)");

  const questions = sections.get("open questions");
  if (!questions) problems.push("no '## Open Questions' section — include it even when the answer is '- None.'");
  else if (!questions.some((l) => /\S/.test(l)))
    problems.push("'## Open Questions' is empty — say '- None.' when there are no open questions");

  const diagrams = sections.get("diagrams");
  if (diagrams && !diagrams.some((l) => /^```mermaid/.test(l.trim())))
    problems.push("'## Diagrams' present but contains no ```mermaid block");

  return { ok: problems.length === 0, problems };
}
/** POSIX cksum CRC (poly 0x04C11DB7, length appended, final complement) —
 *  must match the system `cksum` binary exactly so repo keys stay stable — demo() guards it. */
function posixCksum(data: string): number {
  const bytes = Buffer.from(data, "utf8");
  let crc = 0;
  const step = (b: number) => {
    crc ^= b << 24;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
  };
  for (const b of bytes) step(b);
  for (let len = bytes.length; len > 0; len >>>= 8) step(len & 0xff);
  return ~crc >>> 0;
}

/** Main repo root from any worktree (parent of --git-common-dir), or null.
 *  Realpath (resolve symlinks) BEFORE taking the parent, or the repo-key cksum shifts on any
 *  symlinked path (macOS /tmp→/private/tmp, worktrees under /var/folders) and state stops resolving. */
function repoRoot(cwd: string): string | null {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return path.dirname(fs.realpathSync(path.resolve(cwd, common)));
  } catch {
    return null;
  }
}

/** Repo key: basename + POSIX cksum of the absolute root path. */
function repoStateDir(cwd: string): string | null {
  const root = repoRoot(cwd);
  if (!root) return null;
  return path.join(STATE_ROOT, `${path.basename(root)}-${posixCksum(root)}`);
}

function readStates(dir: string): RxState[] {
  let names: string[];
  try {
    // Ticket states are `<ticket>.json`; Co-Review writes `<ticket>.review.json` review-state sidecars
    // in the same dir — never read those as pipelines or the panel shows a bogus "rx undefined".
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.endsWith(".review.json"));
  } catch {
    return [];
  }
  const out: RxState[] = [];
  for (const n of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as RxState;
      // Belt-and-suspenders: a real ticket state always carries a string ticket + phase. Skips
      // any stray/non-state json so it can never surface as an "rx undefined" panel row.
      if (s && typeof s.ticket === "string" && typeof s.phase === "string") out.push(s);
    } catch {
      // ignore partially-written files (bash side uses mv, but be safe)
    }
  }
  return out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

function statePath(dir: string, ticket: string): string {
  return path.join(dir, `${ticket}.json`);
}

// --- State layer — the plugin OWNS all state mutation; no bash lib exists (ported from the retired
// rx-lib.sh). JSON schema, paths, atomic tmp+rename writes, ISO-Z timestamps.

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Synchronous sleep without spawning a process (blocks only this thread). */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Serialize read-modify-write cycles on one state file across sessions/processes (the watcher tick
 *  and the driving session can both patch a ticket). `wx` lockfile; a lock older than 10s is treated
 *  as stale (crashed holder) and broken; after 5s of contention we proceed unlocked rather than wedge
 *  the pipeline. `<ticket>.json.lock` never matches readStates' `.json` filter. */
function withStateLock<T>(p: string, fn: () => T): T {
  const lock = `${p}.lock`;
  const deadline = Date.now() + 5000;
  let held = false;
  while (!held) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      held = true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between attempts — retry immediately
      }
      if (Date.now() > deadline) break;
      sleepMs(25);
    }
  }
  try {
    return fn();
  } finally {
    if (held) fs.rmSync(lock, { force: true });
  }
}

/** Atomic write of a state object (tmp + rename). */
function writeState(p: string, s: RxState): void {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, p);
}

/** rx_init: create the state file at phase=started. Returns the created state. */
function initState(dir: string, ticket: string, branch: string, worktree: string): RxState {
  fs.mkdirSync(dir, { recursive: true });
  const now = nowIso();
  const s: RxState = {
    ticket,
    branch,
    worktree,
    phase: "started",
    pseudocode: null,
    openspec_change: null,
    test_plan: null,
    pr_number: null,
    session_id: null,
    session_file: null,
    created_at: now,
    updated_at: now,
    log: [],
  } as unknown as RxState;
  writeState(statePath(dir, ticket), s);
  return s;
}

/** rx_set / rx_set_raw: assign fields (string or JSON), stamp updated_at. Returns the new state. */
function setFields(dir: string, ticket: string, patch: Record<string, unknown>): RxState {
  const p = statePath(dir, ticket);
  return withStateLock(p, () => {
    const s = JSON.parse(fs.readFileSync(p, "utf8")) as RxState;
    Object.assign(s, patch);
    s.updated_at = nowIso();
    writeState(p, s);
    return s;
  });
}

/** rx_log: append a timestamped audit entry. */
function logEvent(dir: string, ticket: string, event: string, note: string): void {
  const p = statePath(dir, ticket);
  withStateLock(p, () => {
    const s = JSON.parse(fs.readFileSync(p, "utf8")) as RxState;
    (s.log ??= []).push({ at: nowIso(), event, note });
    s.updated_at = nowIso();
    writeState(p, s);
  });
}

/** rx_deviation: append one JSONL line to the per-repo deviation log (OUTSIDE the repo). */
function writeDeviation(dir: string, ticket: string, rec: { source: string; kind: string; note: string; context: string; reasoning: string }): void {
  const f = path.join(os.homedir(), ".claude", "workflow", "deviations", `${path.basename(dir)}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const phase = readStates(dir).find((s) => s.ticket === ticket)?.phase ?? "";
  const line = JSON.stringify({ at: nowIso(), ticket, phase, source: rec.source, kind: rec.kind, note: rec.note, context: rec.context, reasoning: rec.reasoning });
  fs.appendFileSync(f, line + "\n");
}

// OpenSpec store — a personal per-repo store, namespaced by the SAME repo key (path.basename(dir)) as
// the state dir, so the plugin and any external `openspec --store` call resolve the SAME store. The
// store id is the key kebab-cased.
function openspecDir(dir: string): string {
  return path.join(os.homedir(), ".claude", "workflow", "openspec", path.basename(dir));
}
function openspecStore(dir: string): string {
  return path.basename(dir).toLowerCase().replace(/[_\s]+/g, "-").replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "");
}

// Disposable per-ticket artifact dir Co-Review opens as its review directory (the
// `*.pseudocode.md` design doc, plus any `*.diff`/`*.patch` and assets it references). OUT of the
// target repo (invariant #1), namespaced by the SAME repo key as state/openspec, swept at /rx-cleanup.
function artifactsDir(dir: string, ticket: string): string {
  return path.join(os.homedir(), ".claude", "workflow", "artifacts", path.basename(dir), ticket);
}

/** PRP is retired in Rx. Reject repo-local PRP-style artifact paths so a stale skill/prompt can't
 *  silently route design or implementation through the wrong contract. */
function isPrpArtifactPath(p: string | null | undefined): boolean {
  return !!p && /(^|[\\/])PRPs?(?:[\\/]|$)/i.test(p);
}

// --- Design review delta. On a RE-review (rework loop or a post-approval revision), the reviewer must
// see WHAT CHANGED in the pseudocode design on top of what they already approved — not re-read the whole
// plan. We snapshot the pseudocode when it's approved, and before each /rx-review render a unified diff
// (approved → current) into the reviewed artifact dir; Co-Review picks up *.diff and shows it as a labeled
// tab beside the plan. No baseline (never approved) or no change → no tab. Best-effort.

/** Resolve a ticket's pseudocode artifact to an absolute path (mirrors /rx-review's own resolution). */
function resolvePseudocodePath(st: RxState): string | null {
  if (!st.pseudocode) return null;
  return path.isAbsolute(st.pseudocode) ? st.pseudocode : path.join(st.worktree || repoRoot(process.cwd()) || process.cwd(), st.pseudocode);
}

/** Snapshot the just-approved pseudocode as the baseline for future design-delta diffs, and clear any
 *  stale delta (a fresh approval has no pending changes). Silent best-effort. */
function snapshotApprovedDesign(st: RxState): void {
  try {
    const cur = resolvePseudocodePath(st);
    if (!cur || !fs.existsSync(cur)) return;
    const d = path.dirname(cur);
    fs.copyFileSync(cur, path.join(d, `${st.ticket}.pseudocode.approved.md`));
    fs.rmSync(path.join(d, `${st.ticket}.design-changes.diff`), { force: true });
    fs.rmSync(path.join(d, `${st.ticket}.design-changes.md`), { force: true });
  } catch {
    /* best-effort */
  }
}

/** Refresh the "design changes since approved" delta in the review dir (the dir holding `artifact`):
 *  a unified diff of the approved baseline → the current pseudocode, plus a titled sidecar so the review
 *  server labels the tab. Removes both when there's no baseline (never approved) or no change, so the
 *  reviewer sees a delta tab ONLY when the design actually moved on top of what they approved. */
function refreshDesignDelta(artifact: string, ticket: string, designRev: number): void {
  try {
    if (!fs.existsSync(artifact)) return;
    const d = path.dirname(artifact);
    const approved = path.join(d, `${ticket}.pseudocode.approved.md`);
    const diffPath = path.join(d, `${ticket}.design-changes.diff`);
    const sidecar = path.join(d, `${ticket}.design-changes.md`);
    const clear = () => {
      fs.rmSync(diffPath, { force: true });
      fs.rmSync(sidecar, { force: true });
    };
    if (!fs.existsSync(approved)) return clear(); // never approved → the plan itself is the whole review
    let out = "";
    try {
      out = execFileSync("diff", ["-u", "-L", `a/${ticket}.design.md`, "-L", `b/${ticket}.design.md`, approved, artifact], { encoding: "utf8" });
    } catch (e) {
      // diff exits 1 when files differ — its stdout IS the unified diff payload, not an error.
      if (e && typeof e === "object" && "stdout" in e && e.stdout != null) out = String(e.stdout);
    }
    if (!out.trim()) return clear(); // identical → nothing to show
    fs.writeFileSync(diffPath, out);
    fs.writeFileSync(sidecar, `title: Design changes since approved (rev ${designRev})\n`);
  } catch {
    /* best-effort */
  }
}

// --- PR watcher lifecycle (Herd-native) & teardown. The plugin OWNS these mechanics so stage playbooks
// call ONE tool instead of re-emitting fragile bash. The watcher is a self-scheduling LOOP running in a
// Herdr pane in the ticket's Space: the loop IS the scheduler (it survives this session and omp exiting),
// and each tick it runs a cheap `gh` pre-check and only then wakes a fresh, disposable `omp -p` worker on
// the bundled watcher.md. No daemon, no cron, no Paseo — the loop ends only when the PR settles (the tick
// agent drops a stop sentinel), the 14-day deadline passes, or /rx-cleanup closes the tab. It ticks only
// while the Herd server is up; a reboot is recovered by ensureWatch's reconcile on the next /rx pr-open
// landing. All shell-outs are best-effort with short timeouts; they degrade rather than throw.

/** Run a CLI, return trimmed stdout; throws on non-zero exit (callers catch). */
function runCli(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 20000, cwd, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** True if `tab` is still a live tab in workspace `ws` (self-heal check: a closed/relaunched Space or a
 *  manually-closed tab loses it, so the next reconcile recreates the watcher). */
function watchTabAlive(ws: string, tab: string): boolean {
  try {
    const out = JSON.parse(runCli("herdr", ["tab", "list", "--workspace", ws])) as { result?: { tabs?: { tab_id?: string }[] } };
    return (out.result?.tabs ?? []).some((t) => t.tab_id === tab);
  } catch {
    return false;
  }
}

/** Render the bundled watcher.md with this ticket's tokens and write it — plus the loop DRIVER script —
 *  into the ticket's disposable artifact dir. The driver is the scheduler: the LOOP owns the settle-stop
 *  (a gh-confirmed MERGED/CLOSED, not the agent), so a transient gh error never terminates the watcher.
 *  Each cadence it snapshots the PR (review threads + PR comments + review bodies) and joins it with the
 *  durable disposition ledger (`<state>/<ticket>.watch.jsonl`) via `workflow/watch-items.jq`, prints the
 *  items table in the pane, and wakes a fresh `omp -p` worker only for CI red / conflict / an item owed
 *  handling. After every tick it re-checks: an owed item with neither a reply nor a recorded disposition
 *  is logged `unhandled` and re-asked hourly. The agent replies/records through the driver's own
 *  `reply`/`record` subcommands, so the marker + ledger line are never left to the model. Returns the
 *  driver path the watch pane runs. */
function writeWatchDriver(dir: string, ticket: string, s: RxState, worktree: string): string {
  const art = artifactsDir(dir, ticket);
  fs.mkdirSync(art, { recursive: true });
  const pr = String(s.pr_number ?? "");
  const wf = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workflow");
  const driverPath = path.join(art, `${ticket}.watch.sh`);
  const itemsPath = path.join(art, `${ticket}.watch-items.json`);
  const prompt = fs
    .readFileSync(path.join(wf, "watcher.md"), "utf8")
    .replaceAll("{{TICKET}}", ticket)
    .replaceAll("{{PR}}", pr)
    .replaceAll("{{WORKTREE}}", worktree)
    .replaceAll("{{WORKSPACE}}", s.herdr_workspace || "none")
    .replaceAll("{{DRIVER}}", driverPath)
    .replaceAll("{{ITEMS}}", itemsPath);
  const promptPath = path.join(art, `${ticket}.watcher.md`);
  fs.writeFileSync(promptPath, prompt);
  const driver = `#!/usr/bin/env bash
# rx PR watcher — ${ticket} (PR #${pr}). The loop is the scheduler; omp -p is the disposable per-tick worker.
#   $0               run the loop
#   $0 show          snapshot the PR and print the items table
#   $0 reply <key> fixed|replied "<body>"          post a marked reply + record it
#   $0 record <key> human|rework|skip "<why>"      record a disposition without replying
set -u
WT=${JSON.stringify(worktree)}
PR=${JSON.stringify(pr)}
PROMPT=${JSON.stringify(promptPath)}
ITEMS_JQ=${JSON.stringify(path.join(wf, "watch-items.jq"))}
LEDGER=${JSON.stringify(path.join(dir, `${ticket}.watch.jsonl`))}
SNAP=${JSON.stringify(path.join(art, `${ticket}.watch-snap.json`))}
ITEMS=${JSON.stringify(itemsPath)}
STOP="$WT/.rx-watch-stop"
NUDGE="$WT/.rx-watch-nudge"
cd "$WT" || exit 1
touch "$LEDGER"

record() { jq -nc --arg at "$(date -u +%FT%TZ)" --arg key "$1" --arg action "$2" --arg note "$3" '{at:$at,key:$key,action:$action,note:$note}' >> "$LEDGER"; }

# One GraphQL snapshot of every review surface, joined with the ledger. Non-zero on any gh/jq failure.
refresh() {
  gh api graphql -F owner='{owner}' -F repo='{repo}' -F pr="$PR" \\
    -f query='query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){author{login} comments(last:100){nodes{databaseId author{__typename login} createdAt url body}} reviews(last:100){nodes{databaseId author{__typename login} submittedAt url body}} reviewThreads(first:100){nodes{isResolved path line originalLine head:comments(first:1){nodes{databaseId author{login} createdAt url body}} tail:comments(last:1){nodes{author{login} createdAt body}}}}}}}' \\
    > "$SNAP" 2>/dev/null \\
    && jq --slurpfile ledger "$LEDGER" -f "$ITEMS_JQ" "$SNAP" > "$ITEMS.tmp" && mv "$ITEMS.tmp" "$ITEMS"
}

# Items table: STATUS * = owed now, ! = left for the human (re-asked hourly).
show() {
  [ -s "$ITEMS" ] || { echo "(no review items yet)"; return 0; }
  jq -r '["KEY","BY","WHEN","WHERE","STATUS","ACTION","NOTE / COMMENT"], (.[] | [.key, .by, .at[5:16], .where, (.status + (if .fresh then "*" elif .nudge then "!" else "" end)), .action, ((if .note != "" then .note else .body end) | gsub("[[:space:]]+"; " ") | .[0:70])] | map(if . == "" or . == null then "-" else tostring end)) | @tsv' "$ITEMS" | column -t -s "$(printf '\\t')"
  jq -rs '[.[] | select(.key == "tick")] | last | if . then "last tick: " + .at + " " + .action + " " + .note else "no ticks yet" end' "$LEDGER"
}

case "\${1:-}" in
  record)
    case "\${3:-}" in human|rework|skip) ;; *) echo "usage: $0 record <key> human|rework|skip \\"<why>\\"" >&2; exit 2 ;; esac
    record "$2" "$3" "\${4:-}"; exit 0 ;;
  reply)
    case "\${3:-}" in fixed|replied) ;; *) echo "usage: $0 reply <key> fixed|replied \\"<body>\\"" >&2; exit 2 ;; esac
    body="\${4:-}

<!-- rx-watch -->"
    case "$2" in
      t:*) gh api "repos/{owner}/{repo}/pulls/$PR/comments/\${2#t:}/replies" -f body="$body" > /dev/null ;;
      c:* | r:*) gh pr comment "$PR" --body "$body" > /dev/null ;;
      *) echo "bad key: $2" >&2; exit 2 ;;
    esac || { echo "reply failed; nothing recorded" >&2; exit 1; }
    record "$2" "$3" "$(printf '%s' "\${4:-}" | head -n 1 | cut -c 1-120)"; exit 0 ;;
  show) refresh; show; exit 0 ;;
esac

DEADLINE=$(( $(date +%s) + 336 * 3600 ))   # 14 days, replaces paseo --expires-in
rm -f "$STOP"
WHY=""

run_tick() {
  omp -p --approval-mode yolo --max-time 8m --cwd "$WT" "@$PROMPT"
  local rc=$?
  [ "$rc" -eq 0 ] || echo "(omp tick exited $rc)"
  return "$rc"
}

# gh computes mergeable lazily and first returns UNKNOWN — poll past it to a definitive verdict.
pr_mergeable() {
  local m i
  for i in 1 2 3; do
    m=$(gh pr view "$PR" --json mergeable -q .mergeable 2>/dev/null)
    if [ "$m" = "MERGEABLE" ] || [ "$m" = "CONFLICTING" ]; then echo "$m"; return 0; fi
    sleep 2
  done
  echo "\${m:-UNKNOWN}"
}

# Cheap, no-LLM pre-check for an OPEN PR ($1 = 1 when this cadence's snapshot is fresh).
should_tick() {
  gh pr checks "$PR" 2>/dev/null | grep -qiE 'fail|error' && { WHY="ci-red"; return 0; }
  [ "$(pr_mergeable)" != "MERGEABLE" ] && { WHY="conflict"; return 0; }   # agent runs the git-level merge
  [ "$1" = 1 ] || return 1                                                 # stale snapshot: don't act on it
  [ "$(jq '[.[] | select(.fresh)] | length' "$ITEMS")" -gt 0 ] && { WHY="owed"; return 0; }
  # Items left for the human (asked, no answer) or missed by a tick: re-ask at most hourly.
  if [ "$(jq '[.[] | select(.nudge)] | length' "$ITEMS")" -gt 0 ] && [ -z "$(find "$NUDGE" -mmin -60 2>/dev/null)" ]; then
    WHY="re-ask"; return 0
  fi
  return 1
}

# Run the worker, then the deterministic miss check: every item owed before the tick must now be
# replied/resolved or carry a disposition — otherwise it is recorded "unhandled" (and re-asked hourly).
tick() {
  local t0 rc k
  t0=$(date -u +%FT%TZ)
  touch "$NUDGE"
  run_tick; rc=$?
  record tick "$WHY" "rc=$rc"
  if refresh; then
    for k in $(jq -r '.[] | select(.fresh) | .key' "$ITEMS"); do record "$k" unhandled "tick $t0 left it without reply or disposition"; done
    refresh
  fi
}

while :; do
  clear
  echo "== rx watcher ${ticket} · PR #$PR · $(date -u +%FT%TZ) =="
  # The LOOP owns the settle-stop: only a gh-CONFIRMED MERGED/CLOSED ends the watcher. A transient gh
  # error is NON-fatal (retry next cadence) — it must never stop the watcher (that was the old bug).
  state=$(gh pr view "$PR" --json state -q .state 2>/dev/null); rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "-- gh unavailable (rc=$rc) -> retry next cadence (watcher stays up) --"
  elif [ "$state" = "MERGED" ] || [ "$state" = "CLOSED" ]; then
    echo "-- PR $state -> final notify tick, then exit --"
    run_tick   # let the agent notify the human; the loop owns the stop, so the agent need not
    break
  else
    if refresh; then ok=1; else ok=0; echo "-- PR snapshot failed -> comment checks skipped this cadence --"; fi
    if should_tick "$ok"; then
      echo "-- $WHY -> omp tick --"
      tick
      clear
      echo "== rx watcher ${ticket} · PR #$PR · $(date -u +%FT%TZ) =="
    else
      echo "-- nothing owed; skipping omp tick --"
    fi
    show
  fi
  if [ -f "$STOP" ]; then echo "== stop sentinel -> watcher exiting =="; rm -f "$STOP"; break; fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then echo "== 14d deadline -> watcher exiting =="; break; fi
  sleep 300
done
echo "== rx watcher ${ticket} exited =="
`;
  fs.writeFileSync(driverPath, driver, { mode: 0o755 });
  return driverPath;
}

/** Ensure the PR watcher is running for a ticket (idempotent + self-healing). Reuses a live watch tab if
 *  one already exists (survives a Space relabel); otherwise creates the `rx-watch <ticket>` tab in the
 *  ticket's Space and launches the loop driver in its pane. Records herdr_watch_tab/_pane. No-op outside
 *  Herd, without a herdr_workspace, or before the PR exists. Returns null when it did nothing. */
function ensureWatch(dir: string, ticket: string): { tab: string; pane: string; created: boolean } | null {
  if (process.env.HERDR_ENV !== "1") return null;
  const s = JSON.parse(fs.readFileSync(statePath(dir, ticket), "utf8")) as RxState;
  const ws = s.herdr_workspace || "";
  if (!s.pr_number || !ws) return null;
  if (s.herdr_watch_tab && watchTabAlive(ws, s.herdr_watch_tab)) {
    return { tab: s.herdr_watch_tab, pane: s.herdr_watch_pane || "", created: false };
  }
  const worktree = s.worktree || repoRoot(process.cwd()) || process.cwd();
  const driver = writeWatchDriver(dir, ticket, s, worktree);
  let tab = "";
  let pane = "";
  try {
    const created = JSON.parse(
      runCli("herdr", ["tab", "create", "--workspace", ws, "--label", `rx-watch ${ticket}`, "--cwd", worktree, "--no-focus"]),
    ) as { result?: { tab?: { tab_id?: string }; root_pane?: { pane_id?: string } } };
    tab = created.result?.tab?.tab_id ?? "";
    pane = created.result?.root_pane?.pane_id ?? "";
    if (pane) runCli("herdr", ["pane", "run", pane, `bash ${JSON.stringify(driver)}`]);
  } catch {
    // herdr tab create failed (best-effort) — leave the watcher unstarted; reconcile retries next /rx.
    return null;
  }
  setFields(dir, ticket, { herdr_watch_tab: tab || null, herdr_watch_pane: pane || null });
  logEvent(dir, ticket, "watch-start", `herdr loop in tab ${tab || "?"} (pane ${pane || "?"})`);
  return { tab, pane, created: true };
}

/** Stop a ticket's watcher: close its Herdr watch tab, which kills the loop pane and any in-flight omp
 *  tick. Idempotent — safe if already gone. Returns the actions taken. */
function stopWatch(s: RxState): string[] {
  const done: string[] = [];
  if (process.env.HERDR_ENV === "1" && s.herdr_watch_tab) {
    try {
      runCli("herdr", ["tab", "close", s.herdr_watch_tab]);
      done.push(`herdr watch tab ${s.herdr_watch_tab} closed`);
    } catch {
      done.push("herdr watch tab already gone");
    }
  }
  return done;
}

/** Tear down a merged ticket's runtime: stop the watcher, remove the worktree + local/remote branch,
 *  and delete the disposable artifacts (review store + artifact dir). Best-effort; returns actions. */
function teardown(dir: string, s: RxState): string[] {
  const done = stopWatch(s);
  const root = repoRoot(process.cwd());
  const { ticket, worktree } = s;
  if (root && worktree) {
    try {
      runCli("git", ["worktree", "remove", worktree, "--force"], root);
      done.push(`worktree removed`);
    } catch {
      try {
        runCli("git", ["worktree", "remove", `.worktrees/${ticket}`, "--force"], root);
        done.push("worktree removed");
      } catch {
        done.push("worktree already gone");
      }
    }
    try {
      runCli("git", ["worktree", "prune"], root);
    } catch {
      /* ignore */
    }
    try {
      runCli("git", ["branch", "-D", ticket], root);
      done.push(`branch ${ticket} deleted`);
    } catch {
      done.push("local branch already gone");
    }
    try {
      runCli("git", ["push", "origin", "--delete", ticket], root);
      done.push("remote branch deleted");
    } catch {
      done.push("remote branch already gone (auto-delete on merge)");
    }
  }
  try {
    fs.rmSync(path.join(dir, `${ticket}.review.json`), { force: true });
    fs.rmSync(path.join(dir, `${ticket}.review.log`), { force: true });
    fs.rmSync(artifactsDir(dir, ticket), { recursive: true, force: true });
    done.push("artifacts swept");
  } catch {
    /* ignore */
  }
  return done;
}

/** Aggregate this repo's deviation log into counts by source/kind and phase, plus the entries. */
function aggregateDeviations(dir: string, ticket?: string): { file: string; total: number; byKind: Record<string, number>; byPhase: Record<string, number>; entries: Record<string, unknown>[] } {
  const file = path.join(os.homedir(), ".claude", "workflow", "deviations", `${path.basename(dir)}.jsonl`);
  let entries: Record<string, unknown>[] = [];
  try {
    entries = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);
  } catch {
    /* no log yet */
  }
  if (ticket) entries = entries.filter((e) => e.ticket === ticket);
  const byKind: Record<string, number> = {};
  const byPhase: Record<string, number> = {};
  for (const e of entries) {
    const k = `${e.source ?? "?"}/${e.kind ?? "?"}`;
    byKind[k] = (byKind[k] ?? 0) + 1;
    const p = String(e.phase ?? "-");
    byPhase[p] = (byPhase[p] ?? 0) + 1;
  }
  return { file, total: entries.length, byKind, byPhase, entries };
}
// --- Worktree setup (skill://using-git-worktrees). Owned by the plugin so /rx-start calls one tool:
// resolve the MAIN repo root (works from any cwd/worktree), verify .worktrees/ is git-ignored, and
// create/reuse .worktrees/<ticket> on branch <ticket> off origin/main. Deterministic, best-effort.

/** True when the repo has an `origin` remote. The sanctioned "self-hosting" case — no origin (often
 *  a personal/local-only checkout, sometimes the very repo omp loaded this plugin from) — is NOT an
 *  error: every base-ref/ground/delivery step below falls back to local `main` with a loud note
 *  instead of hard-stopping or improvising a one-off "commit to main" each run. */
function hasOriginRemote(root: string): boolean {
  try {
    execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Pure: which ref to branch/ground/merge against. Extracted so demo() can pin the self-hosting
 *  fallback without a git repo. */
export function baseRef(hasOrigin: boolean): string {
  return hasOrigin ? "origin/main" : "main";
}

/** Ensure `.worktrees/` is git-ignored at the repo root; add + commit it if not (skill safety step).
 *  Returns a note when it changed the repo, "" when already ignored. */
function ensureWorktreesIgnored(root: string): string {
  try {
    execFileSync("git", ["check-ignore", "-q", ".worktrees"], { cwd: root, stdio: "ignore" });
    return "";
  } catch {
    try {
      const gi = path.join(root, ".gitignore");
      const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
      if (!/^\.worktrees\/?$/m.test(cur)) fs.writeFileSync(gi, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}.worktrees/\n`);
      runCli("git", ["add", ".gitignore"], root);
      runCli("git", ["commit", "-m", "chore: gitignore .worktrees"], root);
      return "added .worktrees/ to .gitignore";
    } catch (e) {
      return `WARN: could not git-ignore .worktrees (${e instanceof Error ? e.message : e})`;
    }
  }
}

/** Create (or reuse) the ticket's isolated worktree at <root>/.worktrees/<ticket> on branch <ticket>,
 *  based on origin/main — or local `main` when self-hosted (no origin remote). Idempotent: reuses a
 *  matching worktree; refuses a conflicting branch. */
function ensureWorktree(root: string, ticket: string): { path: string; branch: string; created: boolean; gitignore: string; selfHosted: boolean } {
  const gitignore = ensureWorktreesIgnored(root);
  const selfHosted = !hasOriginRemote(root);
  const wtPath = path.join(root, ".worktrees", ticket);
  let listed = "";
  try {
    listed = runCli("git", ["worktree", "list", "--porcelain"], root);
  } catch {
    /* no worktrees registered yet */
  }
  if (listed.includes(`branch refs/heads/${ticket}`)) {
    if (fs.existsSync(wtPath)) return { path: fs.realpathSync(wtPath), branch: ticket, created: false, gitignore, selfHosted };
    throw new Error(`branch ${ticket} already has a worktree elsewhere — resolve it first (git worktree list).`);
  }
  let branchExists = false;
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${ticket}`], { cwd: root, stdio: "ignore" });
    branchExists = true;
  } catch {
    branchExists = false;
  }
  if (branchExists) throw new Error(`local branch ${ticket} already exists — delete it or use a fresh ticket.`);
  runCli("git", ["worktree", "add", wtPath, "-b", ticket, baseRef(!selfHosted)], root);
  return { path: fs.realpathSync(wtPath), branch: ticket, created: true, gitignore, selfHosted };
}

/** Read the review-state file ({ticket}.review.json) Co-Review writes (open_review's storePath): submit round, verdict,
 *  free-text summary, and every open thread rendered as one actionable line. */
function readReviewState(dir: string, ticket: string): { round: number; verdict: string; summary: string; openComments: string[] } {
  let s: ReviewStore;
  try {
    s = JSON.parse(fs.readFileSync(path.join(dir, `${ticket}.review.json`), "utf8")) as ReviewStore;
  } catch {
    return { round: 0, verdict: "", summary: "", openComments: [] };
  }
  const openComments = (s.threads ?? [])
    .filter((t) => t.status === "open")
    .map((t) => {
      const a = t.anchor;
      const loc = a?.path ? `${a.path}${a.line ? `:${a.line}` : a.startLine ? `:${a.startLine}` : ""}` : a?.nodeId ?? "document";
      const body = t.messages?.[t.messages.length - 1]?.body ?? "";
      return `- [${t.severity ?? "?"}] ${loc} — ${body}`;
    });
  return {
    round: Number(s.review?.count ?? 0),
    verdict: String(s.review?.decision ?? ""),
    summary: String(s.review?.summary ?? ""),
    openComments,
  };
}

/** Any pipeline id: Linear/Jira ticket (ENG-1234, PROJ-56), GitHub issue (gh-123, #123),
 *  or a free-text task's kebab-case id (add-retry-webhook-sender; older ones carry task-/rx-/flow-). */
const PIPELINE_ID = /^(?:[A-Za-z0-9_]+-[0-9]+|gh-[0-9]+|#[0-9]+|(?!\.+\/)[a-zA-Z0-9_.]+\/(?!\.+#)[a-zA-Z0-9_.]+#\d+|[a-z0-9][a-z0-9-]{0,47})$/;

/** The plugin's own directory (bundled stages/, sources/, workflow/). */
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A ticket source: how to recognise what the user typed and how to fetch its story. A markdown file
 *  with frontmatter — `name`, `match` (regexes tried on the first word), `flags`, `id` (template over
 *  the regex groups, default `$1`), `case` (upper/lower) — and a prompt body that /rx-start runs as its
 *  requirement step, with `$ID`, `$REF` (what the user typed) and `$1`…`$9` filled in. Linear and
 *  GitHub ship as sources/*.md; a team adds Jira, GitLab, Notion… the same way. */
export type TicketSource = { name: string; description: string; match: RegExp[]; id: string; idCase: string; body: string; file: string };

const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, "$2");

/** Parse one source file (no YAML dependency: `key: value` lines and `- item` lists). Null when it has
 *  no frontmatter; an invalid regex is skipped, not fatal. Pure; tested in demo(). */
export function parseSource(text: string, file: string): TicketSource | null {
  const m = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string | string[]> = {};
  let listKey = "";
  for (const line of m[1].split("\n")) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      (meta[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    listKey = kv[2].trim() === "" ? kv[1] : "";
    meta[kv[1]] = listKey ? [] : unquote(kv[2]);
  }
  const flags = String(meta.flags ?? "").replace(/[^imsu]/g, "");
  const match: RegExp[] = [];
  for (const p of Array.isArray(meta.match) ? meta.match : meta.match ? [meta.match] : []) {
    try {
      match.push(new RegExp(p, flags));
    } catch {
      /* invalid pattern: skipped */
    }
  }
  return {
    name: String(meta.name ?? path.basename(file, ".md")),
    description: String(meta.description ?? ""),
    match,
    id: String(meta.id ?? "$1"),
    idCase: String(meta.case ?? ""),
    body: m[2].trim(),
    file,
  };
}

/** The user's Rx config dir: `$XDG_CONFIG_HOME/rx`, else `~/.config/rx`. */
function userConfigDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "rx");
}

/** Where sources are looked up, highest precedence first: the repo's `.rx/sources` (committed, shared
 *  by a team), the user's `~/.config/rx/sources`, then the ones bundled with Rx. */
function sourceDirs(repo: string | null): string[] {
  return [...(repo ? [path.join(repo, ".rx", "sources")] : []), path.join(userConfigDir(), "sources"), path.join(PLUGIN_DIR, "sources")];
}

/** Every source in `dirs`, highest precedence first; a name in a higher dir hides the same name below
 *  (so a team can replace the bundled linear source). Read fresh each call — they're tiny. */
export function loadSources(dirs: string[]): TicketSource[] {
  const out: TicketSource[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(d).filter((n) => n.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const f = path.join(d, n);
      let src: TicketSource | null = null;
      try {
        src = parseSource(fs.readFileSync(f, "utf8"), f);
      } catch {
        /* unreadable: skipped */
      }
      if (src && !seen.has(src.name)) {
        seen.add(src.name);
        out.push(src);
      }
    }
  }
  return out;
}

/** Match the first word the user typed against the sources in order: the source and the pipeline id
 *  its `id` template builds. Null = free text. Pure; tested in demo(). */
export function matchSource(tok: string, sources: TicketSource[]): { source: TicketSource; id: string } | null {
  if (!tok) return null;
  for (const source of sources)
    for (const re of source.match) {
      const m = tok.match(re);
      if (!m) continue;
      const id = applyCase(source.id.replace(/\$(\d)/g, (_, i) => m[+i] ?? ""), source.idCase);
      if (PIPELINE_ID.test(id)) return { source, id };
    }
  return null;
}

/** Per-repo / per-user Rx settings — `.rx/config.yml` in the repo over `~/.config/rx/config.yml`,
 *  plain `key: value` lines:
 *    tickets: jira               your default ticketing system (a source name; default linear)
 *    ticket_shape: ^(PAY|OPS)-\d+$   what a bare ticket id looks like here (case-insensitive; the id is
 *                                     its `(?<id>…)` group if any, else the whole match) */
export type RxConfig = { tickets?: string; ticket_shape?: string };

/** The bare-id shape when none is configured: KEY-123 (Linear, Jira, Shortcut-style keys). */
const DEFAULT_TICKET_SHAPE = "^[A-Za-z][A-Za-z0-9_]*-\\d+$";

export function parseConfig(text: string): RxConfig {
  const out: Record<string, string> = {};
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    // A ` # …` tail is a comment; a `#` with no space before it is data (`ticket_shape: ^#(?<id>\d+)$`).
    const kv = line.replace(/\s+#.*$/, "").match(/^([A-Za-z_]+):\s*(.*?)\s*$/);
    if (kv && kv[2] && !kv[2].startsWith("#")) out[kv[1]] = unquote(kv[2]);
  }
  return out;
}

/** `text` with `key: value` set: the key's line replaced in place, appended when absent, dropped when
 *  `value` is empty; every other line kept. Null when `parseConfig` would read the value back
 *  differently (a ` #` tail, a newline, surrounding quotes) — refuse rather than invent quoting.
 *  Pure; tested in demo(). */
export function setConfigValue(text: string, key: keyof RxConfig, value: string): string | null {
  const lines = text ? text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
  let done = false;
  const out = lines.flatMap((l) => (l.match(/^([A-Za-z_]+):/)?.[1] !== key ? [l] : value && !done ? ((done = true), [`${key}: ${value}`]) : []));
  if (value && !done) out.push(`${key}: ${value}`);
  const next = out.length ? `${out.join("\n")}\n` : "";
  return (parseConfig(next)[key] ?? "") === value ? next : null;
}

function readConfig(repo: string | null): RxConfig {
  const files = [path.join(userConfigDir(), "config.yml"), ...(repo ? [path.join(repo, ".rx", "config.yml")] : [])];
  let out: RxConfig = {};
  for (const f of files) {
    try {
      out = { ...out, ...parseConfig(fs.readFileSync(f, "utf8")) };
    } catch {
      /* absent */
    }
  }
  return out;
}

/** What ticket (if any) the first word the user typed names. The default ticketing system's own
 *  patterns (URLs…) come first. A bare id belongs to the default system: a `ticket_shape` you configured
 *  is tried next, before every other source (so `#123` can mean GitLab); the built-in KEY-123 shape is
 *  tried last (so `gh-123` stays GitHub). Null = free text. Pure; tested in demo(). */
export function resolveTicket(tok: string, sources: TicketSource[], cfg: RxConfig): { source: TicketSource; id: string } | null {
  if (!tok) return null;
  const def = sources.find((s) => s.name === (cfg.tickets || "linear"));
  const others = sources.filter((s) => s !== def);
  const bare = (): { source: TicketSource; id: string } | null => {
    if (!def) return null;
    let shape: RegExp;
    try {
      shape = new RegExp(cfg.ticket_shape || DEFAULT_TICKET_SHAPE, "i");
    } catch {
      return null; // invalid shape: no bare ids
    }
    const m = tok.match(shape);
    if (!m) return null;
    // The id is the shape's `(?<id>…)` group when it has one (`^#(?<id>\d+)$` → 123), else the whole match.
    const id = applyCase(def.id.replace(/\$(\d)/g, () => m.groups?.id ?? m[0]), def.idCase);
    return PIPELINE_ID.test(id) ? { source: def, id } : null;
  };
  return (
    (def ? matchSource(tok, [def]) : null) ??
    (cfg.ticket_shape ? bare() ?? matchSource(tok, others) : matchSource(tok, others) ?? bare())
  );
}

function applyCase(id: string, c: string): string {
  return c === "upper" ? id.toUpperCase() : c === "lower" ? id.toLowerCase() : id;
}

/** A source's prompt for one ticket: `$ID`, `$REF` and the regex groups `$1`…`$9` (re-matched from
 *  `$REF`) filled in. Pure; tested in demo(). */
export function renderSource(source: TicketSource, id: string, ref: string): string {
  const m = source.match.map((re) => ref.match(re)).find(Boolean);
  return source.body.replace(/\$(ID|REF|\d)/g, (_, k: string) => (k === "ID" ? id : k === "REF" ? ref : (m?.[+k] ?? "")));
}

/** `/rx <word>` runs the stage instead of starting a task called "<word>"; the NOTE_STAGES also take
 *  trailing notes (`/rx reject too broad`). `improve`/`start` are left out — they read as task text. */
const STAGE_WORDS = new Set(["approve", "reject", "pr", "cleanup", "abort", "rework", "status", "review", "retro"]);
const NOTE_STAGES = new Set(["reject", "rework", "abort"]);

/** Filler words left out of a free-text task's id and ignored when comparing two task texts. */
const SLUG_STOPWORDS = new Set(
  "a an the to of for and or in on at by with from into onto is are be it its this that these those please so as".split(" "),
);

/** A task text's meaningful words, lowercased (all words when every one is filler). */
function taskWords(text: string): string[] {
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const kept = words.filter((w) => !SLUG_STOPWORDS.has(w));
  return kept.length ? kept : words;
}

/** Short, readable id for a free-text task — its first four meaningful words, kebab-case, no prefix
 *  ("add retry to the webhook sender" → "add-retry-webhook-sender"). It names the branch, the worktree
 *  and the Space, so it stays short. Pure; tested in demo(). */
export function slugId(text: string): string {
  return taskWords(text).slice(0, 4).join("-").slice(0, 40).replace(/-+$/, "") || "task";
}

/** Two free-text tasks are the same task when their meaningful words match (rewording filler —
 *  "the", "to" — doesn't start a duplicate pipeline). Pure; tested in demo(). */
export function sameTask(a: string, b: string): boolean {
  return taskWords(a).join(" ") === taskWords(b).join(" ");
}

/** The id for a free-text task in this repo: an active pipeline (or a start that was interrupted before
 *  its state existed) for the same task is reused; otherwise the first free id of `slug`, `slug-2`, …
 *  (an id is never reused for a different or finished task). */
function textTaskId(dir: string, text: string): { id: string; existing: boolean } {
  const base = slugId(text);
  const states = new Map(readStates(dir).map((s) => [s.ticket, s]));
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    const st = states.get(id);
    if (!st) {
      const pending = readIntake(dir, id);
      if (!pending || sameTask(pending.requirement ?? pending.source_ref, text)) return { id, existing: false };
      continue;
    }
    if (st && isActive(st) && sameTask(st.requirement ?? st.source_ref ?? "", text)) return { id, existing: true };
  }
}

/** What the user asked for, recorded by the dispatcher before /rx-start runs and folded into the new
 *  state by rx_init — so a free-text requirement is never lost to an interrupted start. */
type Intake = { source: string; source_ref: string; requirement?: string };

function intakePath(dir: string, ticket: string): string {
  return path.join(dir, `${ticket}.intake`);
}

function writeIntake(dir: string, ticket: string, intake: Intake): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(intakePath(dir, ticket), JSON.stringify(intake));
}

function readIntake(dir: string, ticket: string): Intake | null {
  try {
    return JSON.parse(fs.readFileSync(intakePath(dir, ticket), "utf8")) as Intake;
  } catch {
    return null;
  }
}

/** Best-effort cross-process mutex so two panes racing a bare `/rx` fan-out at the same instant
 *  never both `workspace create` a duplicate Space for the same ticket — the loser would leave an
 *  orphaned Space whose label nobody ever updates again (state.herdr_workspace now points at the
 *  winner's id, so the loser's own `currentTicket` ws-ownership check permanently fails for it) —
 *  this is the concrete mechanism behind "rx names different Herdr Spaces for the same ticket" /
 *  "the Space name goes stale". Exclusive-create a lockfile (`wx`) holding a random token; the
 *  holder removes it in `finally` ONLY if it still carries that exact token (so a lock we don't
 *  own — because we never acquired it, or someone else's cleanup already ran — is never touched).
 *
 *  Deliberately NEVER auto-steals or auto-deletes a lock we don't hold, including one left behind
 *  by a crashed process — any "is the holder actually dead" check (PID liveness, mtime staleness)
 *  is itself unlink-then-recreate, and two independent contenders can both decide to reap the same
 *  stale-looking lock: A deletes it and wins a fresh acquire, then B — still mid-flight on the
 *  SAME stale read — deletes what is now A's live lock. Wrapping deletion in a second mutex just
 *  moves the identical race onto that mutex (a process can be preempted past any "instant"
 *  critical-section budget, so no timeout is ever a sound proxy for "definitely not the owner").
 *  So: on contention timeout this FAILS CLOSED — returns `null` without calling `fn`, never
 *  proceeding unsynchronized — and a lock abandoned by a genuine crash simply blocks this ticket's
 *  auto-Space-creation until the lockfile is removed by hand (or a future startup maintenance
 *  pass); that's a strictly safer failure mode than ever risking a second `workspace create`.
 *  `deadlineMs`/`pollMs` default to production values; tests shrink them for a fast, deterministic
 *  check of the same code path (see `demo()`). */
function withSpaceLock<T>(
 dir: string,
 ticket: string,
 fn: () => T,
 opts: { deadlineMs?: number; pollMs?: number; log?: (msg: string) => void } = {},
): T | null {
 const { deadlineMs = 8000, pollMs = 200, log } = opts;
 const lockPath = path.join(dir, `.${ticket}.space.lock`);
 const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
 const deadline = Date.now() + deadlineMs;
 for (;;) {
 try {
 fs.writeFileSync(lockPath, token, { flag: "wx" });
 break; // acquired
 } catch {
 if (Date.now() > deadline) {
 log?.(`pi-rx: space lock for ${ticket} contended — skipping, not creating`);
 return null; // fail closed: never race a lock we don't hold
 }
 sleepMs(pollMs);
 }
 }
 try {
 return fn();
 } finally {
 try {
 // Only remove the lock if it's still stamped with OUR token — never delete a lock we don't
 // own (defensive; under normal operation nothing else can write here while we hold it).
 if (fs.readFileSync(lockPath, "utf8") === token) fs.rmSync(lockPath, { force: true });
 } catch {
 /* already gone */
 }
 }
}

export default async function piRx(pi: ExtensionAPI) {
  // Tool schemas are TypeBox, which both hosts speak: omp injects its shim as `pi.typebox`; pi provides
  // the `typebox` package to extensions.
  const Type = ((pi as any).typebox?.Type ?? (await import("typebox")).Type) as any;
  // A string enum as plain JSON Schema (`{type: string, enum}`), which every model provider accepts.
  const stringEnum = (values: readonly string[], description: string) =>
    Type.Unsafe({ type: "string", enum: [...values], description });
  // omp's setLabel(label) names the extension; pi's setLabel(entryId, label) bookmarks a session entry
  // and can't be called while loading. omp is the host that injects `pi.typebox`.
  if ((pi as any).typebox) pi.setLabel("pi-rx (gated workflow)");

  let ui: ExtensionContext | null = null;
  let watcher: fs.FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let panelOn = true;
  // The open Co-Review review: its MCP session, ticket, review id and state file. `reviewGen` stops a
  // superseded await_reviewer loop (bumped on every teardown).
  let reviewInfo: { ticket: string; reviewId: string; store: string; conn: CoReview } | null = null;
  let reviewGen = 0;
  // The HTML fallback review (no Co-Review installed): the pseudocode-design live page + its server.
  let htmlReview: { ticket: string; url: string; stop: () => void } | null = null;

  /** Leave the review: stop the await loop and end the MCP session (the review stays in Co-Review),
   *  or shut the HTML review server down. */
  function stopReview() {
    reviewGen++;
    reviewInfo?.conn.close();
    reviewInfo = null;
    htmlReview?.stop();
    htmlReview = null;
  }

  /** Merge a few keys into a ticket's state file (read-modify-write, atomic). For plugin-managed
   *  fields (review cursor/url, session binding) that aren't phase transitions. Best-effort. */
  function patchState(dir: string, ticket: string, patch: Record<string, unknown>) {
    try {
      const p = statePath(dir, ticket);
      if (!fs.existsSync(p)) return;
      withStateLock(p, () => {
        const s = JSON.parse(fs.readFileSync(p, "utf8")) as RxState;
        Object.assign(s, patch, { updated_at: nowIso() });
        writeState(p, s);
      });
    } catch (err) {
      pi.logger?.debug?.(`pi-rx: patchState skipped: ${err}`);
    }
  }

  function renderPanel(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!panelOn) {
      ctx.ui.setWidget("rx-panel", undefined);
      ctx.ui.setStatus("rx", undefined);
      return;
    }
    const dir = repoStateDir(ctx.cwd || process.cwd());
    const states = dir ? readStates(dir).filter(isActive) : [];
    if (!states.length) {
      ctx.ui.setWidget("rx-panel", undefined);
      ctx.ui.setStatus("rx", undefined);
      return;
    }
    const lines = states.map((s) => {
      const pr = s.pr_number ? ` #${s.pr_number}` : "";
      const rev = s.phase === "awaiting-approval" && s.design_rev ? ` ·rev ${s.design_rev}` : "";
      return ` rx ${s.ticket} ▸ ${s.phase}${pr}${rev} → ${NEXT_CMD[s.phase] ?? "?"}`;
    });
    ctx.ui.setWidget("rx-panel", lines, { placement: "belowEditor" });
    ctx.ui.setStatus("rx", `rx:${states[0].ticket}:${states[0].phase}`);
  }

  function refresh() {
    if (!ui) return;
    renderPanel(ui);
    // Keep the enclosing Herd Space label/stage in step with state changes (fs.watch of the state
    // dir, plugin transitions via applyTransition). Each Space is ticket-dedicated now, so we label
    // it after the ticket THIS pane drives — its bound session / owned Space, else the lone active.
    const cwd = ui.cwd || process.cwd();
    const dir = repoStateDir(cwd);
    const mine = dir ? currentTicket(dir, ui, false, true) : undefined;
    if (mine) nameHerdrWorkspace(mine.ticket, mine.phase, cwd);
  }

  /** Guarded state write, shared by the rx_transition tool and the Co-Review gate.
   *  The awaiting-approval self-edge is recorded as a design revision, not a phase move. */
  function applyTransition(dir: string, ticket: string, to: Phase, note: string): { ok: boolean; text: string; state?: RxState } {
    const p = statePath(dir, ticket);
    if (!fs.existsSync(p)) return { ok: false, text: `rx: no pipeline for ${ticket} — run /rx-start first.` };
    const r = withStateLock(p, () => {
      const s = JSON.parse(fs.readFileSync(p, "utf8")) as RxState;
      const t = computeTransition(s, to, note, nowIso());
      if (t.ok && t.state) writeState(p, t.state);
      return t;
    });
    if (!r.ok) return r;
    refresh();
    if (to === "approved" && r.state) {
      snapshotApprovedDesign(r.state); // baseline for future design-delta diffs
      // This review round is finished. Drop the review binding, its state file and the delivery cursors
      // so a re-review after /rx-rework opens the reworked design (with the design-changes diff) from a
      // clean cursor rather than replaying the previous round's comments/approve state.
      try {
        fs.rmSync(path.join(dir, `${ticket}.review.json`), { force: true });
      } catch {
        /* best-effort */
      }
      patchState(dir, ticket, { review_id: null, review_delivered: [], review_round: 0 });
    }
    return r;
  }

  function armWatcher() {
    if (watcher) return;
    try {
      fs.mkdirSync(STATE_ROOT, { recursive: true });
      // ponytail: one recursive watch on the whole state root; per-repo watches if it ever gets noisy
      watcher = fs.watch(STATE_ROOT, { recursive: true }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(refresh, 200);
      });
    } catch (err) {
      pi.logger?.warn?.(`pi-rx: state watch failed: ${err}`);
    }
  }

  pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => {
    ui = ctx;
    armWatcher();
    renderPanel(ctx);
    // Reopening a session inside a ticket's Space: re-label the enclosing Herd workspace after the
    // ticket this pane drives (bound session / owned Space, else the lone active ticket).
    const cwd = ctx.cwd || process.cwd();
    const dir = repoStateDir(cwd);
    const mine = dir ? currentTicket(dir, ctx, false, true) : undefined;
    if (mine) nameHerdrWorkspace(mine.ticket, mine.phase, cwd);
  });
  pi.on("turn_start", (_e: unknown, ctx: ExtensionContext) => {
    ui = ctx;
    renderPanel(ctx);
  });
  pi.on("session_shutdown", () => {
    watcher?.close();
    watcher = null;
    if (debounce) clearTimeout(debounce);
    stopReview();
  });

  pi.registerTool({
    name: "rx_status",
    label: "Rx Status",
    description:
      "Read the Rx pipeline state for the current repo. Without a ticket, lists all tickets " +
      "and their phases; with one, returns its full state file (phase, PR, log, paths).",
    parameters: Type.Object({
      ticket: Type.Optional(Type.String({ description: "Bare ticket id, e.g. ENG-1234. Omit to list all." })),
    }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { ticket?: string };
      const cwd = ctx.cwd || process.cwd();
      const dir = repoStateDir(cwd);
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      const paths = {
        repo_root: repoRoot(cwd),
        state_dir: dir,
        openspec_dir: openspecDir(dir),
        openspec_store: openspecStore(dir),
      };
      if (!params.ticket) {
        const states = readStates(dir);
        const text = states.length
          ? states.map((s) => `${s.ticket}  ${s.phase}${s.pr_number ? `  PR #${s.pr_number}` : ""}  → ${NEXT_CMD[s.phase]}`).join("\n")
          : "no rx pipelines for this repo.";
        return { content: [{ type: "text", text }], details: { states, paths } };
      }
      const p = statePath(dir, params.ticket);
      if (!fs.existsSync(p))
        return { content: [{ type: "text", text: `rx: no pipeline for ${params.ticket} — run /rx-start first.` }], isError: true };
      const s = JSON.parse(fs.readFileSync(p, "utf8")) as RxState;
      const review = readReviewState(dir, params.ticket);
      return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }], details: { state: s, paths: { ...paths, artifacts_dir: artifactsDir(dir, params.ticket), watch_ledger: path.join(dir, `${params.ticket}.watch.jsonl`) }, review } };
    },
  });

  pi.registerTool({
    name: "rx_discovery",
    label: "Rx Discovery Map",
    description:
      "Blast-radius discovery gate: checks whether this repo ships a curated map — a `graphify-out/` " +
      "graph and/or an `okf/` bundle — and returns the BINDING directive for how to discover code " +
      "relationships. When a map exists you MUST use it (skill://graphify queries for graphify-out/, " +
      "read the okf/ bundle for structure) BEFORE any grep/glob/manual scan; manual discovery is then " +
      "confirm-only. Call this FIRST in /rx-start (§4 design) and /rx-approve (§3 implementation) " +
      "before locating anything. If you bypass an existing map, log an rx_deviation.",
    parameters: Type.Object({
      ticket: Type.Optional(Type.String({ description: "Bare ticket id; resolves the ticket worktree. Omit to check the current repo root." })),
    }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { ticket?: string };
      const cwd = ctx.cwd || process.cwd();
      const dir = repoStateDir(cwd);
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      let base = repoRoot(cwd) || cwd;
      if (params.ticket) {
        const st = readStates(dir).find((s) => s.ticket === params.ticket);
        if (st?.worktree) base = st.worktree;
      }
      const graphify = fs.existsSync(path.join(base, "graphify-out"));
      const okf = fs.existsSync(path.join(base, "okf"));
      const steps: string[] = [];
      if (graphify)
        steps.push(
          "graphify-out/ EXISTS → answer every 'where does X live?' / 'what calls this?' / endpoint→store " +
            "trace / precedent lookup via skill://graphify. Do NOT grep/glob for file relationships until graphify is queried.",
        );
      if (okf)
        steps.push(
          "okf/ EXISTS → read the OKF bundle first to locate the capability you're changing and its neighbors " +
            "(services / packages / APIs / DB schema / config) before opening source.",
        );
      if (graphify || okf)
        steps.push(
          "Manual rg / git grep / glob is CONFIRM-ONLY here — use it to verify a map hit, never as the primary " +
            "blast-radius scan. If you bypass the map and discover manually, log rx_deviation " +
            "(source: self, kind: ignored-instruction) with why.",
        );
      else
        steps.push(
          "No curated map present (no graphify-out/, no okf/) → manual discovery (rg / git grep / the Explore " +
            "agent) is the sanctioned fallback. Consider generating a graphify graph (skill://graphify) for a large change.",
        );
      const text =
        `rx discovery map for ${params.ticket ?? "repo"} @ ${base}\n` +
        `  graphify-out/: ${graphify ? "yes" : "no"}   okf/: ${okf ? "yes" : "no"}\n` +
        `DIRECTIVE:\n` +
        steps.map((s) => `  • ${s}`).join("\n");
      return {
        content: [{ type: "text", text }],
        details: { base, graphify, okf, mustUseMap: graphify || okf, directive: steps },
      };
    },
  });

  pi.registerTool({
    name: "rx_pseudocode_check",
    label: "Rx Pseudocode Check",
    description:
      "Verify a ticket's pseudocode artifact will render in the review view BEFORE the approval gate. " +
      "The review renderer shows only four `## ` sections — Context / Design / Diagrams / Open " +
      "Questions — and silently drops anything else, so a non-conforming artifact renders blank. " +
      "Returns ok + the exact problems to fix. Run this in /rx-start before arriving at the gate.",
    parameters: Type.Object({
      ticket: Type.String({ description: "Bare ticket id, e.g. ENG-1234." }),
    }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { ticket: string };
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      const st = readStates(dir).find((s) => s.ticket === params.ticket);
      if (!st || !st.pseudocode)
        return { content: [{ type: "text", text: `rx: ${params.ticket} has no pseudocode artifact yet.` }], isError: true };
      if (isPrpArtifactPath(st.pseudocode))
        return {
          content: [
            {
              type: "text",
              text:
                `rx: pseudocode artifact points at a retired PRP path (${st.pseudocode}). ` +
                `Rx review/implementation use the canonical pseudocode artifact plus OpenSpec deltas, never PRP.`,
            },
          ],
          isError: true,
        };
      const artifact = path.isAbsolute(st.pseudocode)
        ? st.pseudocode
        : path.join(st.worktree || repoRoot(ctx.cwd || process.cwd()) || "", st.pseudocode);
      let md: string;
      try {
        md = fs.readFileSync(artifact, "utf8");
      } catch {
        return { content: [{ type: "text", text: `rx: pseudocode artifact not found: ${artifact}` }], isError: true };
      }
      const r = validatePseudocode(md);
      const text = r.ok
        ? `pseudocode OK — ${path.basename(artifact)} renders as tree + diagrams in the review view.`
        : `pseudocode WILL NOT RENDER — fix before the gate:\n` + r.problems.map((p) => `  • ${p}`).join("\n");
      return { content: [{ type: "text", text }], details: { ok: r.ok, problems: r.problems }, isError: !r.ok };
    },
  });

  pi.registerTool({
    name: "rx_transition",
    label: "Rx Transition",
    description:
      "Move an Rx ticket to a new phase, enforcing the state machine: " +
      "started→awaiting-approval→approved→implemented→pr-open→cleaned (merge is detected via gh, not a phase), plus the rework " +
      "loop pr-open→awaiting-approval (PR comments need design/dev changes) and the design-revise " +
      "self-edge awaiting-approval→awaiting-approval (pseudocode rewritten at the gate, bumps " +
      "design_rev), plus the early-abort edge <any non-terminal phase>→aborted (abandon the ticket). " +
      "Refuses invalid jumps. Logs the transition with a note.",
    parameters: Type.Object({
      ticket: Type.String({ description: "Bare ticket id, e.g. ENG-1234." }),
      to: stringEnum(PHASES, "Target phase (same phase = a design revision when at the gate)."),
      note: Type.String({ description: "Why — logged in the audit trail." }),
    }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { ticket: string; to: Phase; note: string };
      if (!PIPELINE_ID.test(params.ticket))
        return { content: [{ type: "text", text: `rx: invalid ticket '${params.ticket}'.` }], isError: true };
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      const before = readStates(dir).find((s) => s.ticket === params.ticket)?.phase;
      const r = applyTransition(dir, params.ticket, params.to, params.note);
      let text = r.text;
      if (r.ok && params.to === "awaiting-approval" && before !== "awaiting-approval")
        text += `\nAt the gate: once the design is final for this round, call rx_review_open { ticket: "${params.ticket}" }.`;
      return {
        content: [{ type: "text", text }],
        details: { ticket: params.ticket, phase: r.state?.phase, design_rev: r.state?.design_rev },
        isError: !r.ok,
      };
    },
  });

  pi.registerTool({
    name: "rx_init",
    label: "Rx Init",
    description:
      "Create the state file for a new pipeline at phase=started. Call once in /rx-start after the " +
      "worktree exists. ticket is the canonical id (ENG-1234, or a free-text task id like add-retry-webhook-sender). Folds in what the user asked for (source, requirement) recorded at /rx.",
    parameters: Type.Object({
      ticket: Type.String({ description: "Canonical pipeline id." }),
      branch: Type.String({ description: "Git branch (usually the ticket id)." }),
      worktree: Type.String({ description: "Absolute worktree path." }),
    }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { ticket: string; branch: string; worktree: string };
      if (!PIPELINE_ID.test(params.ticket))
        return { content: [{ type: "text", text: `rx: invalid ticket '${params.ticket}'.` }], isError: true };
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      if (fs.existsSync(statePath(dir, params.ticket)))
        return { content: [{ type: "text", text: `rx: pipeline already exists for ${params.ticket}.` }], isError: true };
      let s = initState(dir, params.ticket, params.branch, params.worktree);
      const intake = readIntake(dir, params.ticket);
      if (intake) {
        s = setFields(dir, params.ticket, {
          source: intake.source,
          source_ref: intake.source_ref,
          ...(intake.requirement ? { requirement: intake.requirement } : {}),
        });
        fs.rmSync(intakePath(dir, params.ticket), { force: true });
      }
      return { content: [{ type: "text", text: `rx: initialized ${params.ticket} (phase started).` }], details: { state: s } };
    },
  });

  pi.registerTool({
    name: "rx_worktree",
    label: "Rx Worktree",
    description:
      "Create (or reuse) the ticket's isolated git worktree at <repo>/.worktrees/<ticket> on a branch " +
      "named exactly <ticket>, based on origin/main — or local main when self-hosted, i.e. no origin " +
      "remote (skill://using-git-worktrees). Resolves the MAIN repo root (works from any cwd/worktree), " +
      "ensures .worktrees/ is git-ignored (adds + commits if not), and is idempotent (reuses a matching " +
      "worktree, refuses a conflicting branch). Returns the absolute worktree path + branch to hand to " +
      "rx_init. Call in /rx-start after rx_ground.",
    parameters: Type.Object({ ticket: Type.String({ description: "Canonical pipeline id (ENG-1234 or a free-text task id)." }) }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const { ticket } = rawParams as { ticket: string };
      if (!PIPELINE_ID.test(ticket)) return { content: [{ type: "text", text: `rx: invalid ticket '${ticket}'.` }], isError: true };
      const root = repoRoot(ctx.cwd || process.cwd());
      if (!root) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      try {
        const r = ensureWorktree(root, ticket);
        const text = `${r.created ? "created" : "reusing"} worktree ${r.path} (branch ${r.branch})${r.gitignore ? `; ${r.gitignore}` : ""}${r.selfHosted ? "; SELF-HOSTED: no origin remote — branched off local main." : ""}.`;
        return { content: [{ type: "text", text }], details: r };
      } catch (e) {
        return { content: [{ type: "text", text: `rx: worktree setup failed — ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "rx_set",
    label: "Rx Set",
    description:
      "Set one or more fields on a ticket's state (test_plan, pseudocode, openspec_change, pr_number, " +
      "herdr_workspace, …) and stamp updated_at. Values may be strings, numbers, or null. Use " +
      "rx_transition for phase moves — not this.",
    parameters: Type.Object({
      ticket: Type.String({ description: "Canonical pipeline id." }),
      fields: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()]), { description: "Field → value map to assign." }),
    }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { ticket: string; fields: Record<string, string | number | null> };
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      if (!fs.existsSync(statePath(dir, params.ticket)))
        return { content: [{ type: "text", text: `rx: no pipeline for ${params.ticket}.` }], isError: true };
      if ("phase" in params.fields)
        return { content: [{ type: "text", text: "rx: use rx_transition to change phase, not rx_set." }], isError: true };
      const s = setFields(dir, params.ticket, params.fields);
      return { content: [{ type: "text", text: `rx: set ${Object.keys(params.fields).join(", ")} on ${params.ticket}.` }], details: { state: s } };
    },
  });

  pi.registerTool({
    name: "rx_log",
    label: "Rx Log",
    description: "Append a timestamped audit entry to a ticket's log (event + note).",
    parameters: Type.Object({
      ticket: Type.String({ description: "Canonical pipeline id." }),
      event: Type.String({ description: "Short event key, e.g. 'test-plan', 'review-note'." }),
      note: Type.String({ description: "Free-text detail." }),
    }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { ticket: string; event: string; note: string };
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      if (!fs.existsSync(statePath(dir, params.ticket)))
        return { content: [{ type: "text", text: `rx: no pipeline for ${params.ticket}.` }], isError: true };
      logEvent(dir, params.ticket, params.event, params.note);
      return { content: [{ type: "text", text: `rx: logged '${params.event}' on ${params.ticket}.` }] };
    },
  });

  pi.registerTool({
    name: "rx_deviation",
    label: "Rx Deviation",
    description:
      "Record one deviation to the per-repo deviation log (feeds /rx-retro). source: 'self' (agent " +
      "self-report) or 'auto' (human correction). kind: guessed|ignored-instruction|scope-miss|" +
      "rejected|reworked|request-changes|contract-drift|other. Always pass context AND reasoning.",
    parameters: Type.Object({
      ticket: Type.String({ description: "Canonical pipeline id." }),
      source: stringEnum(["self", "auto"], "Who reported it."),
      kind: Type.String({ description: "Deviation kind." }),
      note: Type.String({ description: "One line — what went wrong." }),
      context: Type.String({ description: "Inputs/state at the time; what was given/missing." }),
      reasoning: Type.String({ description: "Why it happened / the human's stated reason." }),
    }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { ticket: string; source: string; kind: string; note: string; context: string; reasoning: string };
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      writeDeviation(dir, params.ticket, params);
      return { content: [{ type: "text", text: `rx: recorded ${params.source}/${params.kind} deviation on ${params.ticket}.` }] };
    },
  });

  pi.registerTool({
    name: "rx_openspec_ensure",
    label: "Rx OpenSpec Ensure",
    description:
      "Create+register the per-repo OpenSpec store once (idempotent). Returns { store, dir, changesDir } " +
      "so /rx-start can scaffold a change. Reports installed:false when the openspec CLI is absent — " +
      "skip the spec layer cleanly in that case.",
    parameters: Type.Object({}),
    async execute(_id, _rawParams, _signal, _onUpdate, ctx) {
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      let hasCli = true;
      try {
        execFileSync("openspec", ["--version"], { stdio: "ignore", timeout: 20000 });
      } catch {
        hasCli = false;
      }
      if (!hasCli)
        return { content: [{ type: "text", text: "rx: openspec CLI not installed — skip the spec layer." }], details: { installed: false } };
      const store = openspecStore(dir);
      const osDir = openspecDir(dir);
      fs.mkdirSync(path.dirname(osDir), { recursive: true });
      let registered = false;
      try {
        execFileSync("openspec", ["list", "--store", store], { stdio: "ignore", timeout: 20000 });
        registered = true;
      } catch {
        registered = false;
      }
      if (!registered) {
        try {
          if (fs.existsSync(path.join(osDir, "openspec")))
            execFileSync("openspec", ["store", "register", osDir, "--id", store, "--yes"], { stdio: "ignore", timeout: 20000 });
          else execFileSync("openspec", ["store", "setup", store, "--path", osDir, "--no-init-git", "--json"], { stdio: "ignore", timeout: 20000 });
          execFileSync("openspec", ["list", "--store", store], { stdio: "ignore", timeout: 20000 });
        } catch (e) {
          return { content: [{ type: "text", text: `rx: openspec store setup failed: ${e}` }], isError: true };
        }
      }
      const changesDir = path.join(osDir, "openspec", "changes");
      return {
        content: [{ type: "text", text: `rx: openspec store ${store} at ${osDir}` }],
        details: { installed: true, store, dir: osDir, changesDir },
      };
    },
  });

  pi.registerTool({
    name: "rx_openspec",
    label: "Rx OpenSpec",
    description:
      "Run a deterministic OpenSpec op against this repo's personal store (id resolved for you): " +
      "validate (strict), archive (fold deltas into baseline specs), or show (JSON). Author the change " +
      "files under rx_openspec_ensure's changesDir first; this runs the CLI over them. Skips cleanly if " +
      "the openspec CLI is absent.",
    parameters: Type.Object({
      op: stringEnum(["validate", "archive", "show"], "OpenSpec operation."),
      change: Type.String({ description: "Change id (kebab), e.g. eng-1234-thing." }),
      skipSpecs: Type.Optional(Type.Boolean({ description: "archive only: pass --skip-specs (no baseline spec update)." })),
    }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { op: "validate" | "archive" | "show"; change: string; skipSpecs?: boolean };
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      try {
        execFileSync("openspec", ["--version"], { stdio: "ignore", timeout: 20000 });
      } catch {
        return { content: [{ type: "text", text: "rx: openspec CLI not installed — skip the spec layer." }], details: { installed: false }, isError: true };
      }
      const store = openspecStore(dir);
      const args =
        params.op === "validate"
          ? ["validate", params.change, "--store", store, "--strict"]
          : params.op === "archive"
            ? ["archive", params.change, "--store", store, "--yes", ...(params.skipSpecs ? ["--skip-specs"] : [])]
            : ["show", params.change, "--store", store, "--json"];
      try {
        const out = runCli("openspec", args);
        return { content: [{ type: "text", text: out || `openspec ${params.op} ${params.change}: ok` }], details: { op: params.op, change: params.change, store, output: out } };
      } catch (e) {
        const err = e as { stderr?: Buffer | string; message?: string };
        return { content: [{ type: "text", text: `rx: openspec ${params.op} failed — ${(err.stderr?.toString() || err.message || String(e)).trim()}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "rx_pr",
    label: "Rx PR",
    description:
      "Open the PR (first call: needs title + body — pushes the branch, runs gh pr create, records " +
      "pr_number) or push a rework to the existing PR (later calls: pushes, optional comment), then move " +
      "the pipeline to pr-open. You author title/body; the git/gh mechanics are deterministic. " +
      "Self-hosted (no origin remote): no push/gh — merges the ticket branch straight into local main " +
      "at the repo root and marks the ticket self-delivered; that's the sanctioned delivery, not " +
      "contract-drift, and needs only a title (used as the merge commit summary).",
    parameters: Type.Object({
      ticket: Type.String({ description: "Canonical pipeline id." }),
      title: Type.Optional(Type.String({ description: "PR title (required to OPEN a PR, or as the merge summary when self-hosted)." })),
      body: Type.Optional(Type.String({ description: "PR body markdown (required to OPEN a PR; optional merge-message detail when self-hosted)." })),
      comment: Type.Optional(Type.String({ description: "Rework only: a PR comment (or re-merge summary when self-hosted) noting what changed." })),
    }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { ticket: string; title?: string; body?: string; comment?: string };
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      const p = statePath(dir, params.ticket);
      if (!fs.existsSync(p)) return { content: [{ type: "text", text: `rx: no pipeline for ${params.ticket}.` }], isError: true };
      const s = JSON.parse(fs.readFileSync(p, "utf8")) as RxState;
      const branch = s.branch || params.ticket;
      const wt = s.worktree || repoRoot(ctx.cwd || process.cwd()) || process.cwd();
      const root = repoRoot(wt) || wt;
      const selfHosted = !hasOriginRemote(root);
      let prNumber = s.pr_number ?? null;
      let url = "";
      let mode: "created" | "pushed" | "merged";
      try {
        if (selfHosted) {
          // Sanctioned self-hosting delivery: no origin to push to and no PR to open, so merge the
          // ticket branch straight into local main at the repo root — replaces the ad-hoc "commit to
          // main" every self-hosted run used to improvise.
          if (!prNumber && !params.title) return { content: [{ type: "text", text: "rx: self-hosted delivery needs a title (used as the merge summary)." }], isError: true };
          const msg = params.comment || (params.title ? `${params.title}${params.body ? `\n\n${params.body}` : ""}` : `rx: merge ${params.ticket}`);
          // The root checkout's HEAD is whatever was last checked out there (worktrees never move it),
          // so refuse rather than merge the ticket into a stray branch.
          const head = runCli("git", ["rev-parse", "--abbrev-ref", "HEAD"], root);
          if (head !== "main")
            return { content: [{ type: "text", text: `rx: self-hosted merge needs the repo root (${root}) on 'main', but it is on '${head}'. Check out main there and retry.` }], isError: true };
          runCli("git", ["merge", "--no-ff", branch, "-m", msg], root);
          if (!s.self_delivered) setFields(dir, params.ticket, { self_delivered: true });
          mode = "merged";
        } else if (!prNumber) {
          if (!params.title || !params.body) return { content: [{ type: "text", text: "rx: opening a PR needs both title and body." }], isError: true };
          runCli("git", ["push", "-u", "origin", branch], wt);
          const tmp = path.join(os.tmpdir(), `rx-pr-${params.ticket}-${Date.now()}.md`);
          fs.writeFileSync(tmp, params.body);
          try {
            url = runCli("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", params.title, "--body-file", tmp], wt);
          } finally {
            fs.rmSync(tmp, { force: true });
          }
          prNumber = runCli("gh", ["pr", "view", branch, "--json", "number", "-q", ".number"], wt);
          setFields(dir, params.ticket, { pr_number: prNumber });
          mode = "created";
        } else {
          runCli("git", ["push"], wt);
          if (params.comment) runCli("gh", ["pr", "comment", String(prNumber), "--body", params.comment], wt);
          mode = "pushed";
        }
      } catch (e) {
        const err = e as { stderr?: Buffer | string; message?: string };
        return { content: [{ type: "text", text: `rx: PR ${selfHosted ? "merge" : prNumber ? "push" : "create"} failed — ${(err.stderr?.toString() || err.message || String(e)).trim()}` }], isError: true };
      }
      const note = selfHosted ? `self-hosted direct merge of ${branch} into local main` : `PR #${prNumber} ${mode}`;
      const r = applyTransition(dir, params.ticket, "pr-open", note);
      const text = selfHosted ? `rx: self-hosted — merged ${branch} into local main (no PR); ${r.text}` : `PR #${prNumber} ${mode}${url ? ` (${url})` : ""}; ${r.text}`;
      return { content: [{ type: "text", text }], details: { pr_number: prNumber, url, mode, phase: r.state?.phase, selfHosted }, isError: !r.ok };
    },
  });

  pi.registerTool({
    name: "rx_pr_state",
    label: "Rx PR State",
    description:
      "Read the PR's merge state via gh: returns { state, merged, url }. The /rx-cleanup gate — only tear " +
      "down when merged. Self-hosted (rx_pr's direct-merge delivery): already merged by construction, no gh call.",
    parameters: Type.Object({ ticket: Type.String({ description: "Canonical pipeline id." }) }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const { ticket } = rawParams as { ticket: string };
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      const p = statePath(dir, ticket);
      if (!fs.existsSync(p)) return { content: [{ type: "text", text: `rx: no pipeline for ${ticket}.` }], isError: true };
      const s = JSON.parse(fs.readFileSync(p, "utf8")) as RxState;
      if (s.self_delivered)
        return { content: [{ type: "text", text: `rx: ${ticket} was self-hosted direct-merged into local main (merged).` }], details: { state: "MERGED", merged: true, url: "", selfHosted: true } };
      if (!s.pr_number) return { content: [{ type: "text", text: `rx: ${ticket} has no PR.` }], details: { state: "none", merged: false } };
      try {
        const j = JSON.parse(runCli("gh", ["pr", "view", String(s.pr_number), "--json", "state,mergedAt,url"], repoRoot(ctx.cwd || process.cwd()) || undefined)) as { state?: string; url?: string };
        const merged = j.state === "MERGED";
        return { content: [{ type: "text", text: `PR #${s.pr_number} state=${j.state}${merged ? " (merged)" : ""}` }], details: { state: j.state, merged, url: j.url } };
      } catch (e) {
        return { content: [{ type: "text", text: `rx: gh pr view failed — ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "rx_decision",
    label: "Rx Decision",
    description: "Append a standing objection / process decision to ~/.claude/workflow/DECISIONS.md (dated, tagged with the ticket). For /rx-reject and /rx-rework process-level objections.",
    parameters: Type.Object({ ticket: Type.String({ description: "Canonical pipeline id." }), note: Type.String({ description: "The standing decision/objection, one line." }) }),
    async execute(_id, rawParams, _signal, _onUpdate, _ctx) {
      const { ticket, note } = rawParams as { ticket: string; note: string };
      const f = path.join(os.homedir(), ".claude", "workflow", "DECISIONS.md");
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        if (!fs.existsSync(f)) fs.writeFileSync(f, "# Rx decisions\n\n## Running objections & process changes\n\n");
        fs.appendFileSync(f, `- ${new Date().toISOString().slice(0, 10)} — [${ticket}] ${note}\n`);
        return { content: [{ type: "text", text: `rx: recorded decision for ${ticket} in DECISIONS.md.` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `rx: could not write DECISIONS.md — ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "rx_config",
    label: "Rx Config",
    description:
      "Set the default ticketing system when the user names it in plain words (\"we use Jira\", \"our ids look " +
      "like PAY-12\") — no file editing needed. tickets = a ticket source name (bare ids like ENG-123 go there; " +
      "linear when unset). ticket_shape = a case-insensitive regex for bare ids (its (?<id>…) group, if any, is " +
      "the id); an empty string clears it. scope 'user' (default, ~/.config/rx/config.yml) or 'repo' " +
      "(<repo>/.rx/config.yml, written, not committed; overrides user). Validates before writing; reports the " +
      "effective config.",
    parameters: Type.Object({
      tickets: Type.Optional(Type.String({ description: "Ticket source name: linear, jira, github, gitlab, or one the user added." })),
      ticket_shape: Type.Optional(Type.String({ description: "Bare-id regex, e.g. ^(PAY|OPS)-\\d+$. Empty string clears it." })),
      scope: Type.Optional(stringEnum(["user", "repo"], "Where to save: user (default) or repo.")),
    }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const p = rawParams as { tickets?: string; ticket_shape?: string; scope?: "user" | "repo" };
      const fail = (text: string) => ({ content: [{ type: "text" as const, text: `rx: ${text}` }], isError: true });
      const repo = repoRoot(ctx.cwd || process.cwd());
      const changes: [keyof RxConfig, string][] = [];
      if (p.tickets !== undefined) changes.push(["tickets", p.tickets.trim()]);
      if (p.ticket_shape !== undefined) changes.push(["ticket_shape", p.ticket_shape.trim()]);
      if (!changes.length) return fail("nothing to set — pass tickets and/or ticket_shape.");
      const names = loadSources(sourceDirs(repo)).map((s) => s.name);
      if (p.tickets !== undefined && !names.includes(p.tickets.trim())) return fail(`no ticket source named "${p.tickets}" — installed: ${names.join(", ")}.`);
      if (p.ticket_shape?.trim())
        try {
          new RegExp(p.ticket_shape.trim(), "i");
        } catch (e) {
          return fail(`ticket_shape is not a valid regex — ${e instanceof Error ? e.message : e}`);
        }
      if (p.scope === "repo" && !repo) return fail("not inside a git repo — use scope user.");
      const repoFile = repo ? path.join(repo, ".rx", "config.yml") : null;
      const file = p.scope === "repo" ? repoFile! : path.join(userConfigDir(), "config.yml");
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        /* absent: start empty */
      }
      for (const [k, v] of changes) {
        const next = setConfigValue(text, k, v);
        if (next === null) return fail(`${k} ${JSON.stringify(v)} can't be stored as a config line (no newlines, " #", or surrounding quotes).`);
        text = next;
      }
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      } catch (e) {
        return fail(`could not write ${file} — ${e instanceof Error ? e.message : e}`);
      }
      const eff = readConfig(repo);
      // A user-scope value the repo's config overrides does nothing here — say so, or "I set Jira" silently lies.
      const shadowed = changes.filter(([k, v]) => (eff[k] ?? "") !== v).map(([k]) => k);
      const saved = changes.map(([k, v]) => (v ? `${k}: ${v}` : `${k} cleared`)).join(", ");
      const now = `tickets ${eff.tickets ?? "linear (default)"}, ticket_shape ${eff.ticket_shape ?? "built-in KEY-123"}`;
      const warn = shadowed.length ? ` ⚠ ${repoFile} overrides ${shadowed.join(", ")} in this repo.` : "";
      return { content: [{ type: "text", text: `rx: saved ${saved} to ${file}. In effect: ${now}.${warn}` }], details: { file, effective: eff, shadowed } };
    },
  });

  pi.registerTool({
    name: "rx_ground",
    label: "Rx Ground on main",
    description:
      "Fetch origin/main LOUDLY and report whether the current branch is grounded on its tip. " +
      "status: 'fresh' (on tip), 'behind' (fast-forwardable, no local commits), 'diverged' (local " +
      "commits AND behind), or 'error'. On behind/diverged the caller MUST reconcile and re-verify " +
      "race-prone anchors (migration numbers) + sibling-merged surface before implementing. Self-hosted " +
      "(no origin remote) grounds on local main instead — that's sanctioned, never a hard stop.",
    parameters: Type.Object({}),
    async execute(_id, _rawParams, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd || process.cwd();
      const root = repoRoot(cwd) || cwd;
      const selfHosted = !hasOriginRemote(root);
      const ref = baseRef(!selfHosted);
      // 60s cap: a network `git fetch` that hangs on an SSH passphrase prompt or an unreachable remote
      // must fail fast into the catch below (refuse to ground) rather than freeze the whole tool call.
      const git = (args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }).trim();
      try {
        const before = (() => {
          try {
            return git(["rev-parse", ref]);
          } catch {
            return "";
          }
        })();
        if (!selfHosted) git(["fetch", "origin", "main"]);
        const tip = git(["rev-parse", ref]);
        const mb = git(["merge-base", "HEAD", ref]);
        const prefix = selfHosted ? "rx: self-hosted (no origin remote) — " : "rx: ";
        const moved = before && before !== tip ? `${ref} ${before.slice(0, 12)} → ${tip.slice(0, 12)}` : `${ref} at ${tip.slice(0, 12)}`;
        if (mb === tip)
          return { content: [{ type: "text", text: `${prefix}branch grounded on ${moved} (fresh).` }], details: { status: "fresh", tip, selfHosted } };
        const head = git(["rev-parse", "HEAD"]);
        const behind = git(["rev-list", "--count", `HEAD..${ref}`]);
        const status = mb === head ? "behind" : "diverged";
        const fix = status === "behind" ? `git merge --ff-only ${ref}` : `git rebase ${ref}`;
        return {
          content: [
            {
              type: "text",
              text: `${prefix}branch is ${status.toUpperCase()} ${ref} by ${behind} commit(s) — reconcile: ${fix}, then re-verify race-prone anchors + sibling-merged surface.`,
            },
          ],
          details: { status, tip, behind: Number(behind), selfHosted },
          isError: true,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `rx: '${selfHosted ? `git rev-parse/merge-base ${ref}` : "git fetch origin main"}' or base check failed — refuse to ground on a stale base. ${e}` }],
          details: { status: "error", selfHosted },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "rx_watch_start",
    label: "Rx Watch Start",
    description:
      "Start (or self-heal) the PR watcher for a ticket: inside Herdr, open an rx-watch tab in the " +
      "ticket's Space running a self-scheduling loop that, each cadence, does a cheap gh pre-check and " +
      "only then wakes a fresh `omp -p` tick on the bundled watcher.md. Idempotent — reuses a live watch " +
      "tab. Records herdr_watch_tab/_pane. Call from /rx-pr once the PR is open and pr_number is set. " +
      "No-op outside Herdr or before the PR exists.",
    parameters: Type.Object({ ticket: Type.String({ description: "Bare ticket id." }) }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const { ticket } = rawParams as { ticket: string };
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      if (!fs.existsSync(statePath(dir, ticket))) return { content: [{ type: "text", text: `rx: no pipeline for ${ticket}.` }], isError: true };
      try {
        const r = ensureWatch(dir, ticket);
        if (!r) {
          const why = process.env.HERDR_ENV !== "1" ? "not inside Herdr" : "no herdr_workspace or pr_number yet";
          return { content: [{ type: "text", text: `rx: watcher not started (${why}).` }], details: { started: false } };
        }
        const text = r.created
          ? `watcher loop started in Herdr tab ${r.tab || "?"} (pane ${r.pane || "?"}).`
          : `watcher already running in Herdr tab ${r.tab}.`;
        return { content: [{ type: "text", text }], details: r };
      } catch (e) {
        return { content: [{ type: "text", text: `rx: watcher start failed (${e}).` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "rx_watch_stop",
    label: "Rx Watch Stop",
    description: "Stop a ticket's PR watcher: close its Herdr watch tab (kills the loop + any in-flight omp tick). Idempotent — safe if already gone.",
    parameters: Type.Object({ ticket: Type.String({ description: "Bare ticket id." }) }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const { ticket } = rawParams as { ticket: string };
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      const p = statePath(dir, ticket);
      if (!fs.existsSync(p)) return { content: [{ type: "text", text: `rx: no pipeline for ${ticket}.` }], isError: true };
      const s = JSON.parse(fs.readFileSync(p, "utf8")) as RxState;
      const done = stopWatch(s);
      logEvent(dir, ticket, "watch-stop", done.join("; ") || "nothing to stop");
      return { content: [{ type: "text", text: `watcher stopped: ${done.join("; ") || "nothing to stop"}` }], details: { stopped: done } };
    },
  });

  pi.registerTool({
    name: "rx_teardown",
    label: "Rx Teardown",
    description:
      "Tear down a merged ticket's runtime: stop the watcher, remove the worktree + local/remote branch, " +
      "and delete the disposable artifacts (review store + artifact dir). Idempotent, best-effort. The " +
      "state file stays as the audit record — follow with rx_transition to 'cleaned' (merged) or " +
      "'aborted' (abandoned early via /rx-abort).",
    parameters: Type.Object({ ticket: Type.String({ description: "Bare ticket id." }) }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const { ticket } = rawParams as { ticket: string };
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      const p = statePath(dir, ticket);
      if (!fs.existsSync(p)) return { content: [{ type: "text", text: `rx: no pipeline for ${ticket}.` }], isError: true };
      const s = JSON.parse(fs.readFileSync(p, "utf8")) as RxState;
      const done = teardown(dir, s);
      logEvent(dir, ticket, "teardown", done.join("; "));
      return { content: [{ type: "text", text: `teardown: ${done.join("; ")}` }], details: { done } };
    },
  });

  pi.registerTool({
    name: "rx_deviations",
    label: "Rx Deviations",
    description:
      "Aggregate this repo's deviation log for /rx-retro: counts by source/kind and by phase, plus the " +
      "full entries (details.entries, newest last). Optional ticket filter.",
    parameters: Type.Object({ ticket: Type.Optional(Type.String({ description: "Filter to one ticket. Omit for all." })) }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const { ticket } = rawParams as { ticket?: string };
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      const a = aggregateDeviations(dir, ticket);
      if (!a.total) return { content: [{ type: "text", text: `no deviations logged yet for this repo (${a.file}).` }], details: a };
      const fmt = (m: Record<string, number>) => Object.entries(m).sort((x, y) => y[1] - x[1]).map(([k, n]) => `  ${k}: ${n}`).join("\n");
      const text = `${a.total} deviation(s) in ${a.file}\nby kind:\n${fmt(a.byKind)}\nby phase:\n${fmt(a.byPhase)}`;
      return { content: [{ type: "text", text }], details: a };
    },
  });

  // When pi-rx runs inside a Herdr pane (HERDR_ENV=1), label the enclosing Herdr WORKSPACE (a
  // "Space" in Herdr's sidebar) after the TICKET and surface the current rx STAGE, so the sidebar
  // shows which ticket each agent is on and how far its pipeline has gotten. Herdr has no
  // session-rename (sessions are separate namespaces, named only at attach), so the workspace —
  // the per-task container that rolls up agent state — is the unit we label.
  //
  // The Space label becomes "<ticket> · <stage>" (always visible). We also publish workspace
  // metadata tokens (stage, ticket, project), which Herdr exposes to Space rows as $stage/$ticket/
  // $project for anyone templating their sidebar. Best-effort: no-op outside Herdr or without the
  // `herdr` CLI, never throws.
  let labeledKey: string | null = null;
  function nameHerdrWorkspace(ticket: string, phase: string, cwd: string) {
    if (!process.env.HERDR_ENV) return;
    const ws = process.env.HERDR_WORKSPACE_ID;
    const key = `${ticket}\t${phase}`;
    if (!ws || labeledKey === key) return;
    const root = repoRoot(cwd);
    const project = root ? path.basename(root) : "";
    try {
      execFileSync("herdr", ["workspace", "rename", ws, `${ticket} · ${phase}`], { stdio: "ignore", timeout: 2000 });
      execFileSync(
        "herdr",
        ["workspace", "report-metadata", ws, "--source", "rx", "--token", `stage=${phase}`, "--token", `ticket=${ticket}`, "--token", `project=${project}`],
        { stdio: "ignore", timeout: 2000 },
      );
      labeledKey = key;
      // Persist the workspace id so stages can "pass it on" (e.g. /rx-pr mirrors watcher logs here)
      // without re-discovering it — the plugin is the one that labelled this workspace.
      const sdir = repoStateDir(cwd);
      if (sdir) patchState(sdir, ticket, { herdr_workspace: ws });
    } catch (err) {
      pi.logger?.debug?.(`pi-rx: herdr workspace label skipped: ${err}`);
    }
  }

  // --- One Herd Space per active RX. Beyond LABELING the enclosing Space (above), pi-rx can create a
  // dedicated Space per ticket and — for the bare-/rx fan-out — spawn an omp agent inside it that
  // resumes the pipeline. All best-effort with short timeouts; no-op outside Herd (HERDR_ENV=1) or
  // without the `herdr` CLI. IDs are read from the CLI's JSON, never predicted.

  /** The live Space dedicated to a ticket, or "" if none. Trusts the persisted `herdr_workspace`
   *  first (via `workspace get`, which exits non-zero for a dead id), then scans live workspaces for
   *  the "<ticket> · " label the convention produces (so a Space that survived a harness restart with
   *  a stale persisted id is still matched). */
  function spaceForTicket(s: RxState): string {
    if (s.herdr_workspace) {
      try {
        runCli("herdr", ["workspace", "get", s.herdr_workspace]);
        return s.herdr_workspace;
      } catch {
        /* dead id — fall through to a label scan */
      }
    }
    try {
      const out = JSON.parse(runCli("herdr", ["workspace", "list"])) as {
        result?: { workspaces?: { workspace_id?: string; label?: string }[] };
      };
      const hit = (out.result?.workspaces ?? []).find((w) => typeof w.label === "string" && w.label.startsWith(`${s.ticket} · `));
      return hit?.workspace_id ?? "";
    } catch {
      return "";
    }
  }

  /** Publish the convention's display metadata on a Space (stage/ticket/project tokens). */
  function reportSpaceMeta(ws: string, ticket: string, phase: string, cwd: string) {
    const root = repoRoot(cwd);
    const project = root ? path.basename(root) : "";
    try {
      runCli("herdr", ["workspace", "report-metadata", ws, "--source", "rx", "--token", `stage=${phase}`, "--token", `ticket=${ticket}`, "--token", `project=${project}`]);
    } catch {
      /* best-effort */
    }
  }

  /** Ensure a dedicated Herd Space exists for a ticket, named by the convention. Reuses+renames a
   *  live Space if one is already bound; otherwise CREATES one at `cwd` (the MAIN repo root — /rx is
   *  worktree-aware and resolves `.worktrees/<ticket>` itself, so the Space opens on the checkout, not
   *  the worktree), seeding RX_LAND so the omp we spawn there LANDS on the ticket (binds this session +
   *  shows status). Persists herdr_workspace. Returns the workspace id + (for a fresh Space) its root
   *  pane. The whole check-then-create is serialized per ticket via `withSpaceLock` — see its doc. */
  function ensureSpace(dir: string, ticket: string, phase: string, cwd: string): { wsId: string; rootPane: string; created: boolean } | null {
    if (process.env.HERDR_ENV !== "1") return null;
    return withSpaceLock(dir, ticket, () => {
      const st = readStates(dir).find((x) => x.ticket === ticket);
      const label = `${ticket} · ${phase}`;
      const existing = st ? spaceForTicket(st) : "";
      if (existing) {
        try {
          runCli("herdr", ["workspace", "rename", existing, label]);
        } catch {
          /* best-effort */
        }
        reportSpaceMeta(existing, ticket, phase, cwd);
        patchState(dir, ticket, { herdr_workspace: existing });
        return { wsId: existing, rootPane: "", created: false };
      }
      try {
        const out = JSON.parse(
          runCli("herdr", ["workspace", "create", "--cwd", cwd, "--label", label, "--env", `RX_LAND=${ticket}`, "--no-focus"]),
        ) as { result?: { workspace?: { workspace_id?: string }; root_pane?: { pane_id?: string } } };
        const wsId = out.result?.workspace?.workspace_id ?? "";
        const rootPane = out.result?.root_pane?.pane_id ?? "";
        if (wsId) {
          reportSpaceMeta(wsId, ticket, phase, cwd);
          patchState(dir, ticket, { herdr_workspace: wsId });
        }
        return { wsId, rootPane, created: true };
      } catch (err) {
        pi.logger?.debug?.(`pi-rx: herdr space create skipped: ${err}`);
        return null;
      }
    }, { log: (msg) => pi.logger?.debug?.(msg) });
  }

  /** Launch omp in a fresh Space's root pane with `/rx <ticket>` as its INITIAL MESSAGE (`omp '/rx …'`
   *  via `pane run`). omp runs the command only after it is fully initialized (commands registered), so
   *  it can't race the splash screen the way a post-boot `agent prompt` does (which silently dropped the
   *  prompt on slower-booting instances). `/rx <ticket>` names the Space and, via the Space's RX_LAND
   *  env, LANDS on the ticket (binds this session + shows status; it never resumes an old transcript and
   *  never auto-drives a gate). `pane run` returns as soon as the command is sent — it does not block on
   *  omp's boot. Best-effort — a failure is logged, not thrown. (`agent start … -- <arg>` was tried but
   *  breaks Herd's agent-name registration when omp starts straight into work.) */
  function spawnOmpInSpace(rootPane: string, ticket: string) {
    if (!rootPane) return;
    try {
      runCli("herdr", ["pane", "run", rootPane, `omp '/rx ${ticket}'`]);
    } catch (err) {
      pi.logger?.debug?.(`pi-rx: herdr omp spawn skipped: ${err}`);
    }
  }

  /** The ticket this pane/session is driving: the one bound to our omp session, else the one whose
   *  Space is the current Herd workspace, else — ONLY when `guessLoneActive` is set — the lone active
   *  ticket. Undefined when ambiguous. The lone-active guess is for the INTERACTIVE bare-`/rx` dispatch,
   *  where the user explicitly typed `/rx` in this pane; the automatic background callers (session_start,
   *  the state-watch `refresh()`) must NOT guess it — every open Herdr pane in a repo shares one state
   *  dir, so with exactly one active ticket the guess previously made EVERY session in that repo (even
   *  ones with no rx involvement at all) claim ownership and get its Herd Space renamed to the ticket on
   *  every state change anywhere in the repo. Those callers pass `guessLoneActive: false` and stay
   *  undefined (no auto-rename) unless this session/Space is actually bound. */
  function currentTicket(dir: string, ctx: ExtensionContext | null, guessLoneActive = false, includeTerminal = false): RxState | undefined {
    const all = readStates(dir);
    // Binding lookups honor `includeTerminal` so the relabel callers still recognize a ticket that
    // JUST went terminal (cleaned/aborted) and can rename its Space to the final phase — otherwise the
    // Space freezes at the last active phase (e.g. "pr-open") forever. The lone-active GUESS is always
    // active-only (never guess a finished ticket).
    const states = includeTerminal ? all : all.filter(isActive);
    const sid = ctx?.sessionManager?.getSessionId?.();
    if (sid) {
      const bound = states.find((s) => s.session_id === sid);
      if (bound) return bound;
    }
    const ws = process.env.HERDR_WORKSPACE_ID;
    if (ws) {
      const owned = states.find((s) => s.herdr_workspace === ws);
      if (owned) return owned;
    }
    const active = all.filter(isActive);
    return guessLoneActive && active.length === 1 ? active[0] : undefined;
  }

  // --- Session binding: tie the omp session to a ticket so its conversation survives a harness
  // close. We stamp the session id + file onto the ticket state; /rx's resume offer (auto in a
  // fan-out-spawned Space) switches back to it after relaunch. Plugin-only — needs sessionManager.
  const nowStamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  /** Stamp the current PERSISTED omp session onto the ticket and name the session after it.
   *  Best-effort; never throws. No-op for an ephemeral (--no-session) run. */
  function bindSession(dir: string, ticket: string, ctx: ExtensionContext) {
    try {
      const sm = ctx.sessionManager;
      const id = sm?.getSessionId?.();
      const file = sm?.getSessionFile?.();
      // No persisted session file (ephemeral / --no-session or in-memory run) → nothing to bind.
      if (!id || !file) return;
      const p = statePath(dir, ticket);
      if (!fs.existsSync(p)) return;
      pi.setSessionName?.(ticket); // label the session for `omp -r` and the selector
      withStateLock(p, () => {
        const s = JSON.parse(fs.readFileSync(p, "utf8")) as RxState;
        if (s.session_id === id && s.session_file === file) return; // already bound
        s.session_id = id;
        s.session_file = file;
        s.updated_at = nowStamp();
        writeState(p, s);
      });
    } catch (err) {
      pi.logger?.debug?.(`pi-rx: bindSession skipped: ${err}`);
    }
  }

  /** A ticket has a resumable session iff its bound file exists AND it isn't the one we're in. */
  function hasResumableSession(st: RxState | undefined, ctx: ExtensionContext): boolean {
    const fileExists = Boolean(st?.session_file && fs.existsSync(st.session_file));
    return canResumeSession(st, ctx.sessionManager?.getSessionId?.(), fileExists);
  }

  // /rx — phase-aware dispatcher: figures out the next stage from the state machine and injects the
  // matching stage playbook, so you never type the stage yourself. Playbooks are BUNDLED with the
  // plugin (stages/), so the workflow is self-contained — no dependency on ~/.claude/commands
  // or ~/.claude/workflow. Bundled assets the playbooks read (workflow/*.md) resolve via $RX_PLUGIN.
  const PLUGIN_ROOT = PLUGIN_DIR;
  const STAGES_DIR = path.join(PLUGIN_ROOT, "stages");
  function dispatch(cmd: string, ticket: string, note: string) {
    if (ticket) {
      const cwd = ui?.cwd || process.cwd();
      const dir = repoStateDir(cwd);
      const phase = (dir ? readStates(dir).find((s) => s.ticket === ticket)?.phase : undefined) ?? "started";
      nameHerdrWorkspace(ticket, phase, cwd);
    }
    const file = path.join(STAGES_DIR, `rx-${cmd}.md`);
    let body: string;
    try {
      body = fs.readFileSync(file, "utf8");
    } catch {
      pi.logger?.warn?.(`pi-rx: missing command file ${file}`);
      return false;
    }
    body = body.replace(/^---\n[\s\S]*?\n---\n/, ""); // strip frontmatter
    // Same substitution pi does when expanding a slash command's $1/$2, plus $RX_PLUGIN → the plugin
    // root so bundled playbooks read their bundled assets (workflow/*.md) with no ~/.claude dependency.
    body = body.replaceAll("$RX_PLUGIN", PLUGIN_ROOT).replaceAll("$1", ticket).replaceAll("$2", note);
    // Last, so ticket text in the source prompt is never touched by the $1/$2 substitution above.
    if (cmd === "start") body = body.replaceAll("$RX_SOURCE", sourcePrompt(ticket, ui?.cwd || process.cwd()));
    pi.sendUserMessage(body);
    return true;
  }

  /** The requirement step for /rx-start: the ticket's source prompt (recorded at intake, else matched
   *  from the id — legacy states and resumes), rendered for this ticket. */
  function sourcePrompt(ticket: string, cwd: string): string {
    const dir = repoStateDir(cwd);
    const st = dir ? readStates(dir).find((s) => s.ticket === ticket) : undefined;
    const intake = dir ? readIntake(dir, ticket) : null;
    const repo = repoRoot(cwd);
    const sources = loadSources(sourceDirs(repo));
    const name = st?.source ?? intake?.source ?? resolveTicket(ticket, sources, readConfig(repo))?.source.name ?? "text";
    const ref = st?.source_ref ?? intake?.source_ref ?? ticket;
    const src = sources.find((s) => s.name === name);
    if (!src) return `No ticket source named "${name}" is installed. Ask the user for ${ticket}'s requirement.`;
    return `Ticket source: **${src.name}** (\`${src.file}\`)\n\n${renderSource(src, ticket, ref)}`;
  }

  pi.registerCommand("rx", {
    description: "Do the next Rx stage. Accepts a ticket id or URL (Linear, GitHub, or any ticket source you add), or a free-text task.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      ui = ctx;
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) {
        if (ctx.hasUI) ctx.ui.notify("rx: not inside a git repo", "error");
        return;
      }
      const active = readStates(dir).filter(isActive);

      // Classify the argument three ways:
      //   /rx ENG-1234 [note]      → bare ticket id
      //   /rx <linear-url> [note]  → id extracted from the URL
      //   /rx improve logging …    → no id → ad-hoc pipeline, the text IS the requirement
      //   /rx                      → drive the active ticket
      const raw = args.trim();
      const toks = raw.split(/\s+/).filter(Boolean);
      // A stage word runs that stage on this pane's ticket instead of starting a task named after it:
      // `/rx approve`, `/rx status`, `/rx reject too broad`.
      const word = (toks[0] ?? "").toLowerCase();
      if (STAGE_WORDS.has(word) && (toks.length === 1 || NOTE_STAGES.has(word))) {
        await runStage(word, toks.slice(1).join(" "), dir, ctx);
        return;
      }
      // An id this repo already tracks wins over every other reading (free-text ids look like plain words).
      let ticket = "";
      if (toks[0] && active.some((s) => s.ticket === toks[0])) ticket = toks[0];
      else {
        const repo = repoRoot(ctx.cwd || process.cwd());
        const hit = resolveTicket(toks[0] ?? "", loadSources(sourceDirs(repo)), readConfig(repo));
        if (hit) {
          ticket = hit.id;
          if (!readStates(dir).some((s) => s.ticket === ticket)) writeIntake(dir, ticket, { source: hit.source.name, source_ref: toks[0] });
        }
      }
      let note = "";
      let startDesc = ""; // free text: the requirement handed to rx-start as $2
      if (ticket) {
        toks.shift();
        note = toks.join(" ");
      } else if (raw) {
        // Free text → a short id; the same task typed again (filler words aside) drives the existing one.
        const t = textTaskId(dir, raw);
        ticket = t.id;
        if (!t.existing) {
          writeIntake(dir, ticket, { source: "text", source_ref: raw, requirement: raw });
          startDesc = raw;
        }
      }

      // New ticket (real id or ad-hoc slug) not yet tracked → start the pipeline.
      if (ticket && !active.some((s) => s.ticket === ticket)) {
        dispatch("start", ticket, startDesc || note);
        return;
      }
      // Bare /rx inside Herd → reconcile: every OTHER active ticket without a live Space gets one
      // (and an omp spawned to resume it), so reopening Herd reconstitutes the whole in-flight
      // workload. The ticket THIS pane owns is then driven in-place below.
      if (!ticket) {
        if (!active.length) {
          if (ctx.hasUI) ctx.ui.notify("rx: no pipelines — /rx ENG-1234 to start one", "info");
          return;
        }
        const mine = currentTicket(dir, ctx, true); // interactive: guessing the lone ticket is intended here
        if (process.env.HERDR_ENV === "1") {
          const spawned: string[] = [];
          for (const t of active) {
            if (mine && t.ticket === mine.ticket) continue;
            if (spaceForTicket(t)) continue;
            const sp = ensureSpace(dir, t.ticket, t.phase, repoRoot(ctx.cwd || process.cwd()) || ctx.cwd || process.cwd());
            if (sp?.created) {
              spawnOmpInSpace(sp.rootPane, t.ticket);
              spawned.push(t.ticket);
            }
          }
          if (spawned.length && ctx.hasUI) ctx.ui.notify(`rx: spawned Space + omp for ${spawned.join(", ")}`, "info");
        }
        if (!mine) {
          if (ctx.hasUI) ctx.ui.notify(active.length === 1 ? "rx: nothing to drive here" : "rx: each active ticket now has its own Space", "info");
          return;
        }
        ticket = mine.ticket;
      }
      const s = active.find((x) => x.ticket === ticket)!;

      // A freshly-spawned omp (bare-/rx fan-out) carries RX_LAND=<ticket> from its Space's env: LAND on
      // the ticket — bind THIS session to it and show status — then stop. Deterministic on purpose: we do
      // NOT switchSession into the ticket's old transcript (that file is namespaced by the cwd it was
      // recorded in, so it resumes only sometimes and, when it does, yanks you into a stale conversation)
      // and we do NOT drive/gate (that's a deliberate later /rx). One-shot: consume the flag so the next
      // /rx in this session drives normally. The audit log + status give the full picture.
      if (process.env.RX_LAND === ticket) {
        delete process.env.RX_LAND;
        bindSession(dir, ticket, ctx);
        if (s.phase === "pr-open") ensureWatch(dir, ticket); // self-heal the watcher for a PR being re-landed
        dispatch("status", ticket, "");
        return;
      }

      // Interactive /rx: if the ticket is bound to a different omp session (relaunch → fresh session),
      // offer to reopen that past conversation instead of driving blind. Declining rebinds it to THIS
      // session, so the pointer always tracks where work continues.
      if (hasResumableSession(s, ctx)) {
        const choice = ctx.hasUI
          ? await ctx.ui.select(`${ticket} has a saved session (phase ${s.phase})`, ["resume its past conversation", "continue in this session"])
          : "resume its past conversation";
        if (!choice) return;
        if (choice.startsWith("resume")) {
          await ctx.switchSession(s.session_file!);
          return; // the restored session takes over — it already knows where it left off
        }
      }
      bindSession(dir, ticket, ctx);

      // Phase → next stage. Gates with a human decision ask; the rest just go.
      switch (s.phase) {
        case "started":
          dispatch("start", ticket, note); // resumes the interrupted start
          return;
        case "awaiting-approval": {
          if (!ctx.hasUI) return void dispatch("status", ticket, "");
          const choice = await ctx.ui.select(`${ticket} is at the gate`, ["approve", "reject", "abort"]);
          if (!choice) return;
          if ((choice === "reject" || choice === "abort") && !note) {
            note = (await ctx.ui.input(choice === "abort" ? "Reason for abandoning?" : "Objection?")) ?? "";
            if (!note) return;
          }
          dispatch(choice, ticket, note);
          return;
        }
        case "approved":
          dispatch("approve", ticket, note); // resumes implementation
          return;
        case "implemented":
          dispatch("pr", ticket, note);
          return;
        case "pr-open": {
          ensureWatch(dir, ticket); // self-heal: a PR-open ticket should always have a live watcher
          if (!ctx.hasUI) return void dispatch("status", ticket, "");
          const choice = await ctx.ui.select(`${ticket} PR #${s.pr_number ?? "?"} is open`, [
            "rework — comments need real work",
            "cleanup — PR is merged",
            "abort — abandon this ticket",
            "status",
          ]);
          if (!choice) return;
          const cmd = choice.split(/\s|—/)[0];
          if (cmd === "rework" && !note) {
            note = (await ctx.ui.input("What do the comments ask for?")) ?? "";
            if (!note) return;
          }
          if (cmd === "abort" && !note) {
            note = (await ctx.ui.input("Reason for abandoning?")) ?? "";
            if (!note) return;
          }
          dispatch(cmd, ticket, note);
          return;
        }
        default:
          if (ctx.hasUI) ctx.ui.notify(`rx: ${ticket} is ${s.phase} — nothing to do`, "info");
      }
    },
  });

  // Stage commands — each injects its BUNDLED playbook (stages/rx-<cmd>.md) via dispatch().
  // These used to be standalone ~/.claude/commands/rx-*.md slash commands; the plugin now owns them so
  // the workflow is self-contained. /rx is still the phase-aware orchestrator; these are the explicit
  // per-stage entries (and the targets /rx, /rx-approve links, and notify replies name).
  const STAGE_DESCRIPTIONS: Record<string, string> = {
    start: "Start the Rx pipeline: worktree + test plan + pseudocode design (→ approval gate).",
    approve: "Approve the design at the gate and implement the ticket.",
    reject: "Reject the design at the gate with an objection; the agent revises.",
    pr: "Open the pull request for an implemented ticket.",
    cleanup: "Clean up after a merged PR (worktree, branch, state).",
    abort: "Abort/abandon a ticket at any phase — tear down its worktree, branch, watcher, artifacts.",
    rework: "Rework a PR whose review comments need real changes.",
    improve: "Improve/iterate on an in-flight ticket.",
    retro: "Aggregate deviations into the workflow retrospective.",
    status: "Show Rx pipeline status for this repo (optionally one ticket).",
  };
  function resolveStageTicket(cmd: string, args: string): { ticket: string; note: string } {
    const raw = args.trim();
    const toks = raw.split(/\s+/).filter(Boolean);
    const dir = repoStateDir(ui?.cwd || process.cwd());
    const states = dir ? readStates(dir) : [];
    if (toks[0] && states.some((s) => s.ticket === toks[0])) return { ticket: toks[0], note: toks.slice(1).join(" ") };
    const repo = repoRoot(ui?.cwd || process.cwd());
    const hit = resolveTicket(toks[0] ?? "", loadSources(sourceDirs(repo)), readConfig(repo));
    if (hit) {
      if (cmd === "start" && dir && !states.some((s) => s.ticket === hit.id))
        writeIntake(dir, hit.id, { source: hit.source.name, source_ref: toks[0] });
      return { ticket: hit.id, note: toks.slice(1).join(" ") };
    }
    if (cmd === "start" && raw && dir) {
      // Free-text task: the text IS the requirement — record it before the start runs.
      const t = textTaskId(dir, raw);
      if (!t.existing) writeIntake(dir, t.id, { source: "text", source_ref: raw, requirement: raw });
      return { ticket: t.id, note: raw };
    }
    // No id given: drive the lone active ticket (status/retro tolerate none).
    const active = states.filter(isActive);
    return { ticket: active.length === 1 ? active[0].ticket : "", note: raw };
  }

  /** `/rx <stage word> [notes]`: run that stage on this pane's ticket (else the lone active one). */
  async function runStage(cmd: string, note: string, dir: string, ctx: ExtensionCommandContext) {
    if (cmd === "review") {
      await openReview("", ctx);
      return;
    }
    const ticket = currentTicket(dir, ctx, true)?.ticket ?? resolveStageTicket(cmd, "").ticket;
    if (!ticket && cmd !== "status" && cmd !== "retro") {
      if (ctx.hasUI) ctx.ui.notify(`rx: which ticket? /rx-${cmd} <ticket>`, "info");
      return;
    }
    dispatch(cmd, ticket, note);
  }
  for (const cmd of Object.keys(STAGE_DESCRIPTIONS)) {
    const handler = async (args: string, ctx: ExtensionCommandContext) => {
      ui = ctx;
      const { ticket, note } = resolveStageTicket(cmd, args);
      if (!dispatch(cmd, ticket, note) && ctx.hasUI) ctx.ui.notify(`rx-${cmd}: missing bundled playbook`, "error");
    };
    pi.registerCommand(`rx-${cmd}`, { description: STAGE_DESCRIPTIONS[cmd], handler });
    pi.registerCommand(`task-${cmd}`, { description: STAGE_DESCRIPTIONS[cmd], handler });
    pi.registerCommand(`flow-${cmd}`, { description: STAGE_DESCRIPTIONS[cmd], handler });
  }

  // Generic command aliases for main entry points (/task, /flow)
  pi.registerCommand("task", {
    description: "Do the next stage for a task or ticket. Generic alias for /rx.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const rxHandler = (pi as any).commands?.get?.("rx")?.handler;
      if (rxHandler) await rxHandler(args, ctx);
    },
  });
  pi.registerCommand("flow", {
    description: "Do the next stage for a workflow. Generic alias for /rx.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const rxHandler = (pi as any).commands?.get?.("rx")?.handler;
      if (rxHandler) await rxHandler(args, ctx);
    },
  });

  /** Deliver a batch-level submit verdict into the session. `pi.sendUserMessage` always triggers a
   *  turn, so this wakes an idle session on its own. */
  function handleFeedback(dir: string, ticket: string, fb: { kind?: string; comment?: string }) {
    pi.logger?.info?.(`pi-rx: review submit for ${ticket}: ${fb?.kind ?? "comment"}`);
    if (fb?.kind === "approve") {
      // approval ends the review — leave it so no await loop lingers
      stopReview();
      dispatch("approve", ticket, ""); // runs the real gate → implements
      return;
    }
    if (fb?.kind === "revise") {
      const note = String(fb.comment ?? "").trim();
      applyTransition(dir, ticket, "awaiting-approval", note || "review requested changes");
      pi.sendUserMessage(
        `Design review for ${ticket} — the reviewer requested changes${note ? `: ${note}` : " (see the comments already delivered)"}.\n` +
          `First log it as evidence:\n` +
          `  rx_deviation "${ticket}" auto request-changes "${note || "see review notes"}" "<what the design had that drew the request>" "reviewer asked for changes — <why the design missed it>"\n` +
          `Then revise the canonical pseudocode markdown. The review page live-reloads on your edits — ` +
          `no re-run needed. Stay at the approval gate.`,
      );
      return;
    }
    const body = String(fb?.comment ?? "").trim();
    if (body)
      pi.sendUserMessage(
        `Design review note on ${ticket}: ${body}\n` +
          `Fold the decision into the canonical pseudocode markdown (the page live-reloads — no re-run). ` +
          `Stay at the gate; if it needs a judgment call, resolve it as an open question with your recommendation.`,
        { deliverAs: "followUp" },
      );
  }

  /** Answer in a review thread through Co-Review's `reply` tool — it shows live in the reviewer's
   *  window. Uses the open review's MCP session; with none (e.g. after a reload) it joins the ticket's
   *  recorded review for the one call. Shared by the fast Q&A path and the `rx_review_reply` tool. */
  async function postReviewReply(dir: string, ticket: string, threadId: string, body: string): Promise<void> {
    if (htmlReview?.ticket === ticket) throw new Error("the HTML review page has no reply threads — answer the reviewer in chat");
    if (reviewInfo?.ticket === ticket) {
      await reviewInfo.conn.call("reply", { reviewId: reviewInfo.reviewId, threadId, body });
      return;
    }
    const st = readStates(dir).find((s) => s.ticket === ticket);
    if (!st?.review_id) throw new Error(`no Co-Review review recorded for ${ticket} — run /rx-review first`);
    const conn = new CoReview(st.worktree || repoRoot(process.cwd()) || process.cwd());
    try {
      await conn.call("open_review", { reviewId: st.review_id, open: false });
      await conn.call("reply", { reviewId: st.review_id, threadId, body });
    } finally {
      conn.close();
    }
  }

  /** Answer a pure question straight from the pseudocode doc with one stateless, non-agentic
   *  completion call (reasoning disabled) — the trivial-lookup case pays the same latency as a
   *  real design decision when routed through the full heavy-reasoning session below. Returns
   *  null on any failure (no model, no key, empty answer) so the caller falls back to the agent. */
  async function answerQuestionFast(ctx: ExtensionContext, doc: string, comment: ReviewComment): Promise<string | null> {
    const model = ctx.model;
    if (!model) return null;
    try {
      // Host-neutral: omp's pi-ai, else pi's; omp hands out a key, pi a key plus headers.
      const ai: any = await import("@oh-my-pi/pi-ai").catch(() => import("@earendil-works/pi-ai"));
      const reg: any = ctx.modelRegistry;
      const auth = reg.getApiKey ? { apiKey: await reg.getApiKey(model) } : await reg.getApiKeyAndHeaders?.(model);
      if (!auth || auth.ok === false) return null;
      const reply = await ai.completeSimple(
        model,
        {
          systemPrompt: [
            "Answer a reviewer's question about the pseudocode design doc below, ONLY from the doc and the " +
              "quoted selection. 1–2 plain sentences, no markdown, no preamble. If the doc doesn't answer it, " +
              "say so plainly instead of guessing — never propose or describe a design change.",
          ],
          messages: [
            {
              role: "user",
              content: `Design doc:\n${doc}\n\nReviewer highlighted: ${describeAnchor(comment.anchor)}\nQuestion: ${comment.body}`,
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey: auth.apiKey, headers: auth.headers, disableReasoning: true },
      );
      const text = reply.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("")
        .trim();
      return text || null;
    } catch (err) {
      pi.logger?.debug?.(`pi-rx: fast Q&A answer failed: ${err}`);
      return null;
    }
  }

  /** Deliver every review comment that landed since the last poll tick as ONE consolidated message —
   *  not one `sendUserMessage` turn per comment. Earlier this fired a separate followUp per comment
   *  (`for (const c of fresh) setTimeout(() => deliverComment(...), 0)`), so a reviewer leaving several
   *  comments in one pass (e.g. "same as above", or a question that only makes sense next to the
   *  comment above it) got them split across isolated turns with no shared context — a concrete
   *  mechanism behind "comments aren't always understood correctly". Each item still carries its exact
   *  anchor + threadId so a reply lands in the right thread. Forces an explicit READ before an edit:
   *  a comment posing a QUESTION ("why…", "what about…", "?") needs an ANSWER via `rx_review_reply`
   *  before/instead of silently changing the design; a comment stating a DECISION/DIRECTIVE gets
   *  folded into the pseudocode AND a brief reply confirming what changed; a genuinely ambiguous one
   *  gets a clarifying question back, never a guess.
   *
   *  Pure questions (body ends "?") skip that whole full-agent turn first: `answerQuestionFast`
   *  answers them directly off the doc with reasoning disabled, and the reply posts immediately.
   *  Anything that isn't a clean question, or whose fast answer/post fails, still goes to the agent
   *  below — the fast path is a latency shortcut, never the only path a comment can take. */
  async function deliverComments(dir: string, ticket: string, comments: ReviewComment[]) {
    for (const c of comments) pi.logger?.info?.(`pi-rx: review comment for ${ticket} on ${c.threadId}`);
    // Resolve each anchor to a fresh line range in the CURRENT pseudocode so the agent edits that
    // region in place instead of re-reading/rewriting the whole doc. Read once per delivery (all
    // comments target the same artifact); fall back to no range when it can't be located.
    const st = readStates(dir).find((s) => s.ticket === ticket);
    const target = st?.pseudocode ?? "";
    const ppath = st ? resolvePseudocodePath(st) : null;
    let content = "";
    try {
      if (ppath && fs.existsSync(ppath)) content = fs.readFileSync(ppath, "utf8");
    } catch {
      /* best-effort — no range, agent reads normally */
    }

    const live = reviewInfo?.ticket === ticket;
    const rest: ReviewComment[] = [];
    await Promise.all(
      comments.map(async (c) => {
        const isQuestion = live && ui?.model && content && c.body.trim().endsWith("?");
        if (!isQuestion) {
          rest.push(c);
          return;
        }
        const answer = await answerQuestionFast(ui!, content, c);
        const posted = answer ? await postReviewReply(dir, ticket, c.threadId, answer).then(() => true, () => false) : false;
        if (!posted) rest.push(c);
      }),
    );
    if (!rest.length) return;

    const items = rest
      .map((c, i) => {
        const loc = content ? locateAnchor(content, c.anchor) : null;
        const at = loc ? `\n   → edit ${target}:${loc.start}${loc.end !== loc.start ? `-${loc.end}` : ""} in place (read only that range)` : "";
        return `${i + 1}. [thread ${c.threadId}] ${describeAnchor(c.anchor)}${at}\n   "${c.body}"`;
      })
      .join("\n");
    const plural = rest.length > 1;
    pi.sendUserMessage(
      `Design review comment${plural ? "s" : ""} on ${ticket} (${rest.length} new, address every one — ` +
        `don't stop after the first):\n${items}\n\n` +
        `For EACH one, first decide what kind of comment it is, then act accordingly — do not guess at intent:\n` +
        `  • QUESTION (asks "why"/"what about"/ends in "?") → answer it with rx_review_reply BEFORE (or ` +
        `instead of) touching the design; only edit the pseudocode if the answer implies a real change.\n` +
        `  • DECISION/DIRECTIVE (tells you to change something) → fold it into the canonical pseudocode ` +
        `markdown at the line range shown — read ONLY that range and edit it in place; do NOT read or ` +
        `rewrite the whole doc (if no range is shown, locate the quoted text first). The review page ` +
        `live-reloads — no re-run. Then rx_review_reply with a one-line confirmation of exactly what changed.\n` +
        `  • Genuinely ambiguous → rx_review_reply with a clarifying question; never silently guess and ` +
        `fold the wrong thing.\n` +
      (htmlReview?.ticket === ticket
        ? `This review is the HTML page (Co-Review isn't installed), which has no reply threads: wherever ` +
          `the steps above say rx_review_reply, answer in chat instead. `
        : `Use each comment's own threadId when replying. `) +
      `Replies MUST read like a human reviewer typed ` +
      `them: 1–2 plain sentences, no headings/bullets/preamble — expand only if the reviewer asks for ` +
      `more detail. Stay at the approval gate.`,
      { deliverAs: "followUp" },
    );
  }

  /** Wait on the reviewer (await_reviewer) until the review ends: deliver each NEW comment the moment
   *  it's posted (with its exact anchor) and drive the gate on Submit. Cursors persist on the ticket
   *  (review_delivered / review_round) so a restart neither drops nor replays. Stops when superseded
   *  (stopReview bumps reviewGen) or when the reviewer closes the review. */
  async function watchReview(dir: string, ticket: string, reviewId: string, store: string, conn: CoReview, gen: number) {
    const persisted = readStates(dir).find((s) => s.ticket === ticket);
    const delivered = new Set<string>(Array.isArray(persisted?.review_delivered) ? persisted!.review_delivered : []);
    let lastRound = Number(persisted?.review_round ?? 0);
    const readStore = (): ReviewStore | null => {
      try {
        return JSON.parse(fs.readFileSync(store, "utf8"));
      } catch {
        return null;
      }
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    while (gen === reviewGen) {
      let r: CoReviewWait;
      try {
        r = await conn.call<CoReviewWait>("await_reviewer", { reviewId, timeoutSec: 240 }, 300_000);
      } catch (e) {
        if (gen !== reviewGen) return;
        pi.logger?.warn?.(`pi-rx: await_reviewer for ${ticket}: ${e}`);
        await sleep(5000);
        // A dropped bridge restarts on the next call: rejoin the review first, without re-showing it.
        if (gen === reviewGen) await conn.call("open_review", { reviewId, open: false }).catch(() => {});
        continue;
      }
      if (gen !== reviewGen) return;
      if (r.status === "comment") {
        const fresh = reviewComments(r.threads ?? [], readStore(), delivered);
        if (!fresh.length) {
          await sleep(3000); // only threads already handed to the agent, still waiting on its reply
          continue;
        }
        for (const c of fresh) for (const k of c.keys) delivered.add(k);
        patchState(dir, ticket, { review_delivered: [...delivered] });
        void deliverComments(dir, ticket, fresh);
      } else if (r.status === "submitted") {
        const round = Number(r.round ?? lastRound + 1);
        if (round <= lastRound) {
          await sleep(3000);
          continue;
        }
        lastRound = round;
        patchState(dir, ticket, { review_round: round });
        const summary = String(r.summary ?? "").trim();
        const verdict = reviewVerdict(r.decision);
        if (verdict === "approve") handleFeedback(dir, ticket, { kind: "approve" });
        else if (verdict === "revise") handleFeedback(dir, ticket, { kind: "revise", comment: summary });
        else if (summary) handleFeedback(dir, ticket, { comment: summary });
      } else if (r.status === "closed") {
        if (ui?.hasUI) ui.ui.notify(`rx-review ${ticket}: the review was closed in Co-Review — /rx-review ${ticket} reopens it`, "info");
        if (gen === reviewGen) stopReview();
        return;
      }
    }
  }

  /** Fallback when Co-Review isn't installed: serve the pseudocode-design live HTML page (render_html.py
   *  --live + live_review.py) on a free localhost port. The page's comments, Approve and Request-changes
   *  land in a feedback.jsonl that is polled into the same gate as Co-Review's Submit; the page is
   *  re-rendered whenever the pseudocode changes and reloads itself. Runs until stopReview. */
  async function startHtmlReview(dir: string, ticket: string, artifact: string, osDir: string, ctx: ExtensionContext): Promise<string> {
    const skill = pseudocodeSkillDir(PLUGIN_ROOT);
    if (!skill) {
      if (ctx.hasUI)
        ctx.ui.notify(
          `rx-review: Co-Review isn't installed and the pseudocode-design skill wasn't found for the HTML fallback — ` +
            `install Co-Review (https://sdsvn.github.io/co-review/) or set RX_PSEUDOCODE_SKILL`,
          "error",
        );
      return "rx-review: Co-Review isn't installed and the pseudocode-design skill wasn't found for the HTML fallback";
    }
    const work = path.join(os.tmpdir(), `rx-review-${path.basename(dir)}-${ticket.replace(/[^A-Za-z0-9_.-]/g, "_")}`);
    fs.mkdirSync(work, { recursive: true });
    const page = path.join(work, "design.html");
    const feedback = path.join(work, "feedback.jsonl");
    fs.writeFileSync(feedback, ""); // a fresh review: never replay an earlier run's feedback
    const render = () =>
      execFileSync(
        "python3",
        [path.join(skill, "scripts", "render_html.py"), artifact, "--live", "-o", page, ...(osDir && fs.existsSync(osDir) ? ["--openspec-dir", osDir] : [])],
        { stdio: "pipe" },
      );
    try {
      render();
    } catch (e) {
      if (ctx.hasUI) ctx.ui.notify(`rx-review: couldn't render ${ticket}'s design page: ${(e as Error).message}`, "error");
      return `rx-review: couldn't render ${ticket}'s design page: ${(e as Error).message}`;
    }
    const port = await freePort();
    const server = spawn("python3", [path.join(skill, "scripts", "live_review.py"), page, feedback, String(port)], { stdio: "ignore" });
    server.on("error", (e) => pi.logger?.warn?.(`pi-rx: HTML review server for ${ticket}: ${e}`));
    const url = `http://127.0.0.1:${port}`;

    // Re-render on every pseudocode edit; the open page polls /version and reloads.
    const onChange = (cur: fs.Stats, prev: fs.Stats) => {
      if (cur.mtimeMs === prev.mtimeMs) return;
      try {
        render();
      } catch (e) {
        pi.logger?.warn?.(`pi-rx: re-render of ${ticket}'s design page failed: ${e}`);
      }
    };
    fs.watchFile(artifact, { interval: 1000 }, onChange);

    // Poll the feedback file: node/general comments → deliverComments; approve/revise → the gate.
    let offset = 0;
    let n = 0;
    const poll = setInterval(() => {
      let text = "";
      try {
        const size = fs.statSync(feedback).size;
        if (size <= offset) return;
        const fd = fs.openSync(feedback, "r");
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        const end = buf.lastIndexOf(10) + 1; // only whole lines; a partial one waits for the next tick
        if (!end) return;
        offset += end;
        text = buf.subarray(0, end).toString("utf8");
      } catch {
        return;
      }
      const comments: ReviewComment[] = [];
      for (const line of text.split("\n")) {
        let fb: { kind?: string; node?: string | null; comment?: string };
        try {
          fb = JSON.parse(line);
        } catch {
          continue;
        }
        if (fb.kind === "approve" || fb.kind === "revise") {
          if (comments.length) void deliverComments(dir, ticket, comments.splice(0));
          handleFeedback(dir, ticket, fb);
          if (fb.kind === "approve") return; // handleFeedback ended the review
          continue;
        }
        const body = String(fb.comment ?? "").trim();
        if (!body) continue;
        const anchor: ReviewAnchor | undefined = fb.node ? { type: "tree-node", nodeId: fb.node, exact: fb.node } : undefined;
        comments.push({ threadId: `html-${++n}`, anchor, body });
      }
      if (comments.length) void deliverComments(dir, ticket, comments);
    }, 1000);

    htmlReview = {
      ticket,
      url,
      stop: () => {
        clearInterval(poll);
        fs.unwatchFile(artifact, onChange);
        server.kill();
      },
    };
    if (ctx.hasUI)
      ctx.ui.notify(
        `rx-review ${ticket} — open ${url} to review the design (Co-Review isn't installed, so this is the HTML page). ` +
          `Install Co-Review for threaded review with replies: https://sdsvn.github.io/co-review/`,
        "info",
      );
    return `rx-review ${ticket}: HTML review page at ${url} (Co-Review isn't installed — recommend installing it: https://sdsvn.github.io/co-review/)`;
  }

  pi.registerCommand("rx-review", {
    description: "Open the pseudocode design in Co-Review (plus a 'design changes since approved' diff tab on a re-review), or a local HTML review page when Co-Review isn't installed; the reviewer's Submit drives the gate",
    handler: async (args: string, ctx: ExtensionContext) => {
      await openReview(args, ctx);
    },
  });

  // rx_review_open — the tool form of /rx-review, called by the stage playbooks once the design is at
  // the gate (end of /rx-start, /rx-rework), so the human never has to type /rx-review.
  pi.registerTool({
    name: "rx_review_open",
    label: "Rx Review Open",
    description:
      "Open the ticket's design review for the human — Co-Review, or a local HTML review page when Co-Review " +
      "isn't installed. Call it once the ticket is at awaiting-approval and the pseudocode is final for this " +
      "round. The reviewer's comments and verdict then arrive as messages; don't wait or poll.",
    parameters: Type.Object({ ticket: Type.String({ description: "Ticket id at the approval gate." }) }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const { ticket } = rawParams as { ticket: string };
      const c = ctx as ExtensionContext;
      if (!PIPELINE_ID.test(ticket)) return { content: [{ type: "text", text: `rx: invalid ticket '${ticket}'.` }], isError: true };
      if (!c.hasUI) return { content: [{ type: "text", text: "rx: no interactive session — skipped the review (the human runs /rx-review)." }] };
      const text = await openReview(ticket, c);
      return { content: [{ type: "text", text }], isError: !/^rx-review \S+: (open|HTML)/.test(text) };
    },
  });

  /** /rx-review's body — also run automatically when a ticket arrives at the approval gate. */
  async function openReview(args: string, ctx: ExtensionContext): Promise<string> {
    ui = ctx;
    const toks = args.trim().split(/\s+/).filter(Boolean);
    let ticket = toks[0] && PIPELINE_ID.test(toks[0]) ? toks.shift()! : "";
    const dir = repoStateDir(ctx.cwd || process.cwd());
    if (!dir) {
      if (ctx.hasUI) ctx.ui.notify("rx: not inside a git repo", "error");
      return "rx: not inside a git repo";
    }
    if (!ticket) {
      // Infer like /rx does: session/Space binding first (this pane's ticket), then the lone
      // gated ticket; only then ask — the reviewer shouldn't retype the id every re-review.
      const bound = currentTicket(dir, ctx, true);
      const gated = readStates(dir).filter((s) => s.phase === "awaiting-approval");
      if (bound && (bound.phase === "awaiting-approval" || bound.pseudocode)) ticket = bound.ticket;
      else if (gated.length === 1) ticket = gated[0].ticket;
      else {
        const names = gated.map((s) => s.ticket).join(", ");
        if (ctx.hasUI)
          ctx.ui.notify(
            gated.length ? `rx-review: which ticket? at the gate: ${names}` : "rx-review: name a ticket at the approval gate",
            "info",
          );
        return gated.length ? `rx-review: which ticket? at the gate: ${names}` : "rx-review: no ticket at the approval gate";
      }
    }
    const st = readStates(dir).find((s) => s.ticket === ticket);
    if (!st || !st.pseudocode) {
      if (ctx.hasUI) ctx.ui.notify(`rx-review: ${ticket} has no pseudocode artifact yet`, "error");
      return `rx-review: ${ticket} has no pseudocode artifact yet`;
    }
    if (isPrpArtifactPath(st.pseudocode)) {
      if (ctx.hasUI) ctx.ui.notify(`rx-review: ${ticket} still points at a retired PRP path`, "error");
      pi.sendUserMessage(
        `rx-review refused: ${ticket} still points at retired PRP path \`${st.pseudocode}\`. ` +
          `Rx reviews the canonical pseudocode artifact and implements from that plus OpenSpec deltas — not PRP. ` +
          `Rewrite the ticket's pseudocode path, then re-run /rx-review ${ticket}.`,
      );
      return `rx-review refused: ${ticket} still points at a retired PRP path`;
    }
    bindSession(dir, ticket, ctx); // the design-gate session is the one worth resuming later
    const artifact = path.isAbsolute(st.pseudocode)
      ? st.pseudocode
      : path.join(st.worktree || repoRoot(ctx.cwd || process.cwd()) || "", st.pseudocode);

    // Strict structure gate: the review renderer shows only Context/Design/Diagrams/Open Questions
    // and drops everything else, so a non-conforming artifact renders blank. Refuse to host it and
    // tell the human (and the agent) exactly what to fix, rather than open an empty page.
    const structure = validatePseudocode(fs.readFileSync(artifact, "utf8"));
    if (!structure.ok) {
      const detail = structure.problems.map((p) => `  • ${p}`).join("\n");
      if (ctx.hasUI) ctx.ui.notify(`rx-review: ${ticket} pseudocode won't render — fix its structure`, "error");
      pi.sendUserMessage(
        `rx-review refused: ${path.basename(artifact)} does not match the pseudocode-design render contract ` +
          `(skills/pseudocode-design in the pi-rx plugin). Fix these, then re-run /rx-review ${ticket}:\n${detail}\n` +
          `The artifact MUST use only these \`##\` headings — Context / Design / Diagrams / Open Questions — ` +
          `with Context, Design, and Open Questions present, and all decisions folded inline into the Design list. See pseudocode-structure.md in the pi-rx plugin.`,
      );
      return `rx-review refused: the pseudocode doesn't match the render contract:\n${detail}`;
    }
    // Re-review? Surface WHAT CHANGED on top of the approved design as a diff tab beside the plan.
    refreshDesignDelta(artifact, ticket, st.design_rev ?? 0);
    const store = path.join(dir, `${ticket}.review.json`);
    // The review UI is Co-Review (github.com/sdsvn/co-review), driven over its MCP tools through
    // `co-review mcp <repo>`: open_review shows the whole disposable artifact dir (pseudocode doc +
    // any *.diff), await_reviewer waits for comments and the Submit, reply answers in a thread.
    // Co-Review also writes the review state to `store` (read by rx_status / readReviewState).
    const root = st.worktree || repoRoot(ctx.cwd || process.cwd()) || ctx.cwd || process.cwd();
    const osDir = st.openspec_change
      ? path.join(os.homedir(), ".claude", "workflow", "openspec", path.basename(dir), "openspec", "changes", st.openspec_change)
      : "";
    stopReview(); // leave whatever review this session had open (another ticket's, or this one's before a re-run)
    if (!coReviewBin()) {
      return startHtmlReview(dir, ticket, artifact, osDir, ctx);
    }
    const conn = new CoReview(root);
    type Opened = { reviewId: string; url?: string; format?: { warnings?: string[] } };
    let opened: Opened | null = null;
    try {
      // Rejoin the ticket's review when it still exists (its threads and cursors carry over; Co-Review
      // re-reads the rewritten doc and refreshed *.diff off disk); otherwise open the dir as a new one.
      if (st.review_id) opened = await conn.call<Opened>("open_review", { reviewId: st.review_id }).catch(() => null);
      opened ??= await conn.call<Opened>("open_review", {
        root,
        dir: path.dirname(artifact),
        title: `${ticket} design`,
        storePath: store,
        ...(osDir && fs.existsSync(osDir) ? { openspec: osDir } : {}),
      });
    } catch (e) {
      conn.close();
      if (ctx.hasUI) ctx.ui.notify(`rx-review: Co-Review didn't open ${ticket}: ${(e as Error).message}`, "error");
      pi.logger?.warn?.(`pi-rx: open_review for ${ticket}: ${e}`);
      return `rx-review: Co-Review didn't open ${ticket}: ${(e as Error).message}`;
    }
    const reviewId = opened.reviewId;
    // A new review starts its own threads and rounds: reset the delivery cursors with it.
    patchState(dir, ticket, {
      review_id: reviewId,
      review_store: store,
      ...(reviewId !== st.review_id ? { review_delivered: [], review_round: 0 } : {}),
    });
    reviewInfo = { ticket, reviewId, store, conn };
    if (opened.format?.warnings?.length) pi.logger?.debug?.(`pi-rx: Co-Review format notes for ${ticket}: ${opened.format.warnings.join(" ")}`);
    if (ctx.hasUI) ctx.ui.notify(`rx-review ${ticket} — open in Co-Review${opened.url ? `: ${opened.url}` : ""}`, "info");
    void watchReview(dir, ticket, reviewId, store, conn, reviewGen);
    return `rx-review ${ticket}: open in Co-Review${opened.url ? ` (${opened.url})` : ""}`;
  }

  // rx_review_reply — post an agent reply into a review thread through Co-Review's `reply` tool, so it
  // shows live in the reviewer's window. Use when a reply adds value (answering a question, confirming
  // a comment was folded) — not a bare acknowledgement.
  pi.registerTool({
    name: "rx_review_reply",
    label: "Rx Review Reply",
    description:
      "Reply into a Co-Review thread; the reply appears live in the reviewer's window. Use when it adds " +
      "value — answering a reviewer's question or confirming you folded a comment — after a review " +
      "comment was delivered with its threadId. Keep it human and terse: 1–2 plain sentences, no " +
      "markdown structure; give detail only when the reviewer asks for more.",
    parameters: Type.Object({
      threadId: Type.String({ description: "Thread id from the delivered comment (or its short id, e.g. t2)." }),
      body: Type.String({ description: "Your reply — 1–2 plain sentences, human tone; shown in the reviewer's thread." }),
      ticket: Type.Optional(Type.String({ description: "Ticket id; defaults to the active review." })),
    }),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { threadId: string; body: string; ticket?: string };
      const dir = repoStateDir(ctx.cwd || process.cwd());
      if (!dir) return { content: [{ type: "text", text: "rx: not inside a git repo." }], isError: true };
      let ticket = params.ticket ?? reviewInfo?.ticket;
      if (!ticket) {
        const withReview = readStates(dir).filter((s) => s.review_id);
        if (withReview.length === 1) ticket = withReview[0].ticket;
      }
      if (!ticket)
        return { content: [{ type: "text", text: "rx: no open Co-Review review to reply to — start /rx-review first (or pass ticket)." }], isError: true };
      try {
        await postReviewReply(dir, ticket, params.threadId, params.body);
        return { content: [{ type: "text", text: `replied to ${params.threadId} (live in Co-Review)` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `rx: reply failed: ${(err as Error).message ?? err}` }], isError: true };
      }
    },
  });

  pi.registerCommand("rx-panel", {
    description: "Toggle the Rx phase panel",
    handler: async (_args: string, ctx: ExtensionContext) => {
      panelOn = !panelOn;
      ui = ctx;
      renderPanel(ctx);
      if (ctx.hasUI) ctx.ui.notify(`rx panel ${panelOn ? "on" : "off"}`, "info");
    },
  });
}

/** Smallest runnable check: state-machine + the guarded transition logic + cksum parity. */
export function demo() {
  const bad: string[] = [];
  // transition table sanity
  if (!TRANSITIONS["pr-open"].includes("awaiting-approval")) bad.push("rework loop missing");
  if (!TRANSITIONS["awaiting-approval"].includes("awaiting-approval")) bad.push("design-revise self-loop missing");
  if (!TRANSITIONS["pr-open"].includes("cleaned")) bad.push("pr-open→cleaned missing");
  if (TRANSITIONS["cleaned"].length !== 0) bad.push("cleaned must be terminal");
  for (const ph of PHASES) {
    if (TERMINAL[ph]) continue;
    if (!TRANSITIONS[ph].includes("aborted")) bad.push(`early-abort edge missing from ${ph}`);
  }
  if (TRANSITIONS["aborted"].length !== 0) bad.push("aborted must be terminal");
  if (isActive({ phase: "aborted" } as unknown as RxState)) bad.push("aborted must be inactive");

  // computeTransition — the load-bearing write logic
  const T0 = "2020-01-01T00:00:00Z";
  const gate = { ticket: "ENG-1", phase: "awaiting-approval", design_rev: 0, log: [] } as unknown as RxState;
  const rev = computeTransition(gate, "awaiting-approval", "revise", T0);
  if (!rev.ok || gate.phase !== "awaiting-approval" || gate.design_rev !== 1)
    bad.push("self-edge must bump design_rev and NOT move phase");
  const mv = computeTransition({ ticket: "ENG-1", phase: "pr-open", log: [] } as unknown as RxState, "cleaned", "done", T0);
  if (!mv.ok || mv.state?.phase !== "cleaned") bad.push("pr-open→cleaned must be allowed");
  const illegal = computeTransition({ ticket: "ENG-1", phase: "started", log: [] } as unknown as RxState, "cleaned", "x", T0);
  if (illegal.ok) bad.push("illegal jump must be refused");
  const ab = computeTransition({ ticket: "ENG-1", phase: "approved", log: [] } as unknown as RxState, "aborted", "abandon", T0);
  if (!ab.ok || ab.state?.phase !== "aborted") bad.push("approved→aborted (early abort) must be allowed");

  // /rx and /task argument classification
  {
    // Bundled ticket sources: Linear and GitHub recognised as before, free text falls through.
    const srcs = loadSources([path.join(PLUGIN_DIR, "sources")]);
    const id = (tok: string, cfg: RxConfig = {}) => resolveTicket(tok, srcs, cfg)?.id ?? "";
    const via = (tok: string, cfg: RxConfig = {}) => resolveTicket(tok, srcs, cfg)?.source.name ?? "";
    if (!["github", "gitlab", "jira", "linear", "text"].every((n) => srcs.some((x) => x.name === n))) bad.push(`bundled sources missing: ${srcs.map((x) => x.name)}`);
    // The config: a default ticketing system takes bare ids; a ticket shape narrows what counts as one.
    if (via("PROJ-7", { tickets: "jira" }) !== "jira" || id("proj-7", { tickets: "jira" }) !== "PROJ-7") bad.push("tickets: jira doesn't take bare keys");
    if (via("https://acme.atlassian.net/browse/PROJ-7") !== "jira") bad.push("Jira URL not recognized without config");
    if (via("https://linear.app/a/issue/ENG-1/x", { tickets: "jira" }) !== "linear") bad.push("Linear URL lost when Jira is the default");
    if (id("ENG-1", { ticket_shape: "^(PAY|OPS)-\\d+$" }) !== "" || id("pay-12", { ticket_shape: "^(PAY|OPS)-\\d+$" }) !== "PAY-12")
      bad.push("ticket_shape not applied");
    if (id("#123", { tickets: "gitlab", ticket_shape: "^#(?<id>\\d+)$" }) !== "gl-123") bad.push("gitlab default with #N shape wrong");
    if (id("#123") !== "gh-123") bad.push("#N no longer GitHub by default");
    if (id("ENG-1", { tickets: "nope" }) !== "") bad.push("unknown default source still claims bare ids");
    const conf = parseConfig("# team\ntickets: jira   # our tracker\nticket_shape: '^(PAY)-\\d+$'  # ids\nempty:\n");
    if (parseConfig("ticket_shape: ^#(?<id>\\d+)$").ticket_shape !== "^#(?<id>\\d+)$") bad.push("config # inside a value stripped");
    if (conf.tickets !== "jira" || conf.ticket_shape !== "^(PAY)-\\d+$" || "empty" in conf) bad.push(`config not parsed: ${JSON.stringify(conf)}`);
    // rx_config's writer: in-place replace keeps every other line, append, empty clears, refuse what won't round-trip.
    const cfgText = "# team\ntickets: linear\nticket_shape: ^#(?<id>\\d+)$  # gitlab\n";
    if (setConfigValue(cfgText, "tickets", "jira") !== "# team\ntickets: jira\nticket_shape: ^#(?<id>\\d+)$  # gitlab\n") bad.push("setConfigValue replace lost other lines");
    if (setConfigValue("# team", "tickets", "jira") !== "# team\ntickets: jira\n" || setConfigValue("", "tickets", "jira") !== "tickets: jira\n") bad.push("setConfigValue append wrong");
    if (setConfigValue(cfgText, "ticket_shape", "") !== "# team\ntickets: linear\n") bad.push("setConfigValue empty value didn't clear");
    if (parseConfig(setConfigValue("", "ticket_shape", "^#(?<id>\\d+)$") ?? "").ticket_shape !== "^#(?<id>\\d+)$") bad.push("gitlab shape doesn't round-trip");
    if (["jira\nticket_shape: x", "jira #x", "'jira'"].some((v) => setConfigValue(cfgText, "tickets", v) !== null)) bad.push("setConfigValue stored a value that won't read back");
    if (id("ENG-6182") !== "ENG-6182" || via("ENG-6182") !== "linear") bad.push("bare Linear id not recognized");
    if (id("eng-6182") !== "ENG-6182") bad.push("lowercase Linear id not uppercased");
    if (id("https://linear.app/acme/issue/ENG-6182/split-groups") !== "ENG-6182") bad.push("ticket not extracted from Linear URL");
    if (id("PROJ-99") !== "PROJ-99") bad.push("Jira-shaped id not recognized");
    if (id("gh-123") !== "gh-123" || via("gh-123") !== "github") bad.push("GitHub issue gh-123 not recognized");
    if (id("#456") !== "gh-456") bad.push("GitHub #456 not normalized");
    if (id("acme/web.app#12") !== "gh-12") bad.push("owner/repo#N not recognized");
    if (id("https://github.com/myorg/myrepo/issues/789") !== "gh-789") bad.push("ticket not extracted from GitHub URL");
    if (id("improve") !== "" || id("") !== "") bad.push("free text must not read as a ticket");
    const gh = srcs.find((x) => x.name === "github")!;
    const out = renderSource(gh, "gh-789", "https://github.com/myorg/myrepo/issues/789");
    if (!out.includes("**gh-789**") || !out.includes("myorg/myrepo/issues/789")) bad.push("github prompt not rendered");
    const lin = renderSource(srcs.find((x) => x.name === "linear")!, "ENG-6182", "eng-6182");
    if (!lin.includes("get_issue") || !lin.includes("**ENG-6182**")) bad.push("linear prompt not rendered");
    // A team source shadows a bundled one of the same name, and comes first.
    const team = parseSource("---\nname: linear\nmatch:\n  - ^([A-Z]+-\\d+)$\nid: $1\n---\nUse Jira for $ID.", "team/linear.md")!;
    if (!team || team.match.length !== 1 || team.body !== "Use Jira for $ID.") bad.push("source frontmatter not parsed");
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rx-src-"));
      fs.writeFileSync(path.join(tmp, "jira.md"), "---\nname: linear\nmatch:\n  - ^([A-Z]+-\\d+)$\n---\nUse Jira for $ID.");
      const layered = loadSources([tmp, path.join(PLUGIN_DIR, "sources")]);
      if (layered.filter((x) => x.name === "linear").length !== 1 || !renderSource(resolveTicket("ENG-1", layered, {})!.source, "ENG-1", "ENG-1").includes("Use Jira"))
        bad.push("a team source doesn't shadow the bundled one of the same name");
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (parseSource("no frontmatter", "x.md") !== null) bad.push("file without frontmatter accepted as a source");
    const bad1 = parseSource("---\nname: x\nmatch:\n  - ([\n---\nbody", "x.md");
    if (!bad1 || bad1.match.length !== 0) bad.push("invalid regex not skipped");
    if (matchSource("../../etc", [parseSource("---\nname: evil\nmatch:\n  - ^(.*)$\n---\nx", "e.md")!]) !== null) bad.push("source id escaped PIPELINE_ID");
  }
  if (slugId("improve logging and tracing") !== "improve-logging-tracing") bad.push(`ad-hoc slug wrong: ${slugId("improve logging and tracing")}`);
  if (slugId("Add retry to the webhook sender, please!") !== "add-retry-webhook-sender") bad.push("slug keeps filler or punctuation");
  if (slugId("the") !== "the" || slugId("!!!") !== "task") bad.push("slug of all-filler / no-word text wrong");
  if (!sameTask("add retry to the webhook sender", "Add retry to webhook sender")) bad.push("filler rewording reads as a new task");
  if (sameTask("add retry to the webhook sender", "add retry to the email sender")) bad.push("different tasks read as the same");
  if (!PIPELINE_ID.test(slugId("Add retry to the webhook sender"))) bad.push("PIPELINE_ID rejects a free-text id");
  if (PIPELINE_ID.test("Add-Retry")) bad.push("PIPELINE_ID accepts a mixed-case non-ticket slug");
  {
    // textTaskId: the same task reworded reuses its pipeline; a different task with the same slug,
    // a finished one, or a pending intake gets the next free suffix.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rx-demo-"));
    const st = (ticket: string, phase: Phase, requirement: string) =>
      writeState(statePath(tmp, ticket), { ticket, phase, requirement, log: [], updated_at: "" } as unknown as RxState);
    st("add-retry-webhook-sender", "awaiting-approval", "add retry to the webhook sender");
    const same = textTaskId(tmp, "Add retry to webhook sender");
    if (same.id !== "add-retry-webhook-sender" || !same.existing) bad.push(`reworded task not reused: ${JSON.stringify(same)}`);
    const diff = textTaskId(tmp, "add retry for webhook sender metrics");
    if (diff.id !== "add-retry-webhook-sender-2" || diff.existing) bad.push(`colliding slug not suffixed: ${JSON.stringify(diff)}`);
    st("fix-login", "cleaned", "fix login");
    if (textTaskId(tmp, "fix login").id !== "fix-login-2") bad.push("finished task's id reused");
    writeIntake(tmp, "speed-up-search", { source: "text", source_ref: "speed up search", requirement: "speed up search" });
    const resumed = textTaskId(tmp, "speed up the search");
    if (resumed.id !== "speed-up-search" || resumed.existing) bad.push(`interrupted start not resumed: ${JSON.stringify(resumed)}`);
    if (textTaskId(tmp, "speed up search page").id !== "speed-up-search-page") bad.push("unrelated slug disturbed");
    writeIntake(tmp, "cache-results", { source: "text", source_ref: "cache results", requirement: "cache results" });
    if (textTaskId(tmp, "cache results in redis").id !== "cache-results-redis") bad.push("longer text slug wrong");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!PIPELINE_ID.test("ENG-6182")) bad.push("PIPELINE_ID rejects a real ticket");
  if (!PIPELINE_ID.test("gh-123")) bad.push("PIPELINE_ID rejects a gh issue id");
  if (!PIPELINE_ID.test("task-improve-the-plugin")) bad.push("PIPELINE_ID rejects a task id");
  if (!PIPELINE_ID.test("flow-my-feature")) bad.push("PIPELINE_ID rejects a flow id");
  if (PIPELINE_ID.test("not a ticket")) bad.push("PIPELINE_ID accepts garbage");
  if (!PIPELINE_ID.test("acme/web.app#12")) bad.push("PIPELINE_ID rejects an owner/repo#N id");
  for (const t of ["../x#1", "a/..#2", "../../foo"]) if (PIPELINE_ID.test(t)) bad.push(`PIPELINE_ID accepts path traversal '${t}'`);

  // self-hosting fallback: no origin remote grounds/branches/delivers against local main, never a hard stop
  if (baseRef(true) !== "origin/main") bad.push("baseRef: origin present must target origin/main");
  if (baseRef(false) !== "main") bad.push("baseRef: no origin must fall back to local main");

  // cksum parity with the system binary (same input the repo key derives from)
  const sample = "/tmp/rx-demo";
  const sys = Number(execFileSync("bash", ["-c", `printf '%s' '${sample}' | cksum | cut -d' ' -f1`], { encoding: "utf8" }).trim());
  if (posixCksum(sample) !== sys) bad.push(`cksum mismatch: ${posixCksum(sample)} != ${sys}`);

  // session resume decision (canResumeSession)
  const boundState = { session_id: "A", session_file: "/x.jsonl" } as unknown as RxState;
  if (!canResumeSession(boundState, "B", true)) bad.push("resume: different session + existing file must resume");
  if (canResumeSession(boundState, "A", true)) bad.push("resume: same session must not resume");
  if (canResumeSession(boundState, "B", false)) bad.push("resume: missing session file must not resume");
  if (canResumeSession({} as RxState, "B", true)) bad.push("resume: unbound ticket must not resume");

  // rich anchor rendering (describeAnchor) — exact line + selected text reach the agent
  if (!describeAnchor({ type: "code-range", path: "a/b.ts", startLine: 10, endLine: 12, side: "new", exact: "x=1" }).includes("a/b.ts:10-12"))
    bad.push("anchor: code-range must carry file:startLine-endLine");
  if (!describeAnchor({ type: "code-line", path: "a/b.ts", line: 7, exact: "return x" }).includes("a/b.ts:7"))
    bad.push("anchor: code-line must carry file:line");
  if (!describeAnchor({ type: "text", exact: "some selected words" }).includes("some selected words"))
    bad.push("anchor: text must quote the selection");
  if (describeAnchor(undefined) !== "document") bad.push("anchor: undefined is the whole document");

  // locateAnchor — resolve a review anchor to a FRESH line range in the current pseudocode, ignoring
  // markdown markers, so a delivered comment edits that region in place (never re-reads the whole doc).
  const pdoc = "# Feature\n\n## Design\n- validate the row exists first\n  - then check the request shape\n\n## Open Questions\n- Q1 — x\n";
  const single = locateAnchor(pdoc, { type: "tree-node", exact: "then check the request shape" });
  if (!single || single.start !== 5 || single.end !== 5) bad.push("locateAnchor: tree-node must resolve its exact source line");
  const multi = locateAnchor(pdoc, { type: "text", exact: "validate the row exists first\nthen check the request shape" });
  if (!multi || multi.start !== 4 || multi.end !== 5) bad.push("locateAnchor: multi-line selection must span its source range");
  if (locateAnchor(pdoc, { type: "document" }) !== null) bad.push("locateAnchor: no selection → null (agent reads normally)");
  if (locateAnchor(pdoc, { type: "text", exact: "no such text anywhere here" }) !== null) bad.push("locateAnchor: unlocatable selection → null");

  // validatePseudocode — the render-contract gate for /rx-review
  const goodDoc = "# Feature: X\n\n## Context\np\n\n## Design\n- a\n  - b\n\n## Diagrams\n```mermaid\nflowchart TD\nA-->B\n```\n\n## Open Questions\n- Q1 — y\n";
  if (!validatePseudocode(goodDoc).ok) bad.push("pseudocode: conforming doc must pass");
  if (validatePseudocode("## Design\n- a\n").ok) bad.push("pseudocode: missing H1 must fail");
  if (!isPrpArtifactPath("PRPs/ENG-1.pseudocode.md")) bad.push("pseudocode: PRP path guard must catch retired PRP dirs");
  if (isPrpArtifactPath("/tmp/eng-1.pseudocode.md")) bad.push("pseudocode: non-PRP artifact path must pass");
  if (validatePseudocode("# X\n\n## Design\n- a\n\n## Open Questions\n- None.\n").ok) bad.push("pseudocode: missing Context must fail");
  if (validatePseudocode("# X\n## Context\np\n\n## Open Questions\n- None.\n").ok) bad.push("pseudocode: missing Design must fail");
  if (validatePseudocode("# X\n\n## Context\np\n\n## Design\nprose only\n\n## Open Questions\n- None.\n").ok)
    bad.push("pseudocode: Design without bullets must fail");
  if (validatePseudocode("# X\n\n## Context\np\n\n## Design\n- a\n").ok) bad.push("pseudocode: missing Open Questions must fail");
  if (validatePseudocode("# X\n## Goal\n- a\n## Flow charts\n```mermaid\nA-->B\n```\n").ok)
    bad.push("pseudocode: unrecognized sections (Goal/Flow charts) must fail");
  if (validatePseudocode("# X\n\n## Context\np\n\n## Design (notes)\n- a\n\n## Open Questions\n- None.\n").ok)
    bad.push("pseudocode: a parenthetical suffix on Design must fail (renderer drops it)");
  if (validatePseudocode("# X\n\n## Context\np\n\n## Design\n- a\n\n## Diagrams\nno fence here\n\n## Open Questions\n- None.\n").ok)
    bad.push("pseudocode: Diagrams without a mermaid fence must fail");

  // readStates: skip Co-Review state sidecars and any non-state json, so the panel never renders an
  // "rx undefined" row (regression: <ticket>.review.json was being read as a pipeline).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rx-states-"));
  try {
    fs.writeFileSync(path.join(tmp, "ENG-9.json"), JSON.stringify({ ticket: "ENG-9", phase: "pr-open", updated_at: T0 }));
    fs.writeFileSync(path.join(tmp, "ENG-9.review.json"), JSON.stringify({ doc: "", review: {}, seq: 0, threads: [] }));
    fs.writeFileSync(path.join(tmp, "junk.json"), JSON.stringify({ not: "a state" }));
    const states = readStates(tmp);
    if (states.length !== 1 || states[0].ticket !== "ENG-9")
      bad.push(`readStates must return only ticket states, got ${JSON.stringify(states.map((s) => s.ticket))}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // readReviewState — the rx side of the review-state file contract. The fixture mirrors what Co-Review
  // writes to open_review's storePath (doc / threads / seq / review.count, verified against Co-Review
  // 0.6.3). If Co-Review renames a field, update this fixture and reader.
  const revDir = fs.mkdtempSync(path.join(os.tmpdir(), "rx-review-"));
  try {
    fs.writeFileSync(
      path.join(revDir, "ENG-9.review.json"),
      JSON.stringify({
        doc: { slug: "ENG-9.pseudocode.md", title: "T", version: 1, markdown: "# T" },
        threads: [
          {
            id: "t1",
            target: "doc",
            anchor: { type: "document" },
            status: "open",
            severity: "medium",
            labels: [],
            messages: [
              { author: "you", role: "human", time: "12:00", body: "why X?" },
              { author: "agent", role: "agent", time: "12:01", body: "because Y" },
            ],
            proposal: null,
          },
        ],
        seq: 2,
        review: { decision: "request-changes", summary: "tighten X", submittedAt: "12:02", count: 1 },
      }),
    );
    const r = readReviewState(revDir, "ENG-9");
    if (r.round !== 1 || r.verdict !== "request-changes" || r.summary !== "tighten X")
      bad.push(`readReviewState: submit round parse broke: ${JSON.stringify(r)}`);
    if (r.openComments.length !== 1 || !r.openComments[0].includes("because Y"))
      bad.push(`readReviewState: open-thread rendering broke: ${JSON.stringify(r.openComments)}`);
  } finally {
    fs.rmSync(revDir, { recursive: true, force: true });
  }

  // reviewComments / reviewVerdict — mapping Co-Review's await_reviewer results onto delivered comments
  // and the gate. Agent messages and already-delivered keys are skipped; the anchor comes from the
  // state file's thread (matched by id or short id) so locateAnchor can find the selected text.
  const awaitThreads: CoReviewThread[] = [
    {
      threadId: "th-a",
      number: 1,
      location: { kind: "doc" },
      messages: [
        { author: "you", role: "human", body: "why X?" },
        { author: "agent", role: "agent", body: "because Y" },
        { author: "you", role: "human", body: "and Z?" },
      ],
    },
    { threadId: "th-b", number: 2, location: { kind: "code", path: "a.go", startLine: 3 }, messages: [{ role: "human", body: "nit" }] },
  ];
  const storeFixture: ReviewStore = { threads: [{ id: "t1", anchor: { type: "text", exact: "validate the row" } }] };
  const rc = reviewComments(awaitThreads, storeFixture, new Set(["th-a#0"]));
  if (rc.length !== 2 || rc[0].body !== "and Z?" || rc[0].keys.join() !== "th-a#2" || rc[0].anchor?.exact !== "validate the row")
    bad.push(`reviewComments: thread mapping broke: ${JSON.stringify(rc)}`);
  if (rc[1]?.anchor?.type !== "code-range" || rc[1].anchor.path !== "a.go" || rc[1].anchor.endLine !== 3)
    bad.push(`reviewComments: location fallback anchor broke: ${JSON.stringify(rc[1])}`);
  if (reviewComments(awaitThreads, null, new Set(["th-a#0", "th-a#2", "th-b#0"])).length !== 0)
    bad.push("reviewComments: delivered keys must not be re-delivered");
  if (reviewVerdict("approve") !== "approve" || reviewVerdict("request-changes") !== "revise" || reviewVerdict("comment") !== "comment")
    bad.push("reviewVerdict: decision mapping broke");

  // Watcher items (workflow/watch-items.jq + the driver's record subcommand) — regression: one numeric
  // cursor across GitHub id spaces hid review comments, and a cursor moved past threads left for the
  // human after a notify timeout. Status must come from GitHub thread/comment state, joined with the
  // durable ledger, so an owed item is never dropped.
  const watchStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "rx-watch-state-"));
  const watchArt = artifactsDir(watchStateDir, "ENG-9");
  try {
    const driverPath = writeWatchDriver(
      watchStateDir,
      "ENG-9",
      {
        ticket: "ENG-9",
        branch: "ENG-9",
        worktree: watchStateDir,
        phase: "pr-open",
        pseudocode: null,
        test_plan: null,
        pr_number: 9,
        herdr_workspace: "ws-1",
        created_at: T0,
        updated_at: T0,
        log: [],
      },
      watchStateDir,
    );
    const ledger = path.join(watchStateDir, "ENG-9.watch.jsonl");
    const drive = (...a: string[]): number => {
      try {
        execFileSync("bash", [driverPath, ...a], { stdio: "ignore" });
        return 0;
      } catch (e) {
        return e && typeof e === "object" && "status" in e && typeof e.status === "number" ? e.status : -1;
      }
    };
    if (drive("record", "t:1", "bogus") !== 2) bad.push("watch driver: record must reject an unknown action");
    if (drive("record", "t:6", "human", "asked, no answer") !== 0) bad.push("watch driver: record human failed");
    fs.appendFileSync(ledger, JSON.stringify({ at: "2026-01-01T00:00:01Z", key: "t:7", action: "human", note: "old" }) + "\n");
    const me = { login: "me" };
    const cop = { login: "copilot" };
    const th = (id: number, resolved: boolean, f: object, fAt: string, l: object, lAt: string, lBody = "x") => ({
      isResolved: resolved, path: "a.go", line: 1,
      head: { nodes: [{ databaseId: id, author: f, createdAt: fAt, url: "u", body: "q" }] },
      tail: { nodes: [{ author: l, createdAt: lAt, body: lBody }] },
    });
    const snap = { data: { repository: { pullRequest: {
      author: me,
      comments: { nodes: [
        { databaseId: 2, author: { __typename: "User", login: "rev" }, createdAt: "2026-01-01T00:00:03Z", url: "u", body: "early" },
        { databaseId: 9, author: { __typename: "User", login: "me" }, createdAt: "2026-01-01T00:00:05Z", url: "u", body: "status" },
        { databaseId: 10, author: { __typename: "Bot", login: "linear" }, createdAt: "2026-01-01T00:00:06Z", url: "u", body: "bot" },
        { databaseId: 11, author: { __typename: "User", login: "rev" }, createdAt: "2026-01-01T00:00:07Z", url: "u", body: "late" },
      ] },
      reviews: { nodes: [
        { databaseId: 20, author: { __typename: "User", login: "rev" }, submittedAt: "2026-01-01T00:00:08Z", url: "u", body: "" },
        { databaseId: 21, author: { __typename: "User", login: "rev" }, submittedAt: "2026-01-01T00:00:09Z", url: "u", body: "please fix" },
      ] },
      reviewThreads: { nodes: [
        th(1, true, cop, "2026-01-01T00:00:01Z", cop, "2026-01-01T00:00:01Z"),
        th(2, false, cop, "2026-01-01T00:00:01Z", cop, "2026-01-01T00:00:01Z"),
        th(3, false, cop, "2026-01-01T00:00:01Z", me, "2026-01-01T00:00:02Z"),
        th(4, false, me, "2026-01-01T00:00:01Z", me, "2026-01-01T00:00:01Z"),
        th(5, false, me, "2026-01-01T00:00:01Z", me, "2026-01-01T00:00:02Z", "done\n\n<!-- rx-watch -->"),
        th(6, false, cop, "2026-01-01T00:00:01Z", cop, "2026-01-01T00:00:01Z"),
        th(7, false, cop, "2026-01-01T00:00:01Z", cop, "2026-01-01T00:00:04Z"),
      ] },
    } } } };
    const snapPath = path.join(watchStateDir, "snap.json");
    fs.writeFileSync(snapPath, JSON.stringify(snap));
    const items = JSON.parse(
      execFileSync("jq", ["--slurpfile", "ledger", ledger, "-f", path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workflow", "watch-items.jq"), snapPath], { encoding: "utf8" }),
    ) as { key: string; status: string; fresh: boolean; nudge: boolean }[];
    const got = Object.fromEntries(items.map((i) => [i.key, `${i.status}${i.fresh ? "*" : ""}${i.nudge ? "!" : ""}`]));
    const want: Record<string, string> = {
      "t:1": "resolved", // resolved thread
      "t:2": "waiting*", // reviewer thread, no reply — owed
      "t:3": "replied", // author answered someone else's thread
      "t:4": "waiting*", // author's own instruction thread, no watcher reply
      "t:5": "replied", // marked watcher reply
      "t:6": "waiting!", // left for the human after the last comment — re-ask, not fresh
      "t:7": "waiting*", // reviewer spoke again after the human disposition — owed again
      "c:2": "replied", // same numeric id as thread 2, separate key; author spoke after it
      "c:11": "waiting*", // reviewer comment after the author's last word
      "r:21": "waiting*", // review body
    };
    const keys = Object.keys(want);
    if (Object.keys(got).length !== keys.length || keys.some((k) => got[k] !== want[k]))
      bad.push(`watch-items.jq: got ${JSON.stringify(got)}, want ${JSON.stringify(want)} (bot/author comments + empty reviews excluded)`);
  } finally {
    fs.rmSync(watchArt, { recursive: true, force: true });
    fs.rmSync(watchStateDir, { recursive: true, force: true });
  }
  // withSpaceLock — fail-closed cross-process mutex (regression: prior steal/reap logic could
  // delete a live winner's lock; see its doc). Shrunk deadline/poll for a fast, deterministic run.
  const lockOpts = { deadlineMs: 150, pollMs: 20 };
  const lockTmp = fs.mkdtempSync(path.join(os.tmpdir(), "rx-lock-"));
  try {
    const lockPath = path.join(lockTmp, ".TEST-1.space.lock");
    fs.writeFileSync(lockPath, "someone-else-token");
    let called = false;
    const held = withSpaceLock(lockTmp, "TEST-1", () => (called = true), lockOpts);
    if (held !== null) bad.push("withSpaceLock: held lock must fail closed (return null)");
    if (called) bad.push("withSpaceLock: fn must never run while the lock is held");
    if (fs.readFileSync(lockPath, "utf8") !== "someone-else-token")
      bad.push("withSpaceLock: a lock we don't hold must never be touched");
    fs.rmSync(lockPath);

    const ok = withSpaceLock(lockTmp, "TEST-1", () => "ok", lockOpts);
    if (ok !== "ok") bad.push("withSpaceLock: expected fn's return value on success");
    if (fs.existsSync(lockPath)) bad.push("withSpaceLock: successful holder must release the lock");

    let threw = "";
    try {
      withSpaceLock(
        lockTmp,
        "TEST-1",
        () => {
          throw new Error("boom");
        },
        lockOpts,
      );
    } catch (err) {
      threw = (err as Error).message;
    }
    if (threw !== "boom") bad.push("withSpaceLock: a thrown fn must propagate to the caller");
    if (fs.existsSync(lockPath)) bad.push("withSpaceLock: a thrown fn must still release the lock");

    const again = withSpaceLock(lockTmp, "TEST-1", () => "again", lockOpts);
    if (again !== "again") bad.push("withSpaceLock: a released lock must be re-acquirable");
  } finally {
    fs.rmSync(lockTmp, { recursive: true, force: true });
  }

  // withStateLock — serializes state RMW; releases on success/throw; breaks a stale (>10s) lock.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rx-statelock-"));
    const sp = path.join(tmp, "ENG-1.json");
    const lk = `${sp}.lock`;
    if (withStateLock(sp, () => (fs.existsSync(lk) ? "held" : "free")) !== "held") bad.push("withStateLock: lock must be held during fn");
    if (fs.existsSync(lk)) bad.push("withStateLock: lock must be released after fn");
    try {
      withStateLock(sp, () => {
        throw new Error("boom");
      });
    } catch {
      /* expected */
    }
    if (fs.existsSync(lk)) bad.push("withStateLock: lock must be released when fn throws");
    fs.writeFileSync(lk, "999999");
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lk, old, old);
    const t0 = Date.now();
    withStateLock(sp, () => undefined);
    if (Date.now() - t0 > 1000) bad.push("withStateLock: a stale lock must be broken immediately");
    if (fs.existsSync(lk)) bad.push("withStateLock: broken stale lock must end released");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (bad.length) throw new Error(bad.join("; "));
  console.log("pi-rx demo: OK");
}
