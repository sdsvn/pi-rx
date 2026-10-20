---
description: "Mine the Rx deviation log into workflow improvements: aggregate where runs went wrong, propose concrete prompt/rule fixes, update WORKFLOW.md. Usage: /rx-retro [ENG-1234]"
---

Turn the deviation log into workflow improvements (evidence → backlog; `/rx-improve` implements).

1. **Load**: `rx_deviations` (pass `ticket: $1` only when given). Zero deviations → say so, stop.
2. **Find patterns, not one-offs**: weight `source: auto` (human corrections) above `self`. Look for
   recurring (kind, phase, root-cause) clusters via each entry's `context` + `reasoning`; recurring
   `ignored-instruction` is the most serious. One deviation is noise.
3. **Propose the smallest fix per pattern** — a sharper guard in the failing `stages/rx-*.md` step,
   a WORKFLOW.md invariant/checklist item, or a tool-level gate. Tie each to its evidence
   (`N× kind at phase: root cause`). Respect the invariants. No fixes for one-off noise.
4. **Record**: add each well-evidenced fix to the WORKFLOW.md **Improvement backlog** (with counts)
   and ONE dated line to the **Learnings log** in `$RX_PLUGIN/workflow/HISTORY.md`. Edit both directly.
5. **Report**: entries reviewed, top patterns (counts + root cause), backlog items added. Offer to run
   `/rx-improve` on the highest-value one. Never erase the deviation log.
