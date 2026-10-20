---
description: "Iterate on the Rx workflow itself: pick a backlog item (or $1 topic), implement it within the invariants, verify, and log it. Usage: /rx-improve [topic]"
---

Improve the **Rx workflow itself** (not a ticket). Source of truth: `$RX_PLUGIN/workflow/WORKFLOW.md`
— edit in place, nothing to sync.

1. **Orient**: read WORKFLOW.md in full (Invariants + open Backlog); grep `workflow/HISTORY.md` for
   past fixes in the area you're touching (don't read it whole). Target `$1` if given, else the
   highest-value unchecked backlog item; state the choice in one line. Needs a human decision or a
   resource you don't have → name the blocker and stop.
2. **Plan**: one short block — what changes, in which files (`stages/rx-*.md`, `src/index.ts`,
   skills), and which invariant each change respects. A faithful fix that breaks an invariant is a
   decision to raise, not to make.
3. **Implement** minimally in the pi-rx checkout (`$RX_PLUGIN`); keep diffs small; invariants hold (nothing in a
   target project tree, state only via `rx_*` tools, human gate + PR template intact).
4. **Verify** (no repo-wide harness — check only what you touched):
   - `src/index.ts`: `cd $RX_PLUGIN && npx tsc --noEmit --strict --target es2022 --module nodenext
     --moduleResolution nodenext --skipLibCheck src/index.ts`, then run `demo()` via bun → expect
     `pi-rx demo: OK`. Extend `demo()` when you add load-bearing logic.
   - pseudocode-design review-page script touched → from `$RX_PLUGIN`,
     `python3 -c "import ast; ast.parse(open('skills/pseudocode-design/scripts/render_html.py').read())"`.
5. **Record**: move the closed item (ticked, with its fix) from the WORKFLOW.md Backlog to
   `workflow/HISTORY.md`'s Closed list, and add ONE dated line to HISTORY's Learnings log (the durable
   insight). Commit only if asked (branch first if on `main`).
6. **Report**: what improved, invariants respected, verification result, next backlog item — or the
   specific blocker from step 1.
