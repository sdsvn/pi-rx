# Pseudocode artifact structure (rx render contract)

The `.pseudocode.md` design artifact is reviewed live in [Co-Review](https://sdsvn.github.io/co-review/)
when it's installed, else on the bundled HTML page. Co-Review's design-doc format (its `docs/design-docs.md`)
allows Context, Design, Alternatives, Behaviour, Diagrams and Open Questions, in that order, and shows any
other section as plain Markdown away from the step tree; the HTML page renders only Context, Design,
Diagrams and Open Questions. Rx keeps to those **four `## ` sections**, which both render: any other
heading, or a parenthetical suffix (`## Design (notes)` ≠ `design`), is refused. `validatePseudocode()`
(in `src/index.ts`) enforces this contract; `/rx-review` refuses to host a non-conforming artifact, and
the `rx_pseudocode_check` tool lets `/rx-start` self-verify before the approval gate.

`/rx-review` adds `co-review: design` frontmatter to the artifact (the HTML page ignores it), which makes
Co-Review run its own checks — section order, line references, pasted code, long steps — and return them
as format warnings in `rx_review_open`'s result for the agent to fix.

This is the machine-checkable half of the bundled `skills/pseudocode-design` skill — read the skill for the design
discipline (altitude ladder, ≤4 children per node, decisions inline, markers). This file is the
structural contract the tooling verifies.

## Required shape

```markdown
# Feature: <name>          ← one H1 title (or plain "# <name>")

## Context                 ← required short prose paragraph: the capability in domain terms
## Design                  ← required nested markdown list (`- ` bullets), L1 → L2, L3 only on risk branches
## Diagrams                ← optional; if present it must contain ```mermaid
## Open Questions          ← required; list every `?`, or `- None.` when all are resolved
```

## Hard rules the validator enforces (all must hold)

- **One H1 title** — a line starting `# ` with text.
- **`## Context` exists and isn't empty** — the review page needs the domain summary above the tree.
- **`## Design` exists and has `- ` bullets** — it is the altitude tree; without bullets it renders empty.
- **`## Open Questions` exists and isn't empty** — when nothing is open, say `- None.` rather than dropping the section.
- **No other `## ` heading** — only `Context`, `Design`, `Diagrams`, `Open Questions` (matched on the
  exact lowercased heading, so **no parenthetical suffix**). Fold every other section's content INLINE
  into the Design list as `✎`/`?`/`⚠` bullets — never a far-away `## Files` / `## RBAC` / `## Migration` section.
- **`## Diagrams`, if present, contains a ` ```mermaid ` block** — otherwise the section renders nothing.
- **Size limits** — `## Context` ≤300 chars; each Design bullet ≤120 chars; nesting ≤3 levels; ≤4
  children under any non-root node; total Design bullets ≤8, or 16 / 24 when the ticket's `size`
  (set via `rx_set`) is `medium` / `large`. Each failure names the offending line.

## Why decisions go inline, not in their own sections

The design is reviewed on its tree: comments, the L1/L2/L3 fold and approval all happen on the Design
list. A new table, a permission constant, an error rule, a naming choice — each is a `✎`/`⚠` bullet at
the step that introduces it, so the reviewer sees and can challenge it in place. A separate
`## Data Model` / `## RBAC` section is dropped by the HTML page and sits outside the tree in Co-Review,
away from the step it belongs to.
