# Pseudocode artifact structure (rx render contract)

The `.pseudocode.md` design artifact is reviewed live in [Co-Review](https://sdsvn.github.io/co-review/),
whose design-doc renderer recognizes **four `## ` sections** — Context, Design, Diagrams, Open
Questions (its `docs/design-docs.md` format). Anything outside them renders only as plain Markdown, not
as the reviewable design tree, so rx keeps the strict contract: any other heading, or a parenthetical
suffix (`## Design (notes)` ≠ `design`), is refused. `validatePseudocode()` (in `src/index.ts`) enforces this contract; `/rx-review` refuses
to host a non-conforming artifact, and the `rx_pseudocode_check` tool lets `/rx-start` self-verify
before the approval gate.

This is the machine-checkable half of `skill://pseudocode-design` — read the skill for the design
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
- **No unrecognized `## ` heading** — only `Context`, `Design`, `Diagrams`, `Open Questions` are shown
  (matched on the exact lowercased heading, so **no parenthetical suffix**). Fold every other section's
  content INLINE into the Design list as `✎`/`?`/`⚠` bullets — never a far-away `## Files` / `## RBAC` /
  `## Migration` section.
- **`## Diagrams`, if present, contains a ` ```mermaid ` block** — otherwise the section renders nothing.

## Why decisions go inline, not in their own sections

The renderer only shows the Design tree, the diagrams, the context blurb, and the open questions. A
new table, a permission constant, an error rule, a naming choice — each is a `✎`/`⚠` bullet at the
step that introduces it, so the reviewer sees and can challenge it in place. A separate
`## Data Model` / `## RBAC` section is invisible on the page and defeats the review.
